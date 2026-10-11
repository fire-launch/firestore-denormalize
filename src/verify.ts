/**
 * `verify`: walk every target of a rule, recompute the derived value from its sources and
 * report each document whose value differs. With `fix`, mismatches are repaired with the same
 * conditional writes the handler uses. Views are always recomputed with `build`, never `patch`.
 */
import type { Firestore } from 'firebase-admin/firestore'
import { type DocSyncConfig, type ResolvedConfig, type ResolvedRule, resolveConfig } from './config.js'
import { ReadCounter, type ReadCounts } from './counter.js'
import { type CheckResult, Processor, targetPathForBase } from './handler.js'
import { jsonLogger, type Logger } from './logger.js'
import { matchDocumentPath } from './paths.js'
import { selectRules, walkCollection, walkTargets } from './walk.js'

export interface VerifyOptions {
  firestore: Firestore
  logger?: Logger
  /** Names of the rules to verify. Default: all. */
  rules?: string[]
  /** Documents per query page. Default 500. */
  pageSize?: number
  /** Targets checked in parallel within a page. Default 20. */
  concurrency?: number
  /** Repair mismatches (conditional writes, same as the handler). Default false. */
  fix?: boolean
  /**
   * Resume after this document path (applies to the first rule processed). For a view with
   * `base`, this may be a base path (resumes pass 1, then runs pass 2 in full) or a target
   * path (skips pass 1, resumes pass 2); it need not still exist.
   */
  startAfter?: string
  maxRetries?: number
  /** Called for every mismatch as soon as it is found (after the fix attempt when `fix` is set). */
  onMismatch?: (mismatch: Mismatch) => void
  /** Called after every page. */
  onProgress?: (progress: VerifyProgress) => void
}

export interface Mismatch {
  rule: string
  /** Target document path. */
  document: string
  /** `value`: a field differs. `missing`: the base exists but the target does not. `orphan`: the target exists but its base does not. */
  issue: 'value' | 'missing' | 'orphan'
  /** The differing field path (`value` only). */
  field?: string
  /** Current value of the field (`undefined` when absent). */
  actual?: unknown
  /** Value the field should hold (`undefined` when it should be absent). */
  expected?: unknown
  /** With `fix`: the value was repaired (or found already correct on re-read). Always false without `fix`. */
  fixed: boolean
}

export interface VerifyProgress extends ReadCounts {
  rule: string
  /** Documents inspected so far: targets, plus base documents for a view with `base`. */
  scanned: number
  /** Mismatches found so far: one per differing field, plus one per missing or orphan target. */
  mismatched: number
  /** Mismatches repaired (only with `fix`). */
  fixed: number
  /** Path of the last document processed (a base or a target path); pass it to `startAfter` to resume. */
  lastPath: string | undefined
}

export interface VerifyResult extends VerifyProgress {
  kind: ResolvedRule['kind']
  fix: boolean
  mismatches: Mismatch[]
}

export async function verify(config: DocSyncConfig | ResolvedConfig, options: VerifyOptions): Promise<VerifyResult[]> {
  const resolved = resolveConfig(config)
  const logger = options.logger ?? jsonLogger
  const pageSize = options.pageSize ?? 500
  const concurrency = Math.max(1, options.concurrency ?? 20)
  const fix = Boolean(options.fix)
  const processor = new Processor(() => options.firestore, logger, options.maxRetries ?? 5, pageSize)

  const selected = selectRules(resolved, options.rules)

  const results: VerifyResult[] = []
  let startAfter = options.startAfter
  for (const rule of selected) {
    let mismatched = 0
    let fixed = 0
    let scanned = 0
    let lastPath: string | undefined
    const mismatches: Mismatch[] = []
    let pending: Mismatch[] = []
    const counter = new ReadCounter()
    const baseView = rule.kind === 'view' && rule.basePattern ? rule : undefined
    const resumeInTargets = startAfter !== undefined && matchDocumentPath(rule.targetPattern, startAfter) !== undefined

    const record = (document: string, check: CheckResult, didFix: boolean) => {
      if (check.issue === 'missing' || check.issue === 'orphan') {
        pending.push({ rule: rule.name, document, issue: check.issue, fixed: didFix })
        return
      }
      for (const f of check.fields ?? []) {
        pending.push({ rule: rule.name, document, issue: 'value', field: f.field, actual: f.actual, expected: f.expected, fixed: didFix })
      }
    }
    const flush = (p: { scanned: number; lastPath: string }) => {
      pending.sort((a, b) => (a.document < b.document ? -1 : a.document > b.document ? 1 : 0))
      for (const m of pending) {
        mismatched++
        if (m.fixed) fixed++
        mismatches.push(m)
        // Values are not logged (they may hold personal data); they are in the returned `Mismatch` and in `onMismatch`.
        logger.info('doc-sync verify: mismatch', { rule: m.rule, document: m.document, issue: m.issue, field: m.field, fixed: m.fixed })
        options.onMismatch?.(m)
      }
      pending = []
      options.onProgress?.({ rule: rule.name, scanned: scanned + p.scanned, mismatched, fixed, lastPath: p.lastPath, ...counter.counts() })
    }

    // Pass 1 (views with `base`): a base without a target is `missing`; an existing target is checked field by field.
    if (baseView?.basePattern && !resumeInTargets) {
      const walked = await walkCollection(
        options.firestore,
        baseView.basePattern,
        { pageSize, concurrency, startAfter, counter },
        async (baseDoc, page) => {
          const targetPath = targetPathForBase(baseView, baseDoc.ref.path)
          if (!targetPath) return
          counter.doc()
          const target = await options.firestore.doc(targetPath).get()
          const check = await processor.check(target, rule, { base: baseDoc, sourceCache: page.sourceCache, counter })
          if (check.status !== 'mismatch') return
          let didFix = false
          if (fix) {
            await processor.sync(target.ref, rule, { target, base: baseDoc, sourceCache: page.sourceCache, counter })
            didFix = true
          }
          record(targetPath, check, didFix)
        },
        flush,
      )
      scanned += walked.scanned
      lastPath = walked.lastPath ?? lastPath
      startAfter = undefined
    }

    // Pass 2: every existing target. For a base view only orphans are reported here (pass 1 covered the values).
    const walked = await walkTargets(
      options.firestore,
      rule,
      { pageSize, concurrency, startAfter, counter },
      async (target, page) => {
        const check = await processor.check(target, rule, { sourceCache: page.sourceCache, counter, orphansOnly: baseView !== undefined })
        if (check.status !== 'mismatch') return
        let didFix = false
        if (fix) {
          // `sync` re-reads before writing; a skip means someone else corrected the value (or removed the target) meanwhile.
          await processor.sync(target.ref, rule, { target, sourceCache: page.sourceCache, counter, orphansOnly: baseView !== undefined })
          didFix = true
        }
        record(target.ref.path, check, didFix)
      },
      flush,
    )
    scanned += walked.scanned
    lastPath = walked.lastPath ?? lastPath
    startAfter = undefined
    results.push({ rule: rule.name, scanned, mismatched, fixed, lastPath, kind: rule.kind, fix, mismatches, ...counter.counts() })
  }
  return results
}
