/**
 * Runtime read counters. The handler counts the reads it issues itself; the `firestore`
 * handed to a view's `build` / `patch` is wrapped so reads made there are counted too.
 * Counts follow Firestore billing: a document read is 1, a query costs 1 per document
 * returned (at least 1), an aggregation is counted separately (billed per 1000 index entries).
 */
import { DocumentReference, type Firestore, Query } from 'firebase-admin/firestore'

export interface ReadCounts {
  /** Billable document reads (document gets, plus one per document a query returned, at least one per query). */
  reads: number
  /** Queries run. */
  queries: number
  /** Aggregation queries run (`count()` / `sum()`). */
  aggregations: number
}

export class ReadCounter implements ReadCounts {
  reads = 0
  queries = 0
  aggregations = 0

  /** One document read (a missing document is billed too). */
  doc(n = 1): void {
    this.reads += n
  }
  /** One query that returned `size` documents. */
  query(size: number): void {
    this.queries++
    this.reads += Math.max(1, size)
  }
  aggregation(): void {
    this.aggregations++
  }
  add(other: ReadCounts): void {
    this.reads += other.reads
    this.queries += other.queries
    this.aggregations += other.aggregations
  }
  counts(): ReadCounts {
    return { reads: this.reads, queries: this.queries, aggregations: this.aggregations }
  }
}

type Kind = 'firestore' | 'doc' | 'query' | 'aggregate'

/**
 * A `Firestore` whose document gets, queries, aggregations and `getAll` are counted into
 * `counter`. References and queries derived from it (`doc()`, `where()`, `count()`, ...) are
 * counted as well. Writes, transactions, `onSnapshot` and references taken from snapshots
 * (`snapshot.ref`) are passed through uncounted.
 */
export function countingFirestore(db: Firestore, counter: ReadCounter): Firestore {
  const wrap = <T extends object>(obj: T, kind: Kind): T =>
    new Proxy(obj, {
      get(target, prop) {
        const v = Reflect.get(target, prop)
        if (typeof v !== 'function') return v
        return (...args: unknown[]) => {
          const result = (v as (...a: unknown[]) => unknown).apply(target, args)
          return track(target, kind, prop, args, result)
        }
      },
    })

  const track = (target: object, kind: Kind, prop: PropertyKey, args: unknown[], result: unknown): unknown => {
    if (prop === 'get' && result instanceof Promise) {
      if (kind === 'doc') counter.doc()
      else if (kind === 'aggregate') counter.aggregation()
      else if (kind === 'query') return result.then((snap: { size: number }) => (counter.query(snap.size), snap))
      return result
    }
    if (prop === 'getAll' && kind === 'firestore' && result instanceof Promise) {
      counter.doc(args.filter((a) => a instanceof DocumentReference).length)
      return result
    }
    if (kind === 'query' && (prop === 'count' || prop === 'aggregate') && result !== null && typeof result === 'object') {
      return wrap(result, 'aggregate')
    }
    if (result instanceof DocumentReference) return wrap(result, 'doc')
    if (result instanceof Query) return wrap(result, 'query')
    void target
    return result
  }

  return wrap(db, 'firestore')
}
