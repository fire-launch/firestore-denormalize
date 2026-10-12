import { describe, expect, it } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore'
import { ReadCounter, SourceCache } from '../../src/index.js'

/** A fake Firestore whose `doc(path).get()` resolves to a snapshot stamped with the current fake clock. */
function fakeFirestore(clock: { now: number }) {
  const reads: string[] = []
  const firestore = {
    doc: (path: string) => ({
      get: async () => {
        reads.push(path)
        return { ref: { path }, exists: true, readTime: Timestamp.fromMillis(clock.now), data: () => ({ at: clock.now }) } as unknown as DocumentSnapshot
      },
    }),
  } as unknown as Firestore
  return { firestore, reads }
}

describe('SourceCache', () => {
  it('shares a read and counts only real reads', async () => {
    const clock = { now: 1000 }
    const { firestore, reads } = fakeFirestore(clock)
    const cache = new SourceCache(() => firestore)
    const counter = new ReadCounter()
    const a = await cache.get('user/u1', counter)
    const b = await cache.get('user/u1', counter)
    expect(b).toBe(a)
    expect(reads).toEqual(['user/u1'])
    expect(counter.counts().reads).toBe(1)
  })

  it('re-reads when the cached snapshot is older than the target it is combined with', async () => {
    const clock = { now: 1000 }
    const { firestore, reads } = fakeFirestore(clock)
    const cache = new SourceCache(() => firestore)
    const counter = new ReadCounter()
    await cache.get('user/u1', counter, Timestamp.fromMillis(900)) // read at 1000, fine for a target read at 900
    clock.now = 2000
    const fresh = await cache.get('user/u1', counter, Timestamp.fromMillis(1500)) // target read at 1500 > cached 1000
    expect(fresh.readTime.toMillis()).toBe(2000)
    expect(reads).toEqual(['user/u1', 'user/u1'])
    const again = await cache.get('user/u1', counter, Timestamp.fromMillis(1500))
    expect(again).toBe(fresh)
    expect(counter.counts().reads).toBe(2)
  })

  it('treats an equal readTime as recent enough and dedupes concurrent reads', async () => {
    const clock = { now: 1000 }
    const { firestore, reads } = fakeFirestore(clock)
    const cache = new SourceCache(() => firestore)
    const counter = new ReadCounter()
    const [a, b] = await Promise.all([cache.get('x/1', counter), cache.get('x/1', counter, Timestamp.fromMillis(1000))])
    expect(a).toBe(b)
    expect(reads).toEqual(['x/1'])
  })
})
