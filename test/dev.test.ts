import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Firestore } from 'firebase-admin/firestore'
import { createDocSyncHandler, defineConfig, startDevBridge } from '../src/index.js'
import { clearFirestore, firestore, PROJECT, silentLogger } from './helpers.js'

let db: Firestore
let server: Server
let url: string

const config = defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'doc-sync-trigger',
  connections: [
    { name: 'post-category', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull' },
    { name: 'user-post-tag', source: 'users/{uid}/tags', target: 'users/{uid}/posts', idField: 'tagId', fields: ['label'], targetField: 'tag', onSourceDelete: 'setNull' },
  ],
})

beforeAll(async () => {
  db = firestore()
  // The handler behind a plain node:http server, like the Functions emulator would host it.
  const handler = createDocSyncHandler(config, { firestore: db, logger: silentLogger() })
  server = createServer((req, res) => {
    void handler({ headers: req.headers, [Symbol.asyncIterator]: () => req[Symbol.asyncIterator]() }, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  url = `http://127.0.0.1:${addr.port}/`
})
afterAll(async () => {
  await new Promise((r) => server.close(r))
})
beforeEach(async () => {
  await clearFirestore()
})

describe('doc-sync dev bridge', () => {
  it('forwards create / update / delete as CloudEvents and the handler syncs', async () => {
    await db.doc('category/c1').set({ name: 'A' })
    await db.doc('post/existing').set({ categoryId: 'c1' }) // present before the bridge starts: no event

    const delivered: { document: string; change: string; status: number }[] = []
    const bridge = startDevBridge(config, {
      firestore: db,
      url,
      project: PROJECT,
      logger: silentLogger(),
      onDelivered: (d) => delivered.push(d),
    })
    await bridge.ready
    expect(delivered).toEqual([])

    const settle = async () => {
      // onSnapshot delivery is asynchronous; wait for it, then for the POSTs it triggered.
      for (let i = 0; i < 50 && delivered.length === 0; i++) await new Promise((r) => setTimeout(r, 50))
      await new Promise((r) => setTimeout(r, 300))
      await bridge.idle()
    }

    const post = db.doc('post/p1')
    await post.set({ categoryId: 'c1' })
    await settle()
    expect((await post.get()).get('category')).toEqual({ name: 'A' })
    expect(delivered.find((d) => d.document === 'post/p1')).toMatchObject({ change: 'create', status: 204 })

    delivered.length = 0
    await db.doc('category/c1').update({ name: 'B' })
    await settle()
    expect((await post.get()).get('category')).toEqual({ name: 'B' })
    expect((await db.doc('post/existing').get()).get('category')).toEqual({ name: 'B' })
    expect(delivered.find((d) => d.document === 'category/c1')).toMatchObject({ change: 'update', status: 204 })

    delivered.length = 0
    await db.doc('category/c1').delete()
    await settle()
    expect((await post.get()).get('category')).toBeNull()
    expect(delivered.find((d) => d.document === 'category/c1')).toMatchObject({ change: 'delete', status: 204 })

    // nested collections are watched through a collection group
    delivered.length = 0
    await db.doc('users/u1/tags/t1').set({ label: 'L' })
    await db.doc('users/u1/posts/x').set({ tagId: 't1' })
    await settle()
    expect((await db.doc('users/u1/posts/x').get()).get('tag')).toEqual({ label: 'L' })

    bridge.stop()
  })
})
