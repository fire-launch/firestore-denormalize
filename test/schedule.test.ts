import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Firestore } from 'firebase-admin/firestore'
import { createDocSyncHandler, defineAggregate, defineConfig, defineConnection, defineView, scheduledRuleFromUrl, type ContinuationTask } from '../src/index.js'
import { change, clearFirestore, firestore, invoke, invokeRaw, silentLogger } from './helpers.js'

let db: Firestore

const likes = defineAggregate({
  name: 'daily-likes',
  source: 'post/{postId}/like',
  target: 'post',
  idParam: 'postId',
  aggregate: 'count',
  targetField: 'likeCount',
  schedule: '0 3 * * *',
})
const category = defineConnection({ name: 'post-category', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull' })
const config = defineConfig({ name: 'doc-sync', region: 'asia-northeast1', service: 'docsync', serviceAccount: 'doc-sync-trigger', rules: [likes, category] })

function handlerFor(opts: Parameters<typeof createDocSyncHandler>[1] = {}) {
  const logger = silentLogger()
  return { handler: createDocSyncHandler(config, { firestore: db, logger, pageSize: 2, ...opts }), logs: logger.entries }
}
const processed = (logs: ReturnType<typeof silentLogger>['entries'], rule: string) =>
  logs.filter((l) => l.message === 'doc-sync: processed' && l.fields?.rule === rule)

beforeAll(() => {
  db = firestore()
})
beforeEach(async () => {
  await clearFirestore()
})

describe('scheduled rules: events', () => {
  it('ignores source and target events for a scheduled rule but still runs event rules on the same collection', async () => {
    await db.doc('category/c1').set({ name: 'News' })
    const post = db.doc('post/p1')
    const { handler, logs } = handlerFor()
    const like = db.doc('post/p1/like/u1')
    await invoke(handler, await change(like, () => like.set({ at: 1 })))
    await invoke(handler, await change(post, () => post.set({ title: 'a', categoryId: 'c1' })))
    expect((await post.get()).data()).toEqual({ title: 'a', categoryId: 'c1', category: { name: 'News' } }) // connection ran, likeCount absent
    expect(processed(logs, 'daily-likes')).toEqual([])
    expect(processed(logs, 'post-category')).toHaveLength(1)
  })
})

describe('scheduled rules: /schedule/<rule>', () => {
  it('rebuilds the named rule and answers JSON', async () => {
    await db.doc('post/p1').set({ title: 'a' })
    await db.doc('post/p1/like/u1').set({})
    await db.doc('post/p1/like/u2').set({})
    await db.doc('post/p2').set({ title: 'b', likeCount: 0 })
    const { handler, logs } = handlerFor()
    const { status, body } = await invokeRaw(handler, { url: '/schedule/daily-likes?x=1' })
    expect(status).toBe(200)
    const result = JSON.parse(body!)
    expect(result).toMatchObject({ rule: 'daily-likes', scanned: 2, written: 1, completed: true })
    expect((await db.doc('post/p1').get()).get('likeCount')).toBe(2)
    expect(logs.find((l) => l.message === 'doc-sync schedule: run')?.fields).toMatchObject({ rule: 'daily-likes', written: 1 })
  })

  it('answers 404 for an unknown rule and for an event-driven rule', async () => {
    const { handler } = handlerFor()
    expect((await invokeRaw(handler, { url: '/schedule/nope' })).status).toBe(404)
    expect((await invokeRaw(handler, { url: '/schedule/post-category' })).status).toBe(404)
  })

  it('answers 405 for a non-POST method but runs on POST or when the method is unknown', async () => {
    await db.doc('post/p1').set({ title: 'a' })
    await db.doc('post/p1/like/u1').set({})
    const { handler } = handlerFor()
    expect((await invokeRaw(handler, { url: '/schedule/daily-likes', method: 'GET' })).status).toBe(405)
    expect((await db.doc('post/p1').get()).get('likeCount')).toBeUndefined()
    expect((await invokeRaw(handler, { url: '/schedule/daily-likes', method: 'POST' })).status).toBe(200)
    expect((await db.doc('post/p1').get()).get('likeCount')).toBe(1)
  })

  it('stops at a page boundary when the budget is exhausted and reports completed: false', async () => {
    for (const id of ['p1', 'p2', 'p3']) {
      await db.doc(`post/${id}`).set({ title: id })
      await db.doc(`post/${id}/like/u1`).set({})
    }
    const { handler, logs } = handlerFor({ pageSize: 1, schedule: { budgetMs: 0 } })
    const { status, body } = await invokeRaw(handler, { url: '/schedule/daily-likes' })
    expect(status).toBe(200)
    const result = JSON.parse(body!)
    expect(result).toMatchObject({ completed: false, scanned: 1, written: 1, lastPath: 'post/p1' })
    expect(logs.some((l) => l.message === 'doc-sync schedule: budget exceeded, run stopped early')).toBe(true)
    // a run without a budget finishes the rest
    const full = JSON.parse((await invokeRaw(handlerFor({ pageSize: 1 }).handler, { url: '/schedule/daily-likes' })).body!)
    expect(full).toMatchObject({ completed: true, scanned: 3, written: 2 })
  })

  it('answers 500 and logs when the run throws', async () => {
    const boom = defineView({
      name: 'boom',
      target: 'post',
      targetFields: ['x'],
      sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
      build: () => {
        throw new Error('boom')
      },
      schedule: '0 * * * *',
    })
    const boomConfig = defineConfig({ name: 'doc-sync', region: 'asia-northeast1', service: 'docsync', serviceAccount: 'doc-sync-trigger', rules: [boom] })
    await db.doc('post/p1').set({})
    const logger = silentLogger()
    const handler = createDocSyncHandler(boomConfig, { firestore: db, logger, pageSize: 2 })
    const { status, body } = await invokeRaw(handler, { url: '/schedule/boom', method: 'POST' })
    expect(status).toBe(500)
    expect(JSON.parse(body!)).toMatchObject({ error: 'run failed' })
    expect(logger.entries.some((l) => l.message === 'doc-sync schedule: run failed, will be retried by Cloud Scheduler')).toBe(true)
  })

  it('works with a plain http.ServerResponse-like response (statusCode + end only)', async () => {
    await db.doc('post/p1').set({ title: 'a' })
    const { handler } = handlerFor()
    const { status, body } = await invokeRaw(handler, { url: '/schedule/daily-likes', method: 'POST', plainResponse: true })
    expect(status).toBe(200)
    expect(JSON.parse(body!)).toMatchObject({ rule: 'daily-likes' })
  })
})

describe('scheduled rules: continuation', () => {
  const host = 'docsync-abc-an.a.run.app'

  async function seed(n: number) {
    for (let i = 1; i <= n; i++) {
      await db.doc(`post/p${i}`).set({ title: `p${i}` })
      await db.doc(`post/p${i}/like/u1`).set({})
    }
  }

  it('enqueues a continuation task when the budget stops the run, and a fed-back task continues the pass', async () => {
    await seed(3)
    const tasks: ContinuationTask[] = []
    const { handler, logs } = handlerFor({ pageSize: 1, schedule: { budgetMs: 0, enqueue: async (t) => { tasks.push(t) } } })

    const first = JSON.parse((await invokeRaw(handler, { url: '/schedule/daily-likes', headers: { host, 'x-cloudscheduler-scheduletime': '2026-10-12T03:00:00Z' } })).body!)
    expect(first).toMatchObject({ completed: false, continued: true, runId: '2026-10-12T03-00-00Z', chunk: 0, scanned: 1, written: 1, lastPath: 'post/p1' })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      id: 'daily-likes-2026-10-12T03-00-00Z-1',
      rule: 'daily-likes',
      url: `https://${host}/schedule/daily-likes`,
      body: { startAfter: 'post/p1', runId: '2026-10-12T03-00-00Z', chunk: 1 },
      serviceAccountEmail: 'doc-sync-trigger@demo-doc-sync.iam.gserviceaccount.com',
      audience: `https://${host}`,
      queue: { project: 'demo-doc-sync', location: 'asia-northeast1', name: 'doc-sync-schedule' },
    })
    expect(logs.some((l) => l.message === 'doc-sync schedule: continuation enqueued')).toBe(true)

    // Cloud Tasks delivers the task: same URL, the task body as the request body.
    const second = JSON.parse((await invokeRaw(handler, { url: '/schedule/daily-likes', headers: { host }, body: tasks[0]!.body })).body!)
    expect(second).toMatchObject({ completed: false, continued: true, runId: '2026-10-12T03-00-00Z', chunk: 1, scanned: 1, written: 1, lastPath: 'post/p2' })
    // With pageSize 1 a full page never proves the end: chunk 2 processes p3 and still stops (budget 0); chunk 3 finds no page and completes.
    const third = JSON.parse((await invokeRaw(handler, { url: '/schedule/daily-likes', headers: { host }, body: tasks[1]!.body })).body!)
    expect(third).toMatchObject({ completed: false, continued: true, chunk: 2, scanned: 1, written: 1, lastPath: 'post/p3' })
    const fourth = JSON.parse((await invokeRaw(handler, { url: '/schedule/daily-likes', headers: { host }, body: tasks[2]!.body })).body!)
    expect(fourth).toMatchObject({ completed: true, continued: false, chunk: 3, scanned: 0, written: 0 })
    expect(tasks).toHaveLength(3)
    for (const id of ['p1', 'p2', 'p3']) expect((await db.doc(`post/${id}`).get()).get('likeCount')).toBe(1)
  })

  it('continues from a cursor whose document was deleted meanwhile', async () => {
    await seed(2)
    const { handler } = handlerFor({ pageSize: 1 })
    await db.doc('post/p1').delete()
    const result = JSON.parse((await invokeRaw(handler, { url: '/schedule/daily-likes', headers: { host }, body: { startAfter: 'post/p1', runId: 'r', chunk: 1, startedAt: '2026-10-12T03:00:00.000Z' } })).body!)
    expect(result).toMatchObject({ completed: true, chunk: 1, scanned: 1, written: 1 })
  })

  it('answers 200 with continued: false when the task cannot be enqueued or the service URL is unknown', async () => {
    await seed(2)
    const failing = handlerFor({ pageSize: 1, schedule: { budgetMs: 0, enqueue: async () => { throw new Error('no permission') } } })
    const a = JSON.parse((await invokeRaw(failing.handler, { url: '/schedule/daily-likes', headers: { host } })).body!)
    expect(a).toMatchObject({ completed: false, continued: false })
    expect(failing.logs.some((l) => l.message === 'doc-sync schedule: could not enqueue continuation; the next scheduled run starts over')).toBe(true)

    const noHost = handlerFor({ pageSize: 1, schedule: { budgetMs: 0, enqueue: async () => {} } })
    const b = JSON.parse((await invokeRaw(noHost.handler, { url: '/schedule/daily-likes' })).body!)
    expect(b).toMatchObject({ completed: false, continued: false })
    expect(noHost.logs.some((l) => l.message === 'doc-sync schedule: could not enqueue continuation; the next scheduled run starts over')).toBe(true)
  })

  it('does not enqueue when continuation is disabled, and ignores malformed body fields', async () => {
    await seed(2)
    const tasks: ContinuationTask[] = []
    const { handler } = handlerFor({ pageSize: 1, schedule: { budgetMs: 0, continue: false, enqueue: async (t) => { tasks.push(t) } } })
    const r = JSON.parse((await invokeRaw(handler, { url: '/schedule/daily-likes', headers: { host }, body: { startAfter: 7, chunk: 'x', runId: 'ok' } })).body!)
    expect(r).toMatchObject({ completed: false, continued: false, chunk: 0, runId: 'ok', lastPath: 'post/p1' })
    expect(tasks).toEqual([])
  })

  it('accepts a continuation body delivered as rawBody bytes (the Firebase onRequest shape)', async () => {
    await seed(2)
    const { handler } = handlerFor({ pageSize: 1 })
    const body = { startAfter: 'post/p1', runId: 'r', chunk: 1, startedAt: '2026-10-12T03:00:00.000Z' }
    const result = JSON.parse((await invokeRaw(handler, { url: '/schedule/daily-likes', headers: { host }, body: Buffer.from(JSON.stringify(body)) })).body!)
    expect(result).toMatchObject({ completed: true, chunk: 1, runId: 'r', scanned: 1, written: 1, lastPath: 'post/p2' })
  })
})

describe('scheduledRuleFromUrl', () => {
  it('parses the rule name and ignores query strings and trailing slashes', () => {
    expect(scheduledRuleFromUrl('/schedule/daily-likes')).toBe('daily-likes')
    expect(scheduledRuleFromUrl('/schedule/daily-likes/?x=1')).toBe('daily-likes')
    expect(scheduledRuleFromUrl('/schedule/a%20b')).toBe('a b')
    expect(scheduledRuleFromUrl('/schedule/%E0')).toBe('%E0')
    expect(scheduledRuleFromUrl('/')).toBeUndefined()
    expect(scheduledRuleFromUrl('/schedule/')).toBeUndefined()
    expect(scheduledRuleFromUrl('/schedule/a/b')).toBeUndefined()
    expect(scheduledRuleFromUrl(undefined)).toBeUndefined()
  })
})
