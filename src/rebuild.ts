/**
 * `rebuild`: walk every target of a rule and bring it in line with its current source.
 * Uses the same compute-and-conditionally-write code as the handler, so the result is
 * identical to what a live event would produce. Also powers `verify` (dry run).
 */
import type { DocumentSnapshot, Firestore, Query } from 'firebase-admin/firestore'
import { type DocSyncConfig, type ResolvedRule, validateConfig } from './config.js'
import { Processor } from './handler.js'
import { jsonLogger, type Logger } from './logger.js'
import { matchDocumentPath } from './paths.js'

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

export interface RebuildProgress {
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

export async function rebuild(config: DocSyncConfig, options: RebuildOptions): Promise<RebuildResult[]> {
  const resolved = validateConfig(config)
  const logger = options.logger ?? jsonLogger
  const pageSize = options.pageSize ?? 500
  const concurrency = Math.max(1, options.concurrency ?? 20)
  const processor = new Processor(() => options.firestore, logger, options.maxRetries ?? 5, pageSize)

  const all: ResolvedRule[] = [...resolved.connections, ...resolved.aggregates]
  const selected = options.rules?.length ? all.filter((r) => options.rules!.includes(r.name)) : all
  if (options.rules?.length) {
    const unknown = options.rules.filter((n) => !all.some((r) => r.name === n))
    if (unknown.length) throw new Error(`unknown rule(s): ${unknown.join(', ')}`)
  }

  const results: RebuildResult[] = []
  let startAfter = options.startAfter
  for (const rule of selected) {
    const progress: RebuildProgress = { rule: rule.name, scanned: 0, written: 0, lastPath: undefined }
    const base = targetsQuery(options.firestore, rule)
    let cursor: DocumentSnapshot | undefined
    if (startAfter) {
      cursor = await options.firestore.doc(startAfter).get()
      if (!cursor.exists) throw new Error(`cannot resume: ${startAfter} does not exist`)
      startAfter = undefined
    }

    for (;;) {
      const page = await (cursor ? base.startAfter(cursor) : base).limit(pageSize).get()
      if (page.empty) break
      const docs = page.docs.filter((d) => matchDocumentPath(rule.targetPattern, d.ref.path))
      const sourceCache = new Map<string, Promise<DocumentSnapshot>>()

      await forEachLimit(docs, concurrency, async (target) => {
        const outcome =
          rule.kind === 'connection'
            ? await processor.syncCopy(target.ref, rule, {
                target,
                sourceCache,
                dryRun: options.dryRun,
                deleted: { onSourceDelete: rule.onSourceDelete },
              })
            : await processor.syncAggregate(target.ref, rule, { target, dryRun: options.dryRun })
        if (outcome !== 'skip') {
          progress.written++
          if (options.dryRun) logger.info('doc-sync rebuild: would write', { rule: rule.name, document: target.ref.path, action: outcome })
        }
      })

      progress.scanned += docs.length
      progress.lastPath = page.docs[page.docs.length - 1]!.ref.path
      options.onProgress?.({ ...progress })
      if (page.size < pageSize) break
      cursor = page.docs[page.docs.length - 1]
    }
    results.push({ ...progress, kind: rule.kind, dryRun: Boolean(options.dryRun) })
  }
  return results
}

/** All documents of the rule's target collection(s), in document-name order so paging is stable. */
function targetsQuery(firestore: Firestore, rule: ResolvedRule): Query {
  const p = rule.targetPattern
  return p.params.length ? firestore.collectionGroup(p.collectionId) : firestore.collection(p.raw)
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!
      await fn(item)
    }
  })
  await Promise.all(workers)
}
