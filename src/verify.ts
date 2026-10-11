/**
 * `verify`: walk every target of a rule, recompute the derived value from its sources and
 * report each document whose value differs. With `fix`, mismatches are repaired with the same
 * conditional writes the handler uses. Views are always recomputed with `build`, never `patch`.
 */
import type { Firestore } from 'firebase-admin/firestore'
import { type DocSyncConfig, type ResolvedConfig, type ResolvedRule, resolveConfig } from './config.js'
import { ReadCounter, type ReadCounts } from './counter.js'
import { Processor } from './handler.js'
import { jsonLogger, type Logger } from './logger.js'
import { selectRules, walkTargets } from './walk.js'

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
  /** Resume after this target document path (applies to the first rule processed). */
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
  /** The rule's `targetField`. */
  field: string
  /** Current value of the field (`undefined` when absent). */
  actual: unknown
  /** Value the field should hold (`undefined` when it should be absent). */
  expected: unknown
  /** With `fix`: the value was repaired (or found already correct on re-read). Always false without `fix`. */
  fixed: boolean
}

export interface VerifyProgress extends ReadCounts {
  rule: string
  /** Targets inspected so far. */
  scanned: number
  /** Targets whose value differed. */
  mismatched: number
  /** Mismatches repaired (only with `fix`). */
  fixed: number
  /** Path of the last target processed; pass it to `startAfter` to resume. */
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
    const mismatches: Mismatch[] = []
    let pending: Mismatch[] = []
    const counter = new ReadCounter()

    const { scanned, lastPath } = await walkTargets(
      options.firestore,
      rule,
      { pageSize, concurrency, startAfter, counter },
      async (target, page) => {
        const check = await processor.check(target, rule, { sourceCache: page.sourceCache, counter })
        if (check.status !== 'mismatch') return
        let didFix = false
        if (fix) {
          // `sync` re-reads before writing; a skip means someone else corrected the value (or removed the target) meanwhile.
          await processor.sync(target.ref, rule, { target, sourceCache: page.sourceCache, counter })
          didFix = true
        }
        pending.push({
          rule: rule.name,
          document: target.ref.path,
          field: rule.targetField,
          actual: check.actual,
          expected: check.expected,
          fixed: didFix,
        })
      },
      (p) => {
        pending.sort((a, b) => (a.document < b.document ? -1 : a.document > b.document ? 1 : 0))
        for (const m of pending) {
          mismatched++
          if (m.fixed) fixed++
          mismatches.push(m)
          // Values are not logged (they may hold personal data); they are in the returned `Mismatch` and in `onMismatch`.
          logger.info('doc-sync verify: mismatch', { rule: m.rule, document: m.document, field: m.field, fixed: m.fixed })
          options.onMismatch?.(m)
        }
        pending = []
        options.onProgress?.({ rule: rule.name, scanned: p.scanned, mismatched, fixed, lastPath: p.lastPath, ...counter.counts() })
      },
    )
    startAfter = undefined
    results.push({ rule: rule.name, scanned, mismatched, fixed, lastPath, kind: rule.kind, fix, mismatches, ...counter.counts() })
  }
  return results
}
