/**
 * `rebuild`: walk every target of a rule and bring it in line with its current source.
 * Uses the same compute-and-conditionally-write code as the handler, so the result is
 * identical to what a live event would produce. Also powers `verify` (dry run).
 */
import type { Firestore } from 'firebase-admin/firestore'
import { type DocSyncConfig, type ResolvedConfig, type ResolvedRule, resolveConfig } from './config.js'
import { ReadCounter, type ReadCounts } from './counter.js'
import { Processor } from './handler.js'
import { jsonLogger, type Logger } from './logger.js'
import { selectRules, walkTargets } from './walk.js'

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
  /** Resume after this target document path (applies to the first rule processed). */
  startAfter?: string
  maxRetries?: number
  /** Called after every page. */
  onProgress?: (progress: RebuildProgress) => void
}

export interface RebuildProgress extends ReadCounts {
  rule: string
  /** Targets inspected so far. */
  scanned: number
  /** Targets written (or that would be written with `dryRun`). */
  written: number
  /** Path of the last target processed; pass it to `startAfter` to resume. */
  lastPath: string | undefined
}

export interface RebuildResult extends RebuildProgress {
  kind: ResolvedRule['kind']
  dryRun: boolean
}

export async function rebuild(config: DocSyncConfig | ResolvedConfig, options: RebuildOptions): Promise<RebuildResult[]> {
  const resolved = resolveConfig(config)
  const logger = options.logger ?? jsonLogger
  const pageSize = options.pageSize ?? 500
  const concurrency = Math.max(1, options.concurrency ?? 20)
  const processor = new Processor(() => options.firestore, logger, options.maxRetries ?? 5, pageSize)

  const selected = selectRules(resolved, options.rules)

  const results: RebuildResult[] = []
  let startAfter = options.startAfter
  for (const rule of selected) {
    let written = 0
    const counter = new ReadCounter()
    const { scanned, lastPath } = await walkTargets(
      options.firestore,
      rule,
      { pageSize, concurrency, startAfter, counter },
      async (target, page) => {
        const outcome = await processor.sync(target.ref, rule, { target, sourceCache: page.sourceCache, dryRun: options.dryRun, counter })
        if (outcome !== 'skip') {
          written++
          if (options.dryRun) logger.info('doc-sync rebuild: would write', { rule: rule.name, document: target.ref.path, action: outcome })
        }
      },
      (p) => options.onProgress?.({ rule: rule.name, scanned: p.scanned, written, lastPath: p.lastPath, ...counter.counts() }),
    )
    startAfter = undefined
    results.push({ rule: rule.name, scanned, written, lastPath, kind: rule.kind, dryRun: Boolean(options.dryRun), ...counter.counts() })
  }
  return results
}
