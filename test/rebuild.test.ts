import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Firestore } from 'firebase-admin/firestore'
import { defineConfig, rebuild } from '../src/index.js'
import { clearFirestore, firestore, silentLogger } from './helpers.js'

let db: Firestore

const config = defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'doc-sync-trigger',
  connections: [
    { name: 'post-category', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull' },
    { name: 'user-post-tag', source: 'users/{uid}/tags', target: 'users/{uid}/posts', idField: 'tagId', fields: ['label'], targetField: 'tag', onSourceDelete: 'deleteField' },
  ],
  aggregates: [{ name: 'category-posts', source: 'post', target: 'category', idField: 'categoryId', aggregate: 'count', targetField: 'postCount' }],
})

beforeAll(() => {
  db = firestore()
})
beforeEach(async () => {
  await clearFirestore()
})

describe('rebuild', () => {
  it('backfills copies and counts, applying onSourceDelete to missing sources', async () => {
    await db.doc('category/c1').set({ name: 'A' })
    const batch = db.batch()
    for (let i = 0; i < 12; i++) batch.set(db.doc(`post/p${i}`), { categoryId: 'c1', category: i % 2 ? { name: 'stale' } : { name: 'A' } })
    batch.set(db.doc('post/orphan'), { categoryId: 'gone', category: { name: 'old' } })
    batch.set(db.doc('post/none'), { title: 'no category' })
    await batch.commit()

    const logger = silentLogger()
    const results = await rebuild(config, { firestore: db, logger, pageSize: 5, rules: ['post-category', 'category-posts'] })

    expect(results.map((r) => [r.rule, r.scanned, r.written])).toEqual([
      ['post-category', 14, 7], // 6 stale + orphan -> null
      ['category-posts', 1, 1],
    ])
    expect((await db.doc('post/p1').get()).get('category')).toEqual({ name: 'A' })
    expect((await db.doc('post/orphan').get()).get('category')).toBeNull()
    expect((await db.doc('post/none').get()).data()).toEqual({ title: 'no category' })
    expect((await db.doc('category/c1').get()).get('postCount')).toBe(12)
  })

  it('walks nested targets with a collection group and keeps other parents apart', async () => {
    await db.doc('users/u1/tags/t1').set({ label: 'L1' })
    await db.doc('users/u2/tags/t1').set({ label: 'L2' })
    await db.doc('users/u1/posts/p1').set({ tagId: 't1' })
    await db.doc('users/u2/posts/p1').set({ tagId: 't1' })
    await db.doc('shops/s1/posts/p1').set({ tagId: 't1' })
    const results = await rebuild(config, { firestore: db, logger: silentLogger(), rules: ['user-post-tag'] })
    expect(results[0]).toMatchObject({ scanned: 2, written: 2 })
    expect((await db.doc('users/u1/posts/p1').get()).get('tag')).toEqual({ label: 'L1' })
    expect((await db.doc('users/u2/posts/p1').get()).get('tag')).toEqual({ label: 'L2' })
    expect((await db.doc('shops/s1/posts/p1').get()).get('tag')).toBeUndefined()
  })

  it('dry run reports without writing, and resumes from --start-after', async () => {
    await db.doc('category/c1').set({ name: 'A' })
    for (let i = 0; i < 6; i++) await db.doc(`post/p${i}`).set({ categoryId: 'c1' })

    const logger = silentLogger()
    const dry = await rebuild(config, { firestore: db, logger, dryRun: true, rules: ['post-category'] })
    expect(dry[0]).toMatchObject({ scanned: 6, written: 6, dryRun: true })
    expect(logger.entries.filter((l) => l.message.includes('would write'))).toHaveLength(6)
    expect((await db.doc('post/p0').get()).get('category')).toBeUndefined()

    const pages: string[] = []
    const resumed = await rebuild(config, {
      firestore: db,
      logger: silentLogger(),
      rules: ['post-category'],
      pageSize: 2,
      startAfter: 'post/p2',
      onProgress: (p) => pages.push(p.lastPath!),
    })
    expect(resumed[0]).toMatchObject({ scanned: 3, written: 3 })
    expect(pages).toEqual(['post/p4', 'post/p5'])
    expect((await db.doc('post/p2').get()).get('category')).toBeUndefined()
    expect((await db.doc('post/p3').get()).get('category')).toEqual({ name: 'A' })
  })

  it('rejects unknown rule names', async () => {
    await expect(rebuild(config, { firestore: db, rules: ['nope'] })).rejects.toThrow(/unknown rule/)
  })
})
