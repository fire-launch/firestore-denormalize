import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Firestore } from 'firebase-admin/firestore'
import { createDocSyncHandler, defineAggregate, defineConfig, defineConnection, defineProjection, defineView, type ContinuationTask } from '../src/index.js'
import { change, clearFirestore, firestore, invoke, invokeRaw, silentLogger } from './helpers.js'

let db: Firestore
const host = 'docsync-abc-an.a.run.app'

const category = defineConnection({ name: 'post-category', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull', defer: '10m' })
const likes = defineAggregate({ name: 'post-likes', source: 'post/{postId}/like', target: 'post', idParam: 'postId', aggregate: 'count', targetField: 'likeCount', defer: '10m' })
const pub = defineProjection({ name: 'post-public', base: 'post', target: 'postPublic', targetFields: ['title'], defer: '10m' })
const config = defineConfig({ name: 'doc-sync', region: 'asia-northeast1', service: 'docsync', serviceAccount: 'doc-sync-trigger', rules: [category, likes, pub] })

function handlerFor(rules = config.rules, enqueue?: (t: ContinuationTask) => Promise<void>) {
  const logger = silentLogger()
  const tasks: ContinuationTask[] = []
  const handler = createDocSyncHandler({ ...config, rules }, { firestore: db, logger, pageSize: 2, schedule: { enqueue: enqueue ?? (async (t) => { tasks.push(t) }) } })
  return { handler, logs: logger.entries, tasks }
}
const processed = (logs: ReturnType<typeof silentLogger>['entries'], rule: string) => logs.findLast((l) => l.message === 'doc-sync: processed' && l.fields?.rule === rule)?.fields
const flush = (handler: ReturnType<typeof createDocSyncHandler>, task: ContinuationTask) => invokeRaw(handler, { url: task.url.replace(`https://${host}`, ''), headers: { host }, body: task.body })

beforeAll(() => { db = firestore() })
beforeEach(async () => { await clearFirestore() })

describe('defer: events mark, tasks flush', () => {
  it('a connection source change enqueues one source unit and writes nothing until the flush', async () => {
    await db.doc('category/c1').set({ name: 'News' })
    await db.doc('post/p1').set({ title: 'a', categoryId: 'c1' })
    await db.doc('post/p2').set({ title: 'b', categoryId: 'c1' })
    const { handler, logs, tasks } = handlerFor()
    const cat = db.doc('category/c1')
    expect(await invoke(handler, { ...(await change(cat, () => cat.update({ name: 'Tech' }))), headers: { host } })).toBe(204)
    expect((await db.doc('post/p1').get()).get('category')).toBeUndefined()
    expect(processed(logs, 'post-category')).toMatchObject({ action: 'defer', deferred: 1, writes: 0 })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ rule: 'post-category', url: `https://${host}/schedule/post-category`, body: { flush: { unit: 'source', path: 'category/c1' } }, queue: { name: 'doc-sync-schedule' } })
    expect(tasks[0]!.id).toMatch(/^post-category-d\d+-[0-9a-f]{16}$/)
    expect(tasks[0]!.scheduleTime).toMatch(/^\d{4}-/)
    // a second change in the same bucket collapses onto the same task id
    await invoke(handler, { ...(await change(cat, () => cat.update({ name: 'Tech2' }))), headers: { host } })
    expect(tasks[1]!.id).toBe(tasks[0]!.id)

    const { status, body } = await flush(handler, tasks[0]!)
    expect(status).toBe(200)
    expect(JSON.parse(body!)).toMatchObject({ rule: 'post-category', flush: { unit: 'source', path: 'category/c1' }, writes: 2 })
    expect((await db.doc('post/p1').get()).get('category')).toEqual({ name: 'Tech2' })
  })

  it('enqueues nothing when the copied fields did not change', async () => {
    await db.doc('category/c1').set({ name: 'News', slug: 'news' })
    const { handler, tasks, logs } = handlerFor()
    const cat = db.doc('category/c1')
    await invoke(handler, { ...(await change(cat, () => cat.update({ slug: 'n' }))), headers: { host } })
    expect(tasks).toEqual([])
    expect(processed(logs, 'post-category')).toMatchObject({ action: 'skip', reason: 'fields unchanged' })
  })

  it('an aggregate source change enqueues the target unit; the flush recomputes it', async () => {
    await db.doc('post/p1').set({ title: 'a' })
    const { handler, tasks } = handlerFor()
    const like = db.doc('post/p1/like/u1')
    await invoke(handler, { ...(await change(like, () => like.set({}))), headers: { host } })
    expect(tasks[0]!.body).toEqual({ flush: { unit: 'target', path: 'post/p1' } })
    expect((await db.doc('post/p1').get()).get('likeCount')).toBeUndefined()
    await flush(handler, tasks[0]!)
    expect((await db.doc('post/p1').get()).get('likeCount')).toBe(1)
  })

  it('keeps lifecycle immediate for a deferred projection and defers base updates', async () => {
    const { handler, tasks } = handlerFor()
    const post = db.doc('post/p1')
    await invoke(handler, { ...(await change(post, () => post.set({ title: 'a' }))), headers: { host } })
    expect((await db.doc('postPublic/p1').get()).data()).toEqual({ title: 'a' }) // created immediately
    expect(tasks).toEqual([])
    await invoke(handler, { ...(await change(post, () => post.update({ title: 'b' }))), headers: { host } })
    expect((await db.doc('postPublic/p1').get()).get('title')).toBe('a') // update deferred
    expect(tasks[0]!.body).toEqual({ flush: { unit: 'target', path: 'postPublic/p1' } })
    await flush(handler, tasks[0]!)
    expect((await db.doc('postPublic/p1').get()).get('title')).toBe('b')
    await invoke(handler, { ...(await change(post, () => post.delete())), headers: { host } })
    expect((await db.doc('postPublic/p1').get()).exists).toBe(false) // removed immediately
  })

  it('answers 500 when the unit cannot be enqueued, so Eventarc retries', async () => {
    await db.doc('category/c1').set({ name: 'News' })
    const { handler } = handlerFor(config.rules, async () => { throw new Error('tasks down') })
    const cat = db.doc('category/c1')
    expect(await invoke(handler, { ...(await change(cat, () => cat.update({ name: 'Tech' }))), headers: { host } })).toBe(500)
  })

  it('rejects flush bodies that do not fit the rule', async () => {
    const { handler } = handlerFor()
    expect((await invokeRaw(handler, { url: '/schedule/post-category', headers: { host } })).status).toBe(400)
    expect((await invokeRaw(handler, { url: '/schedule/post-likes', headers: { host }, body: { flush: { unit: 'source', path: 'post/p1/like/u1' } } })).status).toBe(400)
    expect((await invokeRaw(handler, { url: '/schedule/nope', headers: { host }, body: { flush: { unit: 'target', path: 'post/p1' } } })).status).toBe(404)
  })
})
