/**
 * Paging loop shared by `rebuild` and `verify`: visits every document of a collection
 * pattern (a rule's target collection(s), or a view's base collection), in document-id
 * order, `concurrency` at a time within a page.
 */
import type { DocumentReference, DocumentSnapshot, Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { FieldPath } from 'firebase-admin/firestore'
import { type ResolvedConfig, type ResolvedRule, rulesOf } from './config.js'
import type { ReadCounter } from './counter.js'
import { type CollectionPattern, matchDocumentPath } from './paths.js'

export interface WalkOptions {
  /** Documents per query page. */
  pageSize: number
  /** Targets processed in parallel within a page. */
  concurrency: number
  /** Resume after this document path (a base or a target path; it need not still exist). */
  startAfter?: string
  /** Receives the page queries. */
  counter?: ReadCounter
}

/** Fresh per page: shares source reads between targets of the same page. */
export interface WalkPage {
  sourceCache: Map<string, Promise<DocumentSnapshot>>
}

/**
 * Visits every document of a collection pattern in document-id order, `concurrency` at a
 * time within a page. Returns the number of documents visited and the path of the last one
 * (pass it back as `startAfter` to resume). `startAfter` resumes by reference, not by
 * reading the cursor document first, so it still works when that document was since
 * deleted (e.g. an orphan target a previous pass removed).
 */
export async function walkCollection(
  firestore: Firestore,
  pattern: CollectionPattern,
  opts: WalkOptions,
  visit: (doc: QueryDocumentSnapshot, page: WalkPage) => Promise<void>,
  onPage?: (progress: { scanned: number; lastPath: string }) => void,
): Promise<{ scanned: number; lastPath: string | undefined }> {
  const { pageSize, concurrency } = opts
  const base = (pattern.params.length ? firestore.collectionGroup(pattern.collectionId) : firestore.collection(pattern.raw)).orderBy(FieldPath.documentId())
  if (opts.startAfter !== undefined && opts.startAfter.split('/').length % 2 !== 0) {
    throw new Error(`cannot resume: ${opts.startAfter} is not a document path`)
  }
  let cursor: DocumentSnapshot | DocumentReference | undefined = opts.startAfter ? firestore.doc(opts.startAfter) : undefined

  let scanned = 0
  let lastPath: string | undefined
  for (;;) {
    const page = await (cursor ? base.startAfter(cursor) : base).limit(pageSize).get()
    opts.counter?.query(page.size)
    if (page.empty) break
    const docs = page.docs.filter((d) => matchDocumentPath(pattern, d.ref.path))
    const sourceCache = new Map<string, Promise<DocumentSnapshot>>()

    await forEachLimit(docs, concurrency, (doc) => visit(doc, { sourceCache }))

    scanned += docs.length
    lastPath = page.docs[page.docs.length - 1]!.ref.path
    onPage?.({ scanned, lastPath })
    if (page.size < pageSize) break
    cursor = page.docs[page.docs.length - 1]
  }
  return { scanned, lastPath }
}

/** {@link walkCollection} over the rule's target collection(s). */
export function walkTargets(
  firestore: Firestore,
  rule: ResolvedRule,
  opts: WalkOptions,
  visit: (target: QueryDocumentSnapshot, page: WalkPage) => Promise<void>,
  onPage?: (progress: { scanned: number; lastPath: string }) => void,
): Promise<{ scanned: number; lastPath: string | undefined }> {
  return walkCollection(firestore, rule.targetPattern, opts, visit, onPage)
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
