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
  targetField: 'latestComments',
  sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId', orderBy: [['createdAt', 'desc']], limit: 2 } },
  build: ({ sources }) => {
    builds++
    return sources.comments.map((c) => ({ id: c.id, body: c.get('body') }))
  },
})

/** user.badges = { [badgeId]: { name } } over badge where badge.userId == uid, with a patch fast path for create / delete. */
const badges = defineView({
  name: 'user-badges',
  target: 'user',
  targetField: 'badges',
  sources: { badges: { collection: 'badge', idField: 'userId', orderBy: ['name'] } },
  build: ({ sources }) => {
    builds++
    return Object.fromEntries(sources.badges.map((b) => [b.id, { name: b.get('name') }]))
  },
  patch: (current, change) => {
    const id = change.path.split('/').pop()!
    if (change.before && change.after) return undefined // an update: fall back to build
    const next: Record<string, { name: unknown }> = { ...(current ?? {}) }
    if (change.after) next[id] = { name: change.after.name }
    else delete next[id]
    return next
  },
})

/** post.summary = "<author name> / <category name>" from the documents post.authorId / post.categoryId point at. */
const summary = defineView({
  name: 'post-summary',
  target: 'post',
  targetField: 'summary',
  sources: {
    author: { collection: 'user', refField: 'authorId' },
    category: { collection: 'category', refField: 'categoryId', watch: ['name'] },
  },
  build: ({ sources }) => {
    builds++
    const [author] = sources.author
    const [category] = sources.category
    if (!author && !category) return undefined
    return `${author?.get('name') ?? '?'} / ${category?.get('name') ?? '?'}`
  },
})

/** users/{uid}/post.commentCount via a nested idParam source; post.mentions via a collection-group idField source. */
const nested = defineView({
  name: 'user-post-comments',
  target: 'users/{uid}/post',
  targetField: 'commentCount',
  sources: { comments: { collection: 'users/{uid}/post/{postId}/comment', idParam: 'postId' } },
  build: ({ sources }) => sources.comments.length,
})
const mentions = defineView({
  name: 'post-mentions',
  target: 'post',
  targetField: 'mentions',
  sources: { mentions: { collection: 'users/{uid}/mention', idField: 'postId', orderBy: ['at'], limit: 2 } },
  build: ({ sources }) => sources.mentions.map((m: QueryDocumentSnapshot) => m.ref.path),
})

/** thread.latest = newest 2 messages, maintained by patch with at most one extra read per event (refill after a delete). */
let refills = 0
type Item = { id: string; body: unknown; at: number }
const latestMessages = defineView({
  name: 'thread-latest',
  target: 'thread',
  targetField: 'latest',
  sources: { messages: { collection: 'message', idField: 'threadId', orderBy: [['at', 'desc']], limit: 2, watch: ['body', 'at'] } },
  build: ({ sources }) => {
    builds++
    return sources.messages.map((m): Item => ({ id: m.id, body: m.get('body'), at: m.get('at') }))
  },
  patch: async (current, change, { target, firestore }) => {
    const id = change.path.split('/').pop()!
    const rest = (current ?? []).filter((m) => m.id !== id)
    const after = change.after
    if (after && after.threadId === target.id) {
      return [...rest, { id, body: after.body, at: after.at as number }].sort((a, b) => b.at - a.at).slice(0, 2)
    }
    if (rest.length === (current ?? []).length) return current
    if (rest.length < 2 && rest.length > 0) {
      refills++
      const older = await firestore.collection('message').where('threadId', '==', target.id).where('at', '<', rest[rest.length - 1]!.at).orderBy('at', 'desc').limit(1).get()
      for (const m of older.docs) rest.push({ id: m.id, body: m.get('body'), at: m.get('at') })
    }
    return rest
  },
})

const config = defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'doc-sync-trigger',
  views: [latestComments, badges, summary, nested, mentions, latestMessages],
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
      { rule: 'user-badges', document: 'user/u1', field: 'badges', actual: { b1: { name: 'Old' } }, expected: { b1: { name: 'Gold' } }, fixed: false },
    ])
    expect((await db.doc('user/u1').get()).get('badges')).toEqual({ b1: { name: 'Old' } })

    const fixed = await verify(config, { firestore: db, logger, rules: ['user-badges'], fix: true })
    expect(fixed[0]).toMatchObject({ mismatched: 1, fixed: 1, fix: true })
    expect(fixed[0]!.mismatches[0]).toMatchObject({ document: 'user/u1', fixed: true })
    expect((await db.doc('user/u1').get()).get('badges')).toEqual({ b1: { name: 'Gold' } })

    expect(await verify(config, { firestore: db, logger, rules: ['user-badges'] })).toEqual([expect.objectContaining({ mismatched: 0 })])
  })
})
