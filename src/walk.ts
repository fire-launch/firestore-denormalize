/**
 * Paging loop shared by `rebuild` and `verify`: visits every target document of a rule's
 * target collection(s), in document-name order, `concurrency` at a time within a page.
 */
import type { DocumentSnapshot, Firestore, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { type ResolvedConfig, type ResolvedRule, rulesOf } from './config.js'
import type { ReadCounter } from './counter.js'
import { matchDocumentPath } from './paths.js'

export interface WalkOptions {
  /** Documents per query page. */
  pageSize: number
  /** Targets processed in parallel within a page. */
  concurrency: number
  /** Resume after this target document path. */
  startAfter?: string
  /** Receives the page queries (and the `startAfter` lookup). */
  counter?: ReadCounter
}

/** Fresh per page: shares source reads between targets of the same page. */
export interface WalkPage {
  sourceCache: Map<string, Promise<DocumentSnapshot>>
}

/**
 * Visits every document of the rule's target collection(s) in document-name order,
 * `concurrency` at a time within a page. Returns the number of documents visited and
 * the path of the last one (pass it back as `startAfter` to resume).
 */
export async function walkTargets(
  firestore: Firestore,
  rule: ResolvedRule,
  opts: WalkOptions,
  visit: (target: QueryDocumentSnapshot, page: WalkPage) => Promise<void>,
  onPage?: (progress: { scanned: number; lastPath: string }) => void,
): Promise<{ scanned: number; lastPath: string | undefined }> {
  const { pageSize, concurrency } = opts
  const base = targetsQuery(firestore, rule)
  let cursor: DocumentSnapshot | undefined
  if (opts.startAfter) {
    opts.counter?.doc()
    cursor = await firestore.doc(opts.startAfter).get()
    if (!cursor.exists) throw new Error(`cannot resume: ${opts.startAfter} does not exist`)
  }

  let scanned = 0
  let lastPath: string | undefined
  for (;;) {
    const page = await (cursor ? base.startAfter(cursor) : base).limit(pageSize).get()
    opts.counter?.query(page.size)
    if (page.empty) break
    const docs = page.docs.filter((d) => matchDocumentPath(rule.targetPattern, d.ref.path))
    const sourceCache = new Map<string, Promise<DocumentSnapshot>>()

    await forEachLimit(docs, concurrency, (target) => visit(target, { sourceCache }))

    scanned += docs.length
    lastPath = page.docs[page.docs.length - 1]!.ref.path
    onPage?.({ scanned, lastPath })
    if (page.size < pageSize) break
    cursor = page.docs[page.docs.length - 1]
  }
  return { scanned, lastPath }
}

/** All documents of the rule's target collection(s), in document-name order so paging is stable. */
function targetsQuery(firestore: Firestore, rule: ResolvedRule): Query {
  const p = rule.targetPattern
  return p.params.length ? firestore.collectionGroup(p.collectionId) : firestore.collection(p.raw)
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/** The rules named by `names`, or every rule when `names` is empty/undefined. Throws for unknown names. */
export function selectRules(resolved: ResolvedConfig, names?: string[]): ResolvedRule[] {
  const all = rulesOf(resolved)
  if (!names?.length) return all
  const unknown = names.filter((n) => !all.some((r) => r.name === n))
  if (unknown.length) throw new Error(`unknown rule(s): ${unknown.join(', ')}`)
  return all.filter((r) => names.includes(r.name))
}
