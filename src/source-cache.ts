/**
 * Shares single-document reads within one unit of work (an event, a rebuild page) without
 * ever combining a source read with a target read that happened later: a cached snapshot is
 * reused only when its `readTime` is at or after `notBefore`.
 */
import type { DocumentSnapshot, Firestore, Timestamp } from 'firebase-admin/firestore'
import type { ReadCounter } from './counter.js'

function notOlderThan(readTime: Timestamp, notBefore: Timestamp): boolean {
  return readTime.seconds > notBefore.seconds || (readTime.seconds === notBefore.seconds && readTime.nanoseconds >= notBefore.nanoseconds)
}

export class SourceCache {
  private readonly entries = new Map<string, Promise<DocumentSnapshot>>()

  constructor(private readonly firestore: () => Firestore) {}

  /** Snapshot of `path` read no earlier than `notBefore`; shares an earlier read when it is recent enough. Counts a read only when it reads. */
  async get(path: string, counter: ReadCounter, notBefore?: Timestamp): Promise<DocumentSnapshot> {
    const cached = this.entries.get(path)
    if (cached) {
      const snap = await cached
      if (!notBefore || notOlderThan(snap.readTime, notBefore)) return snap
    }
    counter.doc()
    const read = this.firestore().doc(path).get()
    this.entries.set(path, read)
    return read
  }
}
