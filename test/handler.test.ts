import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FieldValue, type Firestore, Timestamp } from 'firebase-admin/firestore'
import { createDocSyncHandler, defineConfig, type DocSyncConfig } from '../src/index.js'
import { change, clearFirestore, encodeEvent, firestore, invoke, resourceName, silentLogger } from './helpers.js'

let db: Firestore

const config = defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'doc-sync-trigger',
  connections: [
    {
      name: 'post-category',
      source: 'category',
      target: 'post',
      idField: 'categoryId',
      fields: ['name', 'color'],
      targetField: 'category',
      onSourceDelete: 'setNull',
    },
    {
      name: 'post-author',
      source: 'user',
      target: 'post',
      idField: 'authorId',
      fields: ['name'],
      targetField: 'author',
      onSourceDelete: 'deleteField',
    },
    {
      name: 'post-tag',
      source: 'tag',
      target: 'post',
      idField: 'tagId',
      fields: ['label'],
      targetField: 'tag',
      onSourceDelete: 'nothing',
    },
  ],
})

function handlerFor(cfg: DocSyncConfig = config, opts: Parameters<typeof createDocSyncHandler>[1] = {}) {
  const logger = silentLogger()
  const handler = createDocSyncHandler(cfg, { firestore: db, logger, pageSize: 2, ...opts })
  return { handler, logs: logger.entries }
}

const processed = (logs: ReturnType<typeof silentLogger>['entries'], connection: string) =>
  logs.find((l) => l.message === 'doc-sync: processed' && l.fields?.connection === connection)?.fields

beforeAll(() => {
  db = firestore()
})

beforeEach(async () => {
  await clearFirestore()
})

describe('source events (5.2)', () => {
  it('writes the current source value into every target', async () => {
    const cat = db.doc('category/c1')
    await cat.set({ name: 'Old', color: 'red', secret: 'x' })
    for (let i = 0; i < 5; i++) await db.doc(`post/p${i}`).set({ categoryId: 'c1', title: `t${i}` })
    await db.doc('post/other').set({ categoryId: 'c2' })

    const { handler, logs } = handlerFor()
    const ev = await change(cat, () => cat.update({ name: 'New' }))
    expect(await invoke(handler, ev)).toBe(204)

    for (let i = 0; i < 5; i++) {
      expect((await db.doc(`post/p${i}`).get()).data()).toEqual({ categoryId: 'c1', title: `t${i}`, category: { name: 'New', color: 'red' } })
    }
    expect((await db.doc('post/other').get()).data()).toEqual({ categoryId: 'c2' })
    expect(processed(logs, 'post-category')).toMatchObject({ action: 'write', writes: 5, targets: 5, retries: 0 })
  })

  it('skips when none of the watched fields changed', async () => {
    const cat = db.doc('category/c1')
    await cat.set({ name: 'A', color: 'red', views: 1 })
    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1', category: { name: 'stale' } })

    const { handler, logs } = handlerFor()
    const ev = await change(cat, () => cat.update({ views: 2 }))
    expect(await invoke(handler, ev)).toBe(204)

    expect((await post.get()).get('category')).toEqual({ name: 'stale' })
    expect(processed(logs, 'post-category')).toMatchObject({ action: 'skip', reason: 'fields unchanged', targets: 0 })
  })

  it('does not write when targets are already up to date (no loops)', async () => {
    const cat = db.doc('category/c1')
    await cat.set({ name: 'A', color: 'red' })
    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1', category: { name: 'A', color: 'red' } })
    const updateTime = (await post.get()).updateTime

    const { handler, logs } = handlerFor()
    const ev = await change(cat, () => cat.update({ name: 'B' }))
    await cat.update({ name: 'A' }) // reverted before the event is processed
    expect(await invoke(handler, ev)).toBe(204)

    expect((await post.get()).updateTime!.isEqual(updateTime!)).toBe(true)
    expect(processed(logs, 'post-category')).toMatchObject({ action: 'skip', writes: 0, targets: 1 })
  })

  it('omits fields missing on the source', async () => {
    const cat = db.doc('category/c1')
    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1' })
    const { handler } = handlerFor()
    const ev = await change(cat, () => cat.set({ name: 'only-name' }))
    expect(await invoke(handler, ev)).toBe(204)
    expect((await post.get()).get('category')).toEqual({ name: 'only-name' })
  })

  it('handles source deletion per onSourceDelete', async () => {
    await db.doc('category/c1').set({ name: 'A' })
    await db.doc('user/u1').set({ name: 'U' })
    await db.doc('tag/t1').set({ label: 'L' })
    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1', authorId: 'u1', tagId: 't1', category: { name: 'A' }, author: { name: 'U' }, tag: { label: 'L' } })
    const { handler, logs } = handlerFor()

    for (const path of ['category/c1', 'user/u1', 'tag/t1']) {
      const ref = db.doc(path)
      const ev = await change(ref, () => ref.delete())
      expect(await invoke(handler, ev)).toBe(204)
    }

    const data = (await post.get()).data()
    expect(data).toEqual({ categoryId: 'c1', authorId: 'u1', tagId: 't1', category: null, tag: { label: 'L' } })
    expect(processed(logs, 'post-author')).toMatchObject({ action: 'delete', writes: 1 })
    expect(processed(logs, 'post-tag')).toMatchObject({ action: 'skip', reason: expect.stringContaining('nothing') })
  })

  it('re-populates targets when the source is recreated', async () => {
    const cat = db.doc('category/c1')
    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1', category: null })
    const { handler } = handlerFor()
    const ev = await change(cat, () => cat.set({ name: 'Back', color: 'blue' }))
    expect(await invoke(handler, ev)).toBe(204)
    expect((await post.get()).get('category')).toEqual({ name: 'Back', color: 'blue' })
  })

  it('a late (reordered) event never overwrites a newer value', async () => {
    const cat = db.doc('category/c1')
    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1' })
    await cat.set({ name: 'v0' })
    const { handler } = handlerFor()

    const first = await change(cat, () => cat.update({ name: 'v1' }))
    const second = await change(cat, () => cat.update({ name: 'v2' }))

    expect(await invoke(handler, second)).toBe(204)
    expect((await post.get()).get('category')).toEqual({ name: 'v2' })
    expect(await invoke(handler, first)).toBe(204) // delivered late
    expect((await post.get()).get('category')).toEqual({ name: 'v2' })
    expect(await invoke(handler, second)).toBe(204) // delivered twice
    expect((await post.get()).get('category')).toEqual({ name: 'v2' })
  })

  it('pages through many targets', async () => {
    const cat = db.doc('category/c1')
    await cat.set({ name: 'A' })
    const batch = db.batch()
    for (let i = 0; i < 7; i++) batch.set(db.doc(`post/p${i}`), { categoryId: 'c1' })
    await batch.commit()
    const { handler, logs } = handlerFor(config, { pageSize: 3 })
    const ev = await change(cat, () => cat.update({ name: 'B' }))
    expect(await invoke(handler, ev)).toBe(204)
    expect(processed(logs, 'post-category')).toMatchObject({ writes: 7, targets: 7 })
    const posts = await db.collection('post').get()
    expect(posts.docs.every((d) => d.get('category.name') === 'B')).toBe(true)
  })

  it('keeps Timestamp / nested values comparable', async () => {
    const cat = db.doc('category/c1')
    const ts = new Timestamp(1700000000, 5000)
    await cat.set({ name: { ja: '名前', en: 'Name' }, color: ts })
    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1', category: { name: { ja: '名前', en: 'Name' }, color: ts } })
    const updateTime = (await post.get()).updateTime
    const { handler, logs } = handlerFor()
    const ev = await change(cat, () => cat.update({ 'name.en': 'Name' })) // no-op update, same values
    expect(await invoke(handler, ev)).toBe(204)
    expect(processed(logs, 'post-category')).toMatchObject({ action: 'skip', reason: 'fields unchanged' })
    expect((await post.get()).updateTime!.isEqual(updateTime!)).toBe(true)
  })
})

describe('target events (5.3)', () => {
  it('populates a newly created target', async () => {
    await db.doc('category/c1').set({ name: 'A', color: 'red' })
    const post = db.doc('post/p1')
    const { handler, logs } = handlerFor()
    const ev = await change(post, () => post.set({ categoryId: 'c1', title: 'x' }))
    expect(await invoke(handler, ev)).toBe(204)
    expect((await post.get()).data()).toEqual({ categoryId: 'c1', title: 'x', category: { name: 'A', color: 'red' } })
    expect(processed(logs, 'post-category')).toMatchObject({ role: 'target', action: 'write', writes: 1 })
    expect(processed(logs, 'post-author')).toMatchObject({ role: 'target', action: 'skip' })
  })

  it('fills several targetFields on one create without racing itself', async () => {
    await db.doc('category/c1').set({ name: 'A' })
    await db.doc('user/u1').set({ name: 'U' })
    await db.doc('tag/t1').set({ label: 'L' })
    const post = db.doc('post/p1')
    const { handler, logs } = handlerFor()
    const ev = await change(post, () => post.set({ categoryId: 'c1', authorId: 'u1', tagId: 't1' }))
    expect(await invoke(handler, ev)).toBe(204)
    expect((await post.get()).data()).toEqual({
      categoryId: 'c1',
      authorId: 'u1',
      tagId: 't1',
      category: { name: 'A' },
      author: { name: 'U' },
      tag: { label: 'L' },
    })
    for (const c of ['post-category', 'post-author', 'post-tag']) {
      expect(processed(logs, c)).toMatchObject({ action: 'write', writes: 1, retries: 0 })
    }
  })

  it('re-points when idField changes, and skips when it does not', async () => {
    await db.doc('category/c1').set({ name: 'A' })
    await db.doc('category/c2').set({ name: 'B' })
    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1', category: { name: 'A' } })
    const { handler, logs } = handlerFor()

    const same = await change(post, () => post.update({ title: 'edited' }))
    expect(await invoke(handler, same)).toBe(204)
    expect(processed(logs, 'post-category')).toMatchObject({ action: 'skip', reason: 'idField unchanged' })

    const moved = await change(post, () => post.update({ categoryId: 'c2' }))
    expect(await invoke(handler, moved)).toBe(204)
    expect((await post.get()).get('category')).toEqual({ name: 'B' })
  })

  it('removes targetField when idField is removed or emptied', async () => {
    await db.doc('category/c1').set({ name: 'A' })
    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1', category: { name: 'A' } })
    const { handler, logs } = handlerFor()

    const ev = await change(post, () => post.update({ categoryId: FieldValue.delete() }))
    expect(await invoke(handler, ev)).toBe(204)
    expect((await post.get()).data()).toEqual({})
    expect(processed(logs, 'post-category')).toMatchObject({ action: 'delete' })

    await post.set({ categoryId: 'c1', category: { name: 'A' } })
    const ev2 = await change(post, () => post.update({ categoryId: '' }))
    expect(await invoke(handler, ev2)).toBe(204)
    expect((await post.get()).data()).toEqual({ categoryId: '' })
  })

  it('leaves targetField alone when the new source does not exist', async () => {
    await db.doc('category/c1').set({ name: 'A' })
    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1', category: { name: 'A' } })
    const { handler } = handlerFor()
    const ev = await change(post, () => post.update({ categoryId: 'missing' }))
    expect(await invoke(handler, ev)).toBe(204)
    expect((await post.get()).get('category')).toEqual({ name: 'A' })
  })

  it('ignores target deletion', async () => {
    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1' })
    const { handler, logs } = handlerFor()
    const ev = await change(post, () => post.delete())
    expect(await invoke(handler, ev)).toBe(204)
    expect(processed(logs, 'post-category')).toMatchObject({ action: 'skip', reason: 'target deleted' })
  })

  it('uses the current idField even if the event is stale', async () => {
    await db.doc('category/c1').set({ name: 'A' })
    await db.doc('category/c2').set({ name: 'B' })
    const post = db.doc('post/p1')
    const { handler } = handlerFor()
    const first = await change(post, () => post.set({ categoryId: 'c1' }))
    await post.update({ categoryId: 'c2' })
    expect(await invoke(handler, first)).toBe(204)
    expect((await post.get()).get('category')).toEqual({ name: 'B' })
  })
})

describe('precondition failures (5.4)', () => {
  /**
   * Firestore proxy that runs `hook` right before the handler reads the source document,
   * i.e. after the targets were read and before they are written, so the precondition fails.
   */
  function racyFirestore(hook: () => Promise<unknown>, { always = false } = {}) {
    let fired = false
    const maybeHook = async () => {
      if (fired && !always) return
      fired = true
      await hook()
    }
    const bindAll = <T extends object>(obj: T, overrides: Record<PropertyKey, unknown>) =>
      new Proxy(obj, {
        get(t, p, r) {
          if (p in overrides) return overrides[p]
          const v = Reflect.get(t, p, r)
          return typeof v === 'function' ? v.bind(t) : v
        },
      })
    return bindAll(db, {
      collection: (name: string) => {
        const coll = db.collection(name)
        if (name !== 'category') return coll
        return bindAll(coll, {
          doc: (id: string) => {
            const ref = coll.doc(id)
            return bindAll(ref, { get: async () => (await maybeHook(), ref.get()) })
          },
        })
      },
    }) as Firestore
  }

  it('redoes the target and converges', async () => {
    const cat = db.doc('category/c1')
    const post = db.doc('post/p1')
    await cat.set({ name: 'A' })
    await post.set({ categoryId: 'c1' })
    const racy = racyFirestore(() => post.update({ title: 'changed concurrently' }))
    const { handler, logs } = handlerFor(config, { firestore: racy })

    const ev = await change(cat, () => cat.update({ name: 'B' }))
    expect(await invoke(handler, ev)).toBe(204)
    expect((await post.get()).data()).toEqual({ categoryId: 'c1', title: 'changed concurrently', category: { name: 'B' } })
    expect(processed(logs, 'post-category')).toMatchObject({ action: 'write', writes: 1, retries: 1 })
  })

  it('picks up a concurrent idField change during the redo', async () => {
    const cat = db.doc('category/c1')
    const post = db.doc('post/p1')
    await cat.set({ name: 'A' })
    await db.doc('category/c2').set({ name: 'Z' })
    await post.set({ categoryId: 'c1' })
    const racy = racyFirestore(() => post.update({ categoryId: 'c2' }))
    const { handler } = handlerFor(config, { firestore: racy })
    const ev = await change(cat, () => cat.update({ name: 'B' }))
    expect(await invoke(handler, ev)).toBe(204)
    expect((await post.get()).get('category')).toEqual({ name: 'Z' })
  })

  it('does not apply onSourceDelete when the redo finds the target pointing elsewhere', async () => {
    const cat = db.doc('category/c1')
    const post = db.doc('post/p1')
    await cat.set({ name: 'A' })
    await post.set({ categoryId: 'c1', category: { name: 'A' } })
    // While the delete is processed, the app re-points the post at a source that does not exist (yet).
    const racy = racyFirestore(() => post.update({ categoryId: 'not-yet-created' }))
    const { handler, logs } = handlerFor(config, { firestore: racy })
    const ev = await change(cat, () => cat.delete())
    expect(await invoke(handler, ev)).toBe(204)
    expect((await post.get()).get('category')).toEqual({ name: 'A' })
    expect(processed(logs, 'post-category')).toMatchObject({ retries: 1, writes: 0 })
  })

  it('returns 500 when retries are exhausted', async () => {
    const cat = db.doc('category/c1')
    const post = db.doc('post/p1')
    await cat.set({ name: 'A' })
    await post.set({ categoryId: 'c1' })
    const racy = racyFirestore(() => post.update({ n: FieldValue.increment(1) }), { always: true })
    const { handler, logs } = handlerFor(config, { firestore: racy, maxRetries: 2 })
    const ev = await change(cat, () => cat.update({ name: 'B' }))
    expect(await invoke(handler, ev)).toBe(500)
    expect(processed(logs, 'post-category')).toBeUndefined()
    expect((await post.get()).get('category')).toBeUndefined()
    expect(logs.some((l) => l.level === 'error' && String((l.fields?.error as Error)?.name) === 'RetriesExhaustedError')).toBe(true)
  })
})

describe('chains (5.5)', () => {
  const chain = defineConfig({
    ...config,
    connections: [
      { name: 'shop-area', source: 'area', target: 'shop', idField: 'areaId', fields: ['name'], targetField: 'area', onSourceDelete: 'setNull' },
      { name: 'post-shop', source: 'shop', target: 'post', idField: 'shopId', fields: ['name', 'area'], targetField: 'shop', onSourceDelete: 'setNull' },
    ],
  })

  it('propagates area -> shop.area -> post.shop.area and then stops', async () => {
    const area = db.doc('area/a1')
    const shop = db.doc('shop/s1')
    const post = db.doc('post/p1')
    await area.set({ name: 'Tokyo' })
    await shop.set({ areaId: 'a1', name: 'Shop', area: { name: 'Tokyo' } })
    await post.set({ shopId: 's1', shop: { name: 'Shop', area: { name: 'Tokyo' } } })
    const { handler, logs } = handlerFor(chain)

    const ev1 = await change(area, () => area.update({ name: 'Osaka' }))
    const shopBefore = await shop.get()
    expect(await invoke(handler, ev1)).toBe(204)
    const shopAfter = await shop.get()
    expect(shopAfter.get('area')).toEqual({ name: 'Osaka' })

    // Eventarc now delivers the shop write our handler made.
    expect(await invoke(handler, { before: shopBefore, after: shopAfter })).toBe(204)
    expect((await post.get()).get('shop')).toEqual({ name: 'Shop', area: { name: 'Osaka' } })

    // ...and the post write. post is not a source of anything, so nothing happens.
    const postSnap = await post.get()
    expect(await invoke(handler, { before: postSnap, after: postSnap })).toBe(204)
    expect(processed(logs, 'post-shop')).toBeDefined()
  })
})

describe('request handling (5.1 / 6)', () => {
  it('ignores events for another database', async () => {
    const cat = db.doc('category/c1')
    await db.doc('post/p1').set({ categoryId: 'c1' })
    const { handler, logs } = handlerFor()
    const ev = await change(cat, () => cat.set({ name: 'A' }))
    expect(await invoke(handler, { ...ev, database: 'other' })).toBe(204)
    expect((await db.doc('post/p1').get()).get('category')).toBeUndefined()
    expect(logs.some((l) => l.message.includes('another database'))).toBe(true)
  })

  it('drops undecodable payloads with 204 and an error log', async () => {
    const { handler, logs } = handlerFor()
    expect(await invoke(handler, { document: 'category/c1', body: Buffer.from([0xff, 0xfe]) })).toBe(204)
    expect(logs.some((l) => l.level === 'error' && l.message.includes('decode'))).toBe(true)
  })

  it('ignores unknown collections and subcollections', async () => {
    const ref = db.doc('unrelated/x')
    const { handler, logs } = handlerFor()
    const ev = await change(ref, () => ref.set({ a: 1 }))
    expect(await invoke(handler, ev)).toBe(204)
    expect(await invoke(handler, { ...ev, document: 'category/c1/sub/d1' })).toBe(204)
    expect(logs.filter((l) => l.level === 'warn')).toHaveLength(2)
  })

  it('derives the document path from the payload when ce-document is missing', async () => {
    const cat = db.doc('category/c1')
    await cat.set({ name: 'A' })
    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1' })
    const { handler } = handlerFor()
    const ev = await change(cat, () => cat.update({ name: 'B' }))
    expect(await invoke(handler, { ...ev, document: null })).toBe(204)
    expect((await post.get()).get('category')).toEqual({ name: 'B' })
  })

  it('accepts application/json payloads', async () => {
    await db.doc('category/c1').set({ name: 'A' })
    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1' })
    const { handler } = handlerFor()
    const body = {
      value: { name: resourceName('post/p1'), fields: { categoryId: { stringValue: 'c1' } }, updateTime: '2024-01-01T00:00:00Z' },
      updateMask: { fieldPaths: [] },
    }
    expect(await invoke(handler, { document: 'post/p1', body, contentType: 'application/json' })).toBe(204)
    expect((await post.get()).get('category')).toEqual({ name: 'A' })
  })

  it('reads the body from a stream when neither rawBody nor body is set', async () => {
    const cat = db.doc('category/c1')
    await cat.set({ name: 'A' })
    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1' })
    const { handler } = handlerFor()
    const ev = await change(cat, () => cat.update({ name: 'B' }))
    const buf = encodeEvent(ev.before, ev.after)
    const req = {
      headers: { 'content-type': 'application/protobuf', 'ce-document': 'category/c1', 'ce-database': '(default)' },
      async *[Symbol.asyncIterator]() {
        yield buf.subarray(0, 10)
        yield buf.subarray(10)
      },
    }
    let code = 0
    await handler(req, { end() {}, set statusCode(c: number) { code = c }, get statusCode() { return code } })
    expect(code).toBe(204)
    expect((await post.get()).get('category')).toEqual({ name: 'B' })
  })

  it('returns 500 (not 204) when the failure is not a decode error', async () => {
    const { handler, logs } = handlerFor()
    const req = {
      headers: { 'content-type': 'application/protobuf', 'ce-document': 'category/c1' },
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new Error('socket hang up')
      },
    }
    let status = 0
    await handler(req, { status: (c: number) => ({ send: () => (status = c) }) })
    expect(status).toBe(500)
    expect(logs.some((l) => l.level === 'error' && l.message.includes('retried'))).toBe(true)
  })

  it('works with an express-style res.status().send() and a plain res', async () => {
    const { handler } = handlerFor()
    let status = 0
    await handler({ headers: {} }, { status: (c: number) => ({ send: () => (status = c) }) })
    expect(status).toBe(204)
  })
})
