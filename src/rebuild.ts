/**
 * `rebuild`: walk every target of a rule and bring it in line with its current source.
 * Uses the same compute-and-conditionally-write code as the handler, so the result is
 * identical to what a live event would produce. Also powers `verify` (dry run).
 */
import type { Firestore } from 'firebase-admin/firestore'
import { type DocSyncConfig, type ResolvedConfig, type ResolvedRule, resolveConfig } from './config.js'
import { ReadCounter, type ReadCounts } from './counter.js'
import { type Outcome, Processor, targetPathForBase } from './handler.js'
import { jsonLogger, type Logger } from './logger.js'
import { matchDocumentPath } from './paths.js'
import { selectRules, walkCollection, walkTargets } from './walk.js'

export interface RebuildOptions {
  firestore: Firestore
  logger?: Logger
  /** Names of the rules to rebuild. Default: all. */
  rules?: string[]
  /** Documents per query page. Default 500. */
  pageSize?: number
  /** Targets processed in parallel within a page. Default 20. */
  concurrency?: number
  /** Report what would change without writing. */
  dryRun?: boolean
  /**
   * Resume after this document path (applies to the first rule processed). For a view with
   * `base`, this may be a base path (resumes pass 1, then runs pass 2 in full) or a target
   * path (skips pass 1, resumes pass 2); it need not still exist.
   */
  startAfter?: string
  maxRetries?: number
  /** Called after every page. */
  onProgress?: (progress: RebuildProgress) => void
  /** Stop at the next page boundary once this many milliseconds have passed; the result then has `completed: false`. */
  budgetMs?: number
}

export interface RebuildProgress extends ReadCounts {
  rule: string
  /** Documents inspected so far: targets, plus base documents for a view with `base`. */
  scanned: number
  /** Targets written (or that would be written with `dryRun`). */
  written: number
  /** Path of the last document processed (a base or a target path); pass it to `startAfter` to resume. */
  lastPath: string | undefined
}

export interface RebuildResult extends RebuildProgress {
  kind: ResolvedRule['kind']
  dryRun: boolean
  /** false when the budget stopped the walk before the end (pass `lastPath` to `startAfter` to continue). */
  completed: boolean
}

export async function rebuild(config: DocSyncConfig | ResolvedConfig, options: RebuildOptions): Promise<RebuildResult[]> {
  const resolved = resolveConfig(config)
  const logger = options.logger ?? jsonLogger
  const pageSize = options.pageSize ?? 500
  const concurrency = Math.max(1, options.concurrency ?? 20)
  const processor = new Processor(() => options.firestore, logger, options.maxRetries ?? 5, pageSize)

  const selected = selectRules(resolved, options.rules)
  const deadline = options.budgetMs !== undefined ? Date.now() + options.budgetMs : undefined
  const shouldStop = () => deadline !== undefined && Date.now() >= deadline

  const results: RebuildResult[] = []
  let startAfter = options.startAfter
  for (const rule of selected) {
    let written = 0
    let scanned = 0
    let lastPath: string | undefined
    const counter = new ReadCounter()
    const progress = (p: { scanned: number; lastPath: string }) =>
      options.onProgress?.({ rule: rule.name, scanned: scanned + p.scanned, written, lastPath: p.lastPath, ...counter.counts() })
    const report = (document: string, outcome: Outcome) => {
      if (outcome === 'skip') return
      written++
      if (options.dryRun) logger.info('doc-sync rebuild: would write', { rule: rule.name, document, action: outcome })
    }
    const baseView = rule.kind === 'view' && rule.basePattern ? rule : undefined
    const resumeInTargets = startAfter !== undefined && matchDocumentPath(rule.targetPattern, startAfter) !== undefined
    let completed = true

    // Pass 1 (views with `base`): every base document gets its target created or brought up to date.
    if (baseView?.basePattern && !resumeInTargets) {
      const walked = await walkCollection(
        options.firestore,
        baseView.basePattern,
        { pageSize, concurrency, startAfter, counter, shouldStop },
        async (baseDoc, page) => {
          const targetPath = targetPathForBase(baseView, baseDoc.ref.path)
          if (!targetPath) return
          report(targetPath, await processor.sync(options.firestore.doc(targetPath), rule, { sourceCache: page.sourceCache, dryRun: options.dryRun, counter }))
        },
        progress,
      )
      scanned += walked.scanned
      lastPath = walked.lastPath ?? lastPath
      startAfter = undefined
      if (walked.stopped) completed = false
    }

    // Pass 2: every existing target. For a base view only orphans are removed here (pass 1 synced the rest).
    if (completed) {
      const walked = await walkTargets(
        options.firestore,
        rule,
        { pageSize, concurrency, startAfter, counter, shouldStop },
        async (target, page) => {
          report(target.ref.path, await processor.sync(target.ref, rule, { target, sourceCache: page.sourceCache, dryRun: options.dryRun, counter, orphansOnly: baseView !== undefined }))
        },
        progress,
      )
      scanned += walked.scanned
      lastPath = walked.lastPath ?? lastPath
      startAfter = undefined
      if (walked.stopped) completed = false
    }
    results.push({ rule: rule.name, scanned, written, lastPath, kind: rule.kind, dryRun: Boolean(options.dryRun), completed, ...counter.counts() })
    if (!completed) break
  }
  return results
}
