import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Firestore } from 'firebase-admin/firestore'
import { defineConfig, verify, type Mismatch } from '../src/index.js'
import { clearFirestore, firestore, silentLogger } from './helpers.js'

let db: Firestore

const config = defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'doc-sync-trigger',
  connections: [
    { name: 'post-category', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull' },
    { name: 'post-author', source: 'user', target: 'post', idField: 'authorId', fields: ['name'], targetField: 'author', onSourceDelete: 'nothing' },
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

describe('verify', () => {
  it('reports every mismatch with the actual and the expected value, without writing', async () => {
    await db.doc('category/c1').set({ name: 'A', postCount: 1 })
    await db.doc('post/ok').set({ categoryId: 'c1', category: { name: 'A' } })
    await db.doc('post/stale').set({ categoryId: 'c1', category: { name: 'old' } })
    await db.doc('post/missing').set({ categoryId: 'c1' })
    await db.doc('post/orphan').set({ categoryId: 'gone', category: { name: 'x' } })
    await db.doc('post/unlinked').set({ category: { name: 'x' } })
    await db.doc('post/none').set({ title: 'no category' })

    const seen: Mismatch[] = []
    const logger = silentLogger()
    const results = await verify(config, { firestore: db, logger, pageSize: 3, rules: ['post-category', 'category-posts'], onMismatch: (m) => seen.push(m) })

    expect(results.map((r) => [r.rule, r.kind, r.scanned, r.mismatched, r.fixed, r.fix])).toEqual([
      ['post-category', 'connection', 6, 4, 0, false],
      ['category-posts', 'aggregate', 1, 1, 0, false],
    ])
    expect(results[0]!.mismatches).toEqual([
      { rule: 'post-category', document: 'post/missing', field: 'category', actual: undefined, expected: { name: 'A' }, fixed: false },
      { rule: 'post-category', document: 'post/orphan', field: 'category', actual: { name: 'x' }, expected: null, fixed: false },
      { rule: 'post-category', document: 'post/stale', field: 'category', actual: { name: 'old' }, expected: { name: 'A' }, fixed: false },
      { rule: 'post-category', document: 'post/unlinked', field: 'category', actual: { name: 'x' }, expected: undefined, fixed: false },
    ])
    expect(results[1]!.mismatches).toEqual([
      { rule: 'category-posts', document: 'category/c1', field: 'postCount', actual: 1, expected: 3, fixed: false },
    ])
    expect(seen).toEqual([...results[0]!.mismatches, ...results[1]!.mismatches])
    expect(results[0]!.lastPath).toBe('post/unlinked')
    // pages of 3 + 3 posts plus a final empty page (still one billed read); c1 / gone read once per page a post points at them
    expect(results[0]).toMatchObject({ reads: 6 + 1 + 3, queries: 3, aggregations: 0 })
    expect(results[1]).toMatchObject({ reads: 1, queries: 1, aggregations: 1 })

    // nothing was written
    expect((await db.doc('post/stale').get()).get('category')).toEqual({ name: 'old' })
    expect((await db.doc('category/c1').get()).get('postCount')).toBe(1)
  })

  it('fixes mismatches with the same conditional writes as the handler', async () => {
    await db.doc('category/c1').set({ name: 'A', postCount: 0 })
    await db.doc('post/stale').set({ categoryId: 'c1', category: { name: 'old' } })
    await db.doc('post/unlinked').set({ category: { name: 'x' } })

    const results = await verify(config, { firestore: db, logger: silentLogger(), fix: true, rules: ['post-category', 'category-posts'] })
    expect(results.map((r) => [r.rule, r.mismatched, r.fixed, r.fix])).toEqual([
      ['post-category', 2, 2, true],
      ['category-posts', 1, 1, true],
    ])
    expect(results[0]!.mismatches.every((m) => m.fixed)).toBe(true)
    expect((await db.doc('post/stale').get()).get('category')).toEqual({ name: 'A' })
    expect((await db.doc('post/unlinked').get()).data()).toEqual({})
    expect((await db.doc('category/c1').get()).get('postCount')).toBe(1)

    const again = await verify(config, { firestore: db, logger: silentLogger(), rules: ['post-category', 'category-posts'] })
    expect(again.map((r) => r.mismatched)).toEqual([0, 0])
  })

  it('leaves a target alone when its source is missing and onSourceDelete is nothing', async () => {
    await db.doc('post/p1').set({ authorId: 'gone', author: { name: 'x' } })
    const results = await verify(config, { firestore: db, logger: silentLogger(), rules: ['post-author'] })
    expect(results[0]).toMatchObject({ scanned: 1, mismatched: 0 })
  })

  it('walks nested targets with a collection group and resumes from startAfter', async () => {
    await db.doc('users/u1/tags/t1').set({ label: 'L1' })
    await db.doc('users/u1/posts/p1').set({ tagId: 't1' })
    await db.doc('users/u1/posts/p2').set({ tagId: 't1', tag: { label: 'L1' } })
    await db.doc('users/u2/posts/p1').set({ tagId: 't1', tag: { label: 'x' } })
    await db.doc('shops/s1/posts/p1').set({ tagId: 't1' })

    const results = await verify(config, { firestore: db, logger: silentLogger(), rules: ['user-post-tag'] })
    expect(results[0]).toMatchObject({ scanned: 3, mismatched: 2 })
    expect(results[0]!.mismatches.map((m) => [m.document, m.expected])).toEqual([
      ['users/u1/posts/p1', { label: 'L1' }],
      ['users/u2/posts/p1', undefined],
    ])

    const pages: string[] = []
    const resumed = await verify(config, {
      firestore: db,
      logger: silentLogger(),
      rules: ['user-post-tag'],
      pageSize: 1,
      startAfter: 'users/u1/posts/p1',
      onProgress: (p) => pages.push(p.lastPath!),
    })
    expect(resumed[0]).toMatchObject({ scanned: 2, mismatched: 1 })
    expect(pages).toEqual(['users/u1/posts/p2', 'users/u2/posts/p1'])
  })

  it('rejects unknown rule names', async () => {
    await expect(verify(config, { firestore: db, rules: ['nope'] })).rejects.toThrow(/unknown rule/)
  })
})
