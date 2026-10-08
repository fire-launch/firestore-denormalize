/**
 * One-command local demo: Firestore emulator (with UI) + the handler on a local HTTP server
 * + the `doc-sync dev` bridge, all in this process. Edit documents in the Emulator UI and
 * watch the derived fields follow.
 *
 *   npm run demo
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const PROJECT = 'demo-doc-sync'
const FIRESTORE_HOST = '127.0.0.1:8990'
const HANDLER_PORT = 8081
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

// Everything below talks to the emulator only.
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST
process.env.GCLOUD_PROJECT = PROJECT

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`

let stopping = false

// ---------------------------------------------------------------- 1. emulator
console.log(bold('Starting the Firestore emulator...'))
const emulator = spawn(
  'firebase',
  ['emulators:start', '--only', 'firestore', '--project', PROJECT, '--config', resolve(here, 'firebase.json')],
  { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
)
let uiUrl = `http://127.0.0.1:4000/firestore/data`
const onEmulatorLine = (line) => {
  const m = /View Emulator UI at (\S+)/.exec(line)
  if (m) uiUrl = `${m[1].replace(/\/$/, '')}/firestore/data`
  if (/error|warn|⚠/i.test(line)) console.log(dim(`[emulator] ${line}`))
}
for (const stream of [emulator.stdout, emulator.stderr]) {
  let buf = ''
  stream.on('data', (d) => {
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    lines.forEach(onEmulatorLine)
  })
}
emulator.on('exit', (code) => {
  if (!stopping) {
    console.error(`emulator exited with code ${code}. Is firebase-tools installed and Java available?`)
    process.exit(1)
  }
})

const waitForEmulator = async () => {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://${FIRESTORE_HOST}/`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Firestore emulator did not come up on ${FIRESTORE_HOST}`)
}
await waitForEmulator()

// ---------------------------------------------------------------- 2. handler + bridge
const { initializeApp } = await import('firebase-admin/app')
const { getFirestore } = await import('firebase-admin/firestore')
const { createDocSyncHandler, startDevBridge } = await import(resolve(root, 'dist/index.js'))
const jiti = createJiti(import.meta.url)
const config = await jiti.import(resolve(root, 'examples/doc-sync.config.ts'), { default: true })

initializeApp({ projectId: PROJECT })
const db = getFirestore()

const handlerLogger = {
  info: (m, f) => {
    if (m !== 'doc-sync: processed') return
    const act = f.action === 'skip' ? dim(`skip (${f.reason})`) : green(`${f.action} x${f.writes}${f.retries ? ` (retries ${f.retries})` : ''}`)
    console.log(`  ${yellow(f.document)} ${dim(f.rule)} ${act}`)
  },
  warn: (m, f) => console.log(`  ${yellow('warn')} ${m} ${JSON.stringify(f)}`),
  error: (m, f) => console.log(`  \x1b[31merror\x1b[0m ${m} ${f?.error?.message ?? JSON.stringify(f)}`),
}
const handler = createDocSyncHandler(config, { firestore: db, logger: handlerLogger })
const server = createServer((req, res) => handler(req, res))
await new Promise((r) => server.listen(HANDLER_PORT, '127.0.0.1', r))

const bridge = startDevBridge(config, {
  firestore: db,
  url: `http://127.0.0.1:${HANDLER_PORT}/`,
  project: PROJECT,
  logger: { info() {}, warn: handlerLogger.warn, error: handlerLogger.error },
})
await bridge.ready

// ---------------------------------------------------------------- 3. sample data
const batch = db.batch()
batch.set(db.doc('category/c1'), { name: 'Coffee', color: 'brown' })
batch.set(db.doc('user/u1'), { displayName: 'Alice', photoUrl: 'https://example.com/a.png' })
batch.set(db.doc('post/p1'), { title: 'First post', categoryId: 'c1', authorId: 'u1' })
batch.set(db.doc('post/p2'), { title: 'Second post', categoryId: 'c1' })
batch.set(db.doc('post/p1/like/alice'), {})
batch.set(db.doc('customer/acme'), { name: 'ACME' })
batch.set(db.doc('order/o1'), { customerId: 'acme', amount: 120 })
batch.set(db.doc('order/o2'), { customerId: 'acme', amount: 80.5 })
batch.set(db.doc('users/u1/tags/t1'), { label: 'hot' })
batch.set(db.doc('users/u1/posts/x'), { tagId: 't1' })
await batch.commit()
await new Promise((r) => setTimeout(r, 1500))
await bridge.idle()

console.log()
console.log(bold('Ready.') + ` Emulator UI: ${bold(uiUrl)}`)
console.log(`Rules: ${dim(resolve(root, 'examples/doc-sync.config.ts'))}`)
console.log()
console.log('Things to try in the UI:')
console.log(`  - change ${yellow('category/c1')}.name         -> post/p1.category and post/p2.category follow`)
console.log(`  - delete ${yellow('category/c1')}              -> post.category becomes null (onSourceDelete: setNull)`)
console.log(`  - set    ${yellow('post/p2')}.authorId = "u1"  -> post/p2.author is filled from user/u1`)
console.log(`  - add    ${yellow('post/p1/like/bob')}         -> post/p1.likeCount becomes 2`)
console.log(`  - change ${yellow('order/o2')}.amount          -> customer/acme.total is recomputed`)
console.log(`  - change ${yellow('users/u1/tags/t1')}.label   -> users/u1/posts/x.tag follows`)
console.log()
console.log(dim('Each processed event is printed below. Ctrl+C to stop.'))
console.log()

// ---------------------------------------------------------------- 4. shutdown
const stop = async () => {
  if (stopping) return
  stopping = true
  console.log('\nstopping...')
  bridge.stop()
  server.close()
  emulator.kill('SIGINT')
  await new Promise((r) => emulator.once('exit', r))
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
