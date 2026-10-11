import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { createDocSyncHandler, defineConfig, defineView, rebuild, verify, type DocSyncConfig } from '../src/index.js'
import { change, clearFirestore, firestore, invoke, silentLogger } from './helpers.js'

let db: Firestore
let builds = 0

/** post.latestComments = the 2 newest comments of post/{postId}/comment, as [{ id, body }]. */
const latestComments = defineView({
  name: 'post-latest-comments',
  target: 'post',
  targetFields: ['latestComments'],
  sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId', orderBy: [['createdAt', 'desc']], limit: 2 } },
  build: ({ sources }) => {
    builds++
    return { latestComments: sources.comments.map((c) => ({ id: c.id, body: c.get('body') })) }
  },
})

/** user.badges = { [badgeId]: { name } } over badge where badge.userId == uid, with a patch fast path for create / delete. */
const badges = defineView({
  name: 'user-badges',
  target: 'user',
  targetFields: ['badges'],
  sources: { badges: { collection: 'badge', idField: 'userId', orderBy: ['name'] } },
  build: ({ sources }) => {
    builds++
    return { badges: Object.fromEntries(sources.badges.map((b) => [b.id, { name: b.get('name') }])) }
  },
  patch: (current, change) => {
    const id = change.path.split('/').pop()!
    if (change.before && change.after) return undefined // an update: fall back to build
    const next: Record<string, { name: unknown }> = { ...((current.badges as Record<string, { name: unknown }> | undefined) ?? {}) }
    if (change.after) next[id] = { name: change.after.name }
    else delete next[id]
    return { badges: next }
  },
})

/** post.summary = "<author name> / <category name>" from the documents post.authorId / post.categoryId point at. */
const summary = defineView({
  name: 'post-summary',
  target: 'post',
  targetFields: ['summary'],
  sources: {
    author: { collection: 'user', refField: 'authorId' },
    category: { collection: 'category', refField: 'categoryId', watch: ['name'] },
  },
  build: ({ sources }) => {
    builds++
    const [author] = sources.author
    const [category] = sources.category
    if (!author && !category) return undefined
    return { summary: `${author?.get('name') ?? '?'} / ${category?.get('name') ?? '?'}` }
  },
})

/** users/{uid}/post.commentCount via a nested idParam source; post.mentions via a collection-group idField source. */
const nested = defineView({
  name: 'user-post-comments',
  target: 'users/{uid}/post',
  targetFields: ['commentCount'],
  sources: { comments: { collection: 'users/{uid}/post/{postId}/comment', idParam: 'postId' } },
  build: ({ sources }) => ({ commentCount: sources.comments.length }),
})
const mentions = defineView({
  name: 'post-mentions',
  target: 'post',
  targetFields: ['mentions'],
  sources: { mentions: { collection: 'users/{uid}/mention', idField: 'postId', orderBy: ['at'], limit: 2 } },
  build: ({ sources }) => ({ mentions: sources.mentions.map((m: QueryDocumentSnapshot) => m.ref.path) }),
})

/** thread.latest = newest 2 messages, maintained by patch with at most one extra read per event (refill after a delete). */
let refills = 0
type Item = { id: string; body: unknown; at: number }
const latestMessages = defineView({
  name: 'thread-latest',
  target: 'thread',
  targetFields: ['latest'],
  sources: { messages: { collection: 'message', idField: 'threadId', orderBy: [['at', 'desc']], limit: 2, watch: ['body', 'at'] } },
  build: ({ sources }) => {
    builds++
    return { latest: sources.messages.map((m): Item => ({ id: m.id, body: m.get('body'), at: m.get('at') })) }
  },
  patch: async (current, change, { target, firestore }) => {
    const id = change.path.split('/').pop()!
    const list = (current.latest as Item[] | undefined) ?? []
    const rest = list.filter((m) => m.id !== id)
    const after = change.after
    if (after && after.threadId === target.id) {
      return { latest: [...rest, { id, body: after.body, at: after.at as number }].sort((a, b) => b.at - a.at).slice(0, 2) }
    }
    if (rest.length === list.length) return { latest: list }
    if (rest.length < 2 && rest.length > 0) {
      refills++
      const older = await firestore.collection('message').where('threadId', '==', target.id).where('at', '<', rest[rest.length - 1]!.at).orderBy('at', 'desc').limit(1).get()
      for (const m of older.docs) rest.push({ id: m.id, body: m.get('body'), at: m.get('at') })
    }
    return { latest: rest }
  },
})

const config = defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'doc-sync-trigger',
  rules: [latestComments, badges, summary, nested, mentions, latestMessages],
})

function handlerFor(cfg: DocSyncConfig = config, opts: Parameters<typeof createDocSyncHandler>[1] = {}) {
  const logger = silentLogger()
  const handler = createDocSyncHandler(cfg, { firestore: db, logger, pageSize: 2, ...opts })
  return { handler, logs: logger.entries }
}

const processed = (logs: ReturnType<typeof silentLogger>['entries'], rule: string) =>
  logs.findLast((l) => l.message === 'doc-sync: processed' && l.fields?.rule === rule)?.fields

beforeAll(() => {
  db = firestore()
})

beforeEach(async () => {
  await clearFirestore()
  builds = 0
  refills = 0
})

describe('views: idParam source (latest N)', () => {
  it('rebuilds the value from a fresh, ordered, limited read on every source change', async () => {
    const post = db.doc('post/p1')
    await post.set({ title: 'x' })
    await db.doc('post/p2').set({ title: 'y' })
    const { handler, logs } = handlerFor()

    const c1 = db.doc('post/p1/comment/c1')
    expect(await invoke(handler, await change(c1, () => c1.set({ body: 'one', createdAt: 1 })))).toBe(204)
    expect((await post.get()).get('latestComments')).toEqual([{ id: 'c1', body: 'one' }])
    expect(processed(logs, 'post-latest-comments')).toMatchObject({ kind: 'view', role: 'source', source: 'comments', action: 'write', targets: 1, writes: 1 })
    // target read + one query returning one comment
    expect(processed(logs, 'post-latest-comments')).toMatchObject({ reads: 2, queries: 1, aggregations: 0 })

    const c2 = db.doc('post/p1/comment/c2')
    await invoke(handler, await change(c2, () => c2.set({ body: 'two', createdAt: 2 })))
    const c3 = db.doc('post/p1/comment/c3')
    await invoke(handler, await change(c3, () => c3.set({ body: 'three', createdAt: 3 })))
    expect((await post.get()).get('latestComments')).toEqual([
      { id: 'c3', body: 'three' },
      { id: 'c2', body: 'two' },
    ])

    // editing a comment that is in the view changes the value; a no-op update is skipped without a read
    builds = 0
    await invoke(handler, await change(c3, () => c3.update({ body: 'THREE' })))
    expect((await post.get()).get('latestComments')).toEqual([
      { id: 'c3', body: 'THREE' },
      { id: 'c2', body: 'two' },
    ])
    expect(builds).toBe(1)
    await invoke(handler, await change(c3, async () => {}))
    expect(processed(logs, 'post-latest-comments')).toMatchObject({ action: 'skip', reason: 'unchanged' })
    expect(builds).toBe(1)

    // deleting the newest comment lets the older one back in
    await invoke(handler, await change(c3, () => c3.delete()))
    expect((await post.get()).get('latestComments')).toEqual([
      { id: 'c2', body: 'two' },
      { id: 'c1', body: 'one' },
    ])
    expect((await db.doc('post/p2').get()).data()).toEqual({ title: 'y' })
  })

  it('initialises the value when the target is created and ignores other target updates', async () => {
    await db.doc('post/p1/comment/c1').set({ body: 'one', createdAt: 1 })
    const post = db.doc('post/p1')
    const { handler, logs } = handlerFor()
    expect(await invoke(handler, await change(post, () => post.set({ title: 'x' })))).toBe(204)
    expect((await post.get()).get('latestComments')).toEqual([{ id: 'c1', body: 'one' }])
    expect(processed(logs, 'post-latest-comments')).toMatchObject({ role: 'target', action: 'write' })

    // the view's own write comes back as a target event: nothing to do, no read
    builds = 0
    await invoke(handler, await change(post, () => post.update({ title: 'y' })))
    expect(processed(logs, 'post-latest-comments')).toMatchObject({ role: 'target', action: 'skip', reason: 'not a create' })
    expect(builds).toBe(0)

    await invoke(handler, await change(post, () => post.delete()))
    expect(processed(logs, 'post-latest-comments')).toMatchObject({ role: 'target', action: 'skip', reason: 'target deleted' })
  })

  it('drops undefined values from the built value instead of failing the write', async () => {
    const post = db.doc('post/p1')
    await post.set({ title: 'x' })
    const { handler, logs } = handlerFor()
    const c1 = db.doc('post/p1/comment/c1')
    expect(await invoke(handler, await change(c1, () => c1.set({ createdAt: 1 })))).toBe(204) // no `body`
    expect((await post.get()).get('latestComments')).toEqual([{ id: 'c1' }])
    expect(processed(logs, 'post-latest-comments')).toMatchObject({ action: 'write' })
  })

  it('does nothing when the target does not exist', async () => {
    const c1 = db.doc('post/ghost/comment/c1')
    const { handler, logs } = handlerFor()
    expect(await invoke(handler, await change(c1, () => c1.set({ body: 'one', createdAt: 1 })))).toBe(204)
    expect((await db.doc('post/ghost').get()).exists).toBe(false)
    expect(processed(logs, 'post-latest-comments')).toMatchObject({ action: 'skip', targets: 1, writes: 0 })
  })
})

describe('views: idField source with patch', () => {
  it('uses patch for creates and deletes, build for updates, and stays idempotent', async () => {
    const user = db.doc('user/u1')
    await user.set({ name: 'U' })
    const { handler, logs } = handlerFor()

    const b1 = db.doc('badge/b1')
    const created = await change(b1, () => b1.set({ userId: 'u1', name: 'Gold' }))
    expect(await invoke(handler, created)).toBe(204)
    expect((await user.get()).get('badges')).toEqual({ b1: { name: 'Gold' } })
    expect(builds).toBe(0)

    // duplicate delivery: patch yields the same value, nothing is written
    expect(await invoke(handler, created)).toBe(204)
    expect(processed(logs, 'user-badges')).toMatchObject({ action: 'skip', reason: 'targets up to date' })

    const b2 = db.doc('badge/b2')
    await invoke(handler, await change(b2, () => b2.set({ userId: 'u1', name: 'Silver' })))
    expect((await user.get()).get('badges')).toEqual({ b1: { name: 'Gold' }, b2: { name: 'Silver' } })
    expect(builds).toBe(0)

    // an update: patch returns undefined, build recomputes from a fresh read
    await invoke(handler, await change(b2, () => b2.update({ name: 'Bronze' })))
    expect((await user.get()).get('badges')).toEqual({ b1: { name: 'Gold' }, b2: { name: 'Bronze' } })
    expect(builds).toBe(1)

    await invoke(handler, await change(b1, () => b1.delete()))
    expect((await user.get()).get('badges')).toEqual({ b2: { name: 'Bronze' } })
    expect(builds).toBe(1)
  })

  it('gives patch the document as it is now, so a stale create cannot resurrect a deleted item', async () => {
    const user = db.doc('user/u1')
    await user.set({ name: 'U' })
    const b1 = db.doc('badge/b1')
    const { handler } = handlerFor()
    const created = await change(b1, () => b1.set({ userId: 'u1', name: 'Gold' }))
    await invoke(handler, created)
    await invoke(handler, await change(b1, () => b1.delete()))
    expect((await user.get()).get('badges')).toEqual({})

    // the create event is delivered again after the delete: `change.after` is a fresh read (missing), so patch removes
    expect(await invoke(handler, created)).toBe(204)
    expect((await user.get()).get('badges')).toEqual({})
    expect(builds).toBe(0)

    // and a stale delete after a recreate re-adds it
    await b1.set({ userId: 'u1', name: 'Gold again' })
    await invoke(handler, { before: created.after, after: undefined })
    expect((await user.get()).get('badges')).toEqual({ b1: { name: 'Gold again' } })
  })

  it('does not let a stale create re-add a document that moved to another target', async () => {
    await db.doc('user/u1').set({ name: 'A', badges: {} })
    await db.doc('user/u2').set({ name: 'B', badges: {} })
    const b1 = db.doc('badge/b1')
    const { handler } = handlerFor()
    const created = await change(b1, () => b1.set({ userId: 'u1', name: 'Gold' }))
    await invoke(handler, created)
    await invoke(handler, await change(b1, () => b1.update({ userId: 'u2' })))
    expect((await db.doc('user/u1').get()).get('badges')).toEqual({})
    expect((await db.doc('user/u2').get()).get('badges')).toEqual({ b1: { name: 'Gold' } })

    // the original create is redelivered: for u1, the fresh document no longer belongs, so patch sees `after: undefined`
    expect(await invoke(handler, created)).toBe(204)
    expect((await db.doc('user/u1').get()).get('badges')).toEqual({})
    expect((await db.doc('user/u2').get()).get('badges')).toEqual({ b1: { name: 'Gold' } })
  })

  it('recomputes both the old and the new target when idField changes', async () => {
    await db.doc('user/u1').set({ name: 'A', badges: { b1: { name: 'Gold' } } })
    await db.doc('user/u2').set({ name: 'B' })
    const b1 = db.doc('badge/b1')
    await b1.set({ userId: 'u1', name: 'Gold' })
    const { handler, logs } = handlerFor()

    expect(await invoke(handler, await change(b1, () => b1.update({ userId: 'u2' })))).toBe(204)
    expect((await db.doc('user/u1').get()).get('badges')).toEqual({})
    expect((await db.doc('user/u2').get()).get('badges')).toEqual({ b1: { name: 'Gold' } })
    expect(processed(logs, 'user-badges')).toMatchObject({ targets: 2, writes: 2 })
  })
})

describe('views: latest N maintained by patch with one extra read', () => {
  it('inserts, replaces, drops and refills by id without calling build', async () => {
    const thread = db.doc('thread/t1')
    await thread.set({ title: 'T', latest: [] })
    const { handler, logs } = handlerFor()
    const send = async (id: string, data: object) => {
      const ref = db.doc(`message/${id}`)
      expect(await invoke(handler, await change(ref, () => ref.set(data)))).toBe(204)
    }
    await send('m1', { threadId: 't1', body: 'one', at: 1 })
    await send('m2', { threadId: 't1', body: 'two', at: 2 })
    await send('m3', { threadId: 't1', body: 'three', at: 3 })
    expect((await thread.get()).get('latest')).toEqual([
      { id: 'm3', body: 'three', at: 3 },
      { id: 'm2', body: 'two', at: 2 },
    ])

    // an old message arriving late is not in the window: no write
    await send('m0', { threadId: 't1', body: 'zero', at: 0 })
    expect(processed(logs, 'thread-latest')).toMatchObject({ action: 'skip', reason: 'targets up to date' })

    // edit in place
    await send('m3', { threadId: 't1', body: 'THREE', at: 3 })
    expect((await thread.get()).get('latest')).toEqual([
      { id: 'm3', body: 'THREE', at: 3 },
      { id: 'm2', body: 'two', at: 2 },
    ])

    // delete the newest: m1 is pulled back in with one limit(1) query
    const m3 = db.doc('message/m3')
    await invoke(handler, await change(m3, () => m3.delete()))
    expect((await thread.get()).get('latest')).toEqual([
      { id: 'm2', body: 'two', at: 2 },
      { id: 'm1', body: 'one', at: 1 },
    ])
    expect(refills).toBe(1)
    expect(builds).toBe(0)
    // target + the deleted message (missing, still billed) + the limit(1) refill query made inside patch
    expect(processed(logs, 'thread-latest')).toMatchObject({ reads: 3, queries: 1, aggregations: 0 })
  })
})

describe('views: refField fan-out with patch reads the changed document once per page', () => {
  const summaryPatch = defineView({
    name: 'post-author-name',
    target: 'post',
    targetFields: ['authorName'],
    sources: { author: { collection: 'user', refField: 'authorId' } },
    build: ({ sources }) => ({ authorName: sources.author[0]?.get('name') ?? null }),
    patch: (_current, change) => ({ authorName: change.after ? (change.after.name as string) : null }),
  })
  it('counts N target reads plus one read per page', async () => {
    await db.doc('user/u1').set({ name: 'Ann' })
    for (let i = 0; i < 5; i++) await db.doc(`post/p${i}`).set({ authorId: 'u1' })
    const { handler, logs } = handlerFor(defineConfig({ ...config, rules: [summaryPatch] })) // pageSize 2 -> pages 2, 2, 1
    const user = db.doc('user/u1')
    expect(await invoke(handler, await change(user, () => user.update({ name: 'Anne' })))).toBe(204)
    for (let i = 0; i < 5; i++) expect((await db.doc(`post/p${i}`).get()).get('authorName')).toBe('Anne')
    expect(processed(logs, 'post-author-name')).toMatchObject({ targets: 5, writes: 5, reads: 5 + 3, queries: 3 })
  })
})

describe('views: refField sources', () => {
  it('fans out a source change to every target pointing at it, honouring watch', async () => {
    await db.doc('user/u1').set({ name: 'Ann' })
    await db.doc('category/c1').set({ name: 'News', color: 'red' })
    for (let i = 0; i < 3; i++) await db.doc(`post/p${i}`).set({ authorId: 'u1', categoryId: 'c1' })
    await db.doc('post/other').set({ authorId: 'u2', categoryId: 'c1' })
    const { handler, logs } = handlerFor()

    const user = db.doc('user/u1')
    expect(await invoke(handler, await change(user, () => user.update({ name: 'Anne' })))).toBe(204)
    for (let i = 0; i < 3; i++) expect((await db.doc(`post/p${i}`).get()).get('summary')).toBe('Anne / News')
    expect((await db.doc('post/other').get()).get('summary')).toBeUndefined()
    expect(processed(logs, 'post-summary')).toMatchObject({ source: 'author', targets: 3, writes: 3 })

    const cat = db.doc('category/c1')
    builds = 0
    await invoke(handler, await change(cat, () => cat.update({ color: 'blue' })))
    expect(processed(logs, 'post-summary')).toMatchObject({ source: 'category', action: 'skip', reason: 'watched fields unchanged' })
    expect(builds).toBe(0)

    await invoke(handler, await change(cat, () => cat.update({ name: 'Olds' })))
    expect((await db.doc('post/p0').get()).get('summary')).toBe('Anne / Olds')
    expect((await db.doc('post/other').get()).get('summary')).toBe('? / Olds')
  })

  it('recomputes the target when a refField changes, and deletes the field when build returns undefined', async () => {
    await db.doc('user/u1').set({ name: 'Ann' })
    await db.doc('user/u2').set({ name: 'Bob' })
    const post = db.doc('post/p1')
    const { handler, logs } = handlerFor()

    expect(await invoke(handler, await change(post, () => post.set({ authorId: 'u1' })))).toBe(204)
    expect((await post.get()).get('summary')).toBe('Ann / ?')

    await invoke(handler, await change(post, () => post.update({ authorId: 'u2' })))
    expect((await post.get()).get('summary')).toBe('Bob / ?')

    builds = 0
    await invoke(handler, await change(post, () => post.update({ title: 'unrelated' })))
    expect(processed(logs, 'post-summary')).toMatchObject({ role: 'target', action: 'skip', reason: 'refFields unchanged' })
    expect(builds).toBe(0)

    // the referenced user disappears: build sees no author and no category and asks for the field to go
    const u2 = db.doc('user/u2')
    await invoke(handler, await change(u2, () => u2.delete()))
    expect((await post.get()).get('summary')).toBeUndefined()
    expect(processed(logs, 'post-summary')).toMatchObject({ action: 'delete', writes: 1 })
  })
})

describe('views: nested targets and collection groups', () => {
  it('resolves an idParam source under a nested target', async () => {
    const post = db.doc('users/u1/post/p1')
    await post.set({ title: 'x' })
    await db.doc('users/u2/post/p1').set({ title: 'y' })
    const { handler } = handlerFor()
    const c = db.doc('users/u1/post/p1/comment/c1')
    expect(await invoke(handler, await change(c, () => c.set({ body: 'hi' })))).toBe(204)
    expect((await post.get()).get('commentCount')).toBe(1)
    expect((await db.doc('users/u2/post/p1').get()).get('commentCount')).toBeUndefined()
  })

  it('queries a collection group for an idField source with extra placeholders, filtering other roots before limit', async () => {
    const post = db.doc('post/p1')
    await post.set({ title: 'x' })
    await db.doc('users/u1/mention/m1').set({ postId: 'p1', at: 2 })
    // same collection id under another root: in the group query, but not a source of this view
    await db.doc('groups/g1/mention/x1').set({ postId: 'p1', at: 0 })
    await db.doc('groups/g1/mention/x2').set({ postId: 'p1', at: 0 })
    const { handler } = handlerFor()
    const m2 = db.doc('users/u2/mention/m2')
    expect(await invoke(handler, await change(m2, () => m2.set({ postId: 'p1', at: 1 })))).toBe(204)
    expect((await post.get()).get('mentions')).toEqual(['users/u2/mention/m2', 'users/u1/mention/m1'])
  })
})

describe('views: rebuild and verify always use build', () => {
  it('rebuild backfills stale and missing values', async () => {
    await db.doc('post/p1').set({ title: 'x', latestComments: [{ id: 'stale', body: 'stale' }] })
    await db.doc('post/p1/comment/c1').set({ body: 'one', createdAt: 1 })
    await db.doc('post/p2').set({ title: 'y' })
    await db.doc('post/p3').set({ title: 'z', latestComments: [] })
    const results = await rebuild(config, { firestore: db, logger: silentLogger(), rules: ['post-latest-comments'] })
    expect(results[0]).toMatchObject({ rule: 'post-latest-comments', kind: 'view', scanned: 3, written: 2 })
    expect((await db.doc('post/p1').get()).get('latestComments')).toEqual([{ id: 'c1', body: 'one' }])
    expect((await db.doc('post/p2').get()).get('latestComments')).toEqual([])
    expect((await db.doc('post/p3').get()).get('latestComments')).toEqual([])
  })

  it('verify reports mismatches and fixes them with --fix, never calling patch', async () => {
    await db.doc('user/u1').set({ name: 'U', badges: { b1: { name: 'Old' } } })
    await db.doc('user/u2').set({ name: 'V', badges: {} })
    await db.doc('badge/b1').set({ userId: 'u1', name: 'Gold' })
    const logger = silentLogger()

    const report = await verify(config, { firestore: db, logger, rules: ['user-badges'] })
    expect(report).toHaveLength(1)
    expect(report[0]).toMatchObject({ rule: 'user-badges', kind: 'view', scanned: 2, mismatched: 1, fixed: 0, fix: false })
    expect(report[0]!.mismatches).toEqual([
      { rule: 'user-badges', document: 'user/u1', issue: 'value', field: 'badges', actual: { b1: { name: 'Old' } }, expected: { b1: { name: 'Gold' } }, fixed: false },
    ])
    expect((await db.doc('user/u1').get()).get('badges')).toEqual({ b1: { name: 'Old' } })

    const fixed = await verify(config, { firestore: db, logger, rules: ['user-badges'], fix: true })
    expect(fixed[0]).toMatchObject({ mismatched: 1, fixed: 1, fix: true })
    expect(fixed[0]!.mismatches[0]).toMatchObject({ document: 'user/u1', fixed: true })
    expect((await db.doc('user/u1').get()).get('badges')).toEqual({ b1: { name: 'Gold' } })

    expect(await verify(config, { firestore: db, logger, rules: ['user-badges'] })).toEqual([expect.objectContaining({ mismatched: 0 })])
  })
})

describe('views: several declared paths', () => {
  const stats = defineView({
    name: 'post-stats',
    target: 'post',
    targetFields: ['commentCount', 'stats.latest', 'firstBody'],
    sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId', orderBy: ['createdAt'] } },
    build: ({ sources }) => ({
      commentCount: sources.comments.length,
      stats: { latest: sources.comments[sources.comments.length - 1]?.id, ignored: 'x' },
      firstBody: sources.comments[0]?.get('body'),
      extra: 1,
    }),
  })
  const cfg = defineConfig({ ...config, rules: [stats] })

  it('writes every declared path in one update, deletes undefined ones and leaves other fields alone', async () => {
    const post = db.doc('post/p1')
    await post.set({ title: 'keep', stats: { likes: 7 } })
    const { handler, logs } = handlerFor(cfg)
    const c1 = db.doc('post/p1/comment/c1')
    await invoke(handler, await change(c1, () => c1.set({ body: 'one', createdAt: 1 })))
    expect((await post.get()).data()).toEqual({ title: 'keep', stats: { likes: 7, latest: 'c1' }, commentCount: 1, firstBody: 'one' })
    expect(processed(logs, 'post-stats')).toMatchObject({ action: 'write', writes: 1 })

    await invoke(handler, await change(c1, () => c1.delete()))
    expect((await post.get()).data()).toEqual({ title: 'keep', stats: { likes: 7 }, commentCount: 0 })
    expect(processed(logs, 'post-stats')).toMatchObject({ action: 'write', writes: 1 })
  })

  it('warns once per undeclared path and never writes it', async () => {
    const post = db.doc('post/p1')
    await post.set({})
    const { handler, logs } = handlerFor(cfg)
    const c1 = db.doc('post/p1/comment/c1')
    await invoke(handler, await change(c1, () => c1.set({ body: 'one', createdAt: 1 })))
    await invoke(handler, await change(c1, () => c1.update({ body: 'two' })))
    const warnings = logs.filter((l) => l.message === 'doc-sync: build returned a field the view does not declare, ignored')
    expect(warnings.map((w) => w.fields?.field).sort()).toEqual(['extra', 'stats.ignored'])
    expect((await post.get()).get('extra')).toBeUndefined()
  })

  it('skips when every declared path already holds its value', async () => {
    const post = db.doc('post/p1')
    await post.set({ commentCount: 1, stats: { latest: 'c1' }, firstBody: 'one' })
    const { handler, logs } = handlerFor(cfg)
    const c1 = db.doc('post/p1/comment/c1')
    await c1.set({ body: 'one', createdAt: 1 })
    await invoke(handler, await change(c1, () => c1.update({ createdAt: 2 }))) // changes the document, not the built values
    expect(processed(logs, 'post-stats')).toMatchObject({ action: 'skip', reason: 'targets up to date' })
  })

  it('gives patch the declared paths as an object and writes what it returns', async () => {
    const counted = defineView({
      name: 'post-counted',
      target: 'post',
      targetFields: ['commentCount', 'lastBody'],
      sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
      build: ({ sources }) => ({ commentCount: sources.comments.length, lastBody: sources.comments[sources.comments.length - 1]?.get('body') }),
      patch: (current, change) => {
        if (!change.after || change.before) return undefined
        return { commentCount: ((current.commentCount as number | undefined) ?? 0) + 1, lastBody: change.after.body }
      },
    })
    const post = db.doc('post/p1')
    await post.set({ commentCount: 4, lastBody: 'd' })
    const { handler } = handlerFor(defineConfig({ ...config, rules: [counted] }))
    const c5 = db.doc('post/p1/comment/c5')
    await invoke(handler, await change(c5, () => c5.set({ body: 'e' })))
    expect((await post.get()).data()).toEqual({ commentCount: 5, lastBody: 'e' })
  })
})

describe('views: base decides whether the target exists', () => {
  const publicView = defineView({
    name: 'post-public',
    target: 'postPublic',
    base: 'post',
    targetFields: ['title', 'commentCount'],
    sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
    build: ({ base, sources }) => ({ title: base!.get('title'), commentCount: sources.comments.length }),
  })
  const cfg = defineConfig({ ...config, rules: [publicView] })

  it('creates the target when the base is created and updates it when the base changes', async () => {
    const post = db.doc('post/p1')
    const { handler, logs } = handlerFor(cfg)
    await invoke(handler, await change(post, () => post.set({ title: 'a', secret: 's' })))
    expect((await db.doc('postPublic/p1').get()).data()).toEqual({ title: 'a', commentCount: 0 })
    expect(processed(logs, 'post-public')).toMatchObject({ role: 'source', source: 'base', action: 'create', writes: 1 })
    await invoke(handler, await change(post, () => post.update({ title: 'b' })))
    expect((await db.doc('postPublic/p1').get()).get('title')).toBe('b')
    expect(processed(logs, 'post-public')).toMatchObject({ action: 'write' })
    await invoke(handler, await change(post, () => post.update({ secret: 't' })))
    expect(processed(logs, 'post-public')).toMatchObject({ action: 'skip', reason: 'target up to date' })
  })

  it('creates the target from a source event when the base exists, and skips when it does not', async () => {
    await db.doc('post/p1').set({ title: 'a' })
    const { handler, logs } = handlerFor(cfg)
    const c1 = db.doc('post/p1/comment/c1')
    await invoke(handler, await change(c1, () => c1.set({ body: 'x' })))
    expect((await db.doc('postPublic/p1').get()).data()).toEqual({ title: 'a', commentCount: 1 })
    expect(processed(logs, 'post-public')).toMatchObject({ source: 'comments', action: 'create' })
    const ghost = db.doc('post/ghost/comment/c1')
    await invoke(handler, await change(ghost, () => ghost.set({ body: 'x' })))
    expect((await db.doc('postPublic/ghost').get()).exists).toBe(false)
    expect(processed(logs, 'post-public')).toMatchObject({ action: 'skip' })
  })

  it('removes the target when the base is deleted, but not when a source is deleted', async () => {
    const post = db.doc('post/p1')
    await post.set({ title: 'a' })
    const target = db.doc('postPublic/p1')
    await target.set({ title: 'a', commentCount: 1, likeCount: 3 })
    const c1 = db.doc('post/p1/comment/c1')
    await c1.set({ body: 'x' })
    const { handler, logs } = handlerFor(cfg)
    await invoke(handler, await change(c1, () => c1.delete()))
    expect((await target.get()).data()).toEqual({ title: 'a', commentCount: 0, likeCount: 3 })
    await invoke(handler, await change(post, () => post.delete()))
    expect((await target.get()).exists).toBe(false)
    expect(processed(logs, 'post-public')).toMatchObject({ source: 'base', action: 'remove', writes: 1 })
  })

  it('does not resurrect the target from a stale source event after the base was deleted', async () => {
    const post = db.doc('post/p1')
    await post.set({ title: 'a' })
    const c1 = db.doc('post/p1/comment/c1')
    const staleCreate = await change(c1, () => c1.set({ body: 'x' })) // captured while the base existed
    await post.delete()
    const { handler, logs } = handlerFor(cfg)
    await invoke(handler, staleCreate)
    expect((await db.doc('postPublic/p1').get()).exists).toBe(false)
    expect(processed(logs, 'post-public')).toMatchObject({ action: 'skip' })
  })

  it('recreates a target that was deleted by hand while the base exists', async () => {
    await db.doc('post/p1').set({ title: 'a' })
    const target = db.doc('postPublic/p1')
    await target.set({ title: 'a', commentCount: 0 })
    const { handler, logs } = handlerFor(cfg)
    await invoke(handler, await change(target, () => target.delete()))
    expect((await target.get()).data()).toEqual({ title: 'a', commentCount: 0 })
    expect(processed(logs, 'post-public')).toMatchObject({ role: 'target', action: 'create' })
  })

  it('redoes the sync from a fresh read when create() loses a race', async () => {
    let raced = false
    const racy = defineView({
      name: 'post-public-racy',
      target: 'postPublic',
      base: 'post',
      targetFields: ['title', 'commentCount'],
      sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
      build: async ({ base, sources }) => {
        if (!raced) {
          raced = true
          await db.doc('postPublic/p1').set({ title: 'manual', likeCount: 1 }) // someone else creates it between our read and our create()
        }
        return { title: base!.get('title'), commentCount: sources.comments.length }
      },
    })
    const post = db.doc('post/p1')
    const { handler, logs } = handlerFor(defineConfig({ ...config, rules: [racy] }))
    await invoke(handler, await change(post, () => post.set({ title: 'a' })))
    expect((await db.doc('postPublic/p1').get()).data()).toEqual({ title: 'a', commentCount: 0, likeCount: 1 })
    expect(processed(logs, 'post-public-racy')).toMatchObject({ action: 'write', writes: 1 })
  })
})

describe('views: rebuild and verify with base', () => {
  const publicView = defineView({
    name: 'post-public',
    target: 'postPublic',
    base: 'post',
    targetFields: ['title', 'commentCount'],
    sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId' } },
    build: ({ base, sources }) => ({ title: base!.get('title'), commentCount: sources.comments.length }),
  })
  const cfg = defineConfig({ ...config, rules: [publicView] })

  it('rebuild creates missing targets, updates stale ones and removes orphans', async () => {
    await db.doc('post/p1').set({ title: 'a' }) // no target yet
    await db.doc('post/p2').set({ title: 'b' })
    await db.doc('postPublic/p2').set({ title: 'old', commentCount: 0 }) // stale
    await db.doc('postPublic/orphan').set({ title: 'x' }) // base gone
    const [dry] = await rebuild(cfg, { firestore: db, logger: silentLogger(), dryRun: true })
    expect(dry).toMatchObject({ scanned: 4, written: 3 })
    expect((await db.doc('postPublic/p1').get()).exists).toBe(false)
    const [r] = await rebuild(cfg, { firestore: db, logger: silentLogger() })
    expect(r).toMatchObject({ scanned: 5, written: 3 }) // pass 2 also visits postPublic/p1, which pass 1 just created
    expect((await db.doc('postPublic/p1').get()).data()).toEqual({ title: 'a', commentCount: 0 })
    expect((await db.doc('postPublic/p2').get()).data()).toEqual({ title: 'b', commentCount: 0 })
    expect((await db.doc('postPublic/orphan').get()).exists).toBe(false)
  })

  it('rebuild resumes inside the target collection without walking the bases again', async () => {
    await db.doc('post/p1').set({ title: 'a' })
    await db.doc('postPublic/orphan').set({ title: 'x' })
    await db.doc('postPublic/zz').set({ title: 'y' })
    const [r] = await rebuild(cfg, { firestore: db, logger: silentLogger(), startAfter: 'postPublic/orphan' })
    expect(r).toMatchObject({ scanned: 1, written: 1 })
    expect((await db.doc('postPublic/p1').get()).exists).toBe(false) // base walk skipped
    expect((await db.doc('postPublic/orphan').get()).exists).toBe(true) // before the cursor
    expect((await db.doc('postPublic/zz').get()).exists).toBe(false)
  })

  it('verify reports missing targets, differing fields and orphans, and fixes all three', async () => {
    await db.doc('post/p1').set({ title: 'a' })
    await db.doc('post/p2').set({ title: 'b' })
    await db.doc('postPublic/p2').set({ title: 'old', commentCount: 0 })
    await db.doc('postPublic/orphan').set({ title: 'x' })
    const [report] = await verify(cfg, { firestore: db, logger: silentLogger() })
    expect(report!.mismatches.map((m) => [m.document, m.issue, m.field])).toEqual([
      ['postPublic/p1', 'missing', undefined],
      ['postPublic/p2', 'value', 'title'],
      ['postPublic/orphan', 'orphan', undefined],
    ])
    expect((await db.doc('postPublic/p1').get()).exists).toBe(false)
    const [fixed] = await verify(cfg, { firestore: db, logger: silentLogger(), fix: true })
    expect(fixed!.fixed).toBe(3)
    expect((await db.doc('postPublic/p1').get()).data()).toEqual({ title: 'a', commentCount: 0 })
    expect((await db.doc('postPublic/p2').get()).get('title')).toBe('b')
    expect((await db.doc('postPublic/orphan').get()).exists).toBe(false)
    expect((await verify(cfg, { firestore: db, logger: silentLogger() }))[0]!.mismatched).toBe(0)
  })

  it('handler: removes a target that still exists when a stale source event arrives after the base was deleted', async () => {
    const post = db.doc('post/p1')
    await post.set({ title: 'a' })
    const target = db.doc('postPublic/p1')
    await target.set({ title: 'a', commentCount: 0 })
    const c1 = db.doc('post/p1/comment/c1')
    const staleCreate = await change(c1, () => c1.set({ body: 'x' })) // captured while the base existed
    await post.delete() // base gone, target left behind (no handler ran)
    const { handler, logs } = handlerFor(cfg)
    await invoke(handler, staleCreate)
    expect((await target.get()).exists).toBe(false)
    expect(processed(logs, 'post-public')).toMatchObject({ source: 'comments', action: 'remove', writes: 1 })
  })

  it('resumes after a path that pass 2 itself deleted, without erroring', async () => {
    await db.doc('postPublic/orphan1').set({ title: 'x' }) // no base for either: pass 2 removes both
    await db.doc('postPublic/orphan2').set({ title: 'y' })
    const [r] = await rebuild(cfg, { firestore: db, logger: silentLogger(), pageSize: 1 })
    expect((await db.doc('postPublic/orphan1').get()).exists).toBe(false)
    expect((await db.doc('postPublic/orphan2').get()).exists).toBe(false)
    const lastPath = r!.lastPath!
    expect(lastPath).toBe('postPublic/orphan2')
    expect((await db.doc(lastPath).get()).exists).toBe(false) // the last document rebuild visited no longer exists
    const [resumed] = await rebuild(cfg, { firestore: db, logger: silentLogger(), startAfter: lastPath })
    expect(resumed).toMatchObject({ scanned: 0, written: 0 })
  })
})
