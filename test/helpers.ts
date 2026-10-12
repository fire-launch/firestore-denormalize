import { initializeApp, getApps } from 'firebase-admin/app'
import { type DocumentReference, type DocumentSnapshot, type Firestore, getFirestore } from 'firebase-admin/firestore'
import { encodeDocumentEventData, type DocSyncHandler, type DocSyncRequest, type DocSyncResponse } from '../src/index.js'

export const PROJECT = 'demo-doc-sync'

export function firestore(): Firestore {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set. Run tests with `npm test` (firebase emulators:exec).')
  }
  if (getApps().length === 0) initializeApp({ projectId: PROJECT })
  return getFirestore()
}

/** Wipes every document in the emulator database. */
export async function clearFirestore(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST!
  const res = await fetch(`http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`failed to clear emulator: ${res.status}`)
}

export function resourceName(path: string): string {
  return `projects/${PROJECT}/databases/(default)/documents/${path}`
}

/** Encodes a DocumentEventData protobuf from two snapshots (either may be missing / non-existent). */
export function encodeEvent(before: DocumentSnapshot | undefined, after: DocumentSnapshot | undefined): Buffer {
  return encodeDocumentEventData(before, after, { project: PROJECT })
}

export interface InvokeOptions {
  before?: DocumentSnapshot
  after?: DocumentSnapshot
  /** Overrides the `ce-document` header; `null` removes it. */
  document?: string | null
  database?: string
  body?: Uint8Array | string | object
  contentType?: string
  headers?: Record<string, string>
  url?: string
  method?: string
}

/** Sends one CloudEvent (binary content mode) to the handler and returns the HTTP status. */
export async function invoke(handler: DocSyncHandler, opts: InvokeOptions): Promise<number> {
  const snap = opts.after?.ref ?? opts.before?.ref
  const document = opts.document === undefined ? snap?.path : opts.document
  const body = opts.body ?? encodeEvent(opts.before, opts.after)
  const headers: Record<string, string> = {
    'content-type': opts.contentType ?? 'application/protobuf',
    'ce-id': `${Date.now()}-${Math.random()}`,
    'ce-specversion': '1.0',
    'ce-type': 'google.cloud.firestore.document.v1.written',
    'ce-source': `//firestore.googleapis.com/projects/${PROJECT}/databases/(default)`,
    'ce-database': opts.database ?? '(default)',
    ...(document ? { 'ce-document': document } : {}),
    ...opts.headers,
  }
  const req: DocSyncRequest = {
    headers,
    url: opts.url,
    rawBody: typeof body === 'object' && body instanceof Uint8Array ? body : undefined,
    body: body instanceof Uint8Array ? undefined : body,
  }
  let status = 0
  const res: DocSyncResponse = {
    status(code) {
      status = code
      return this
    },
    send() {},
  }
  await handler(req, res)
  return status
}

/** Like `invoke`, but returns the status and the response body text (JSON routes). */
export async function invokeRaw(handler: DocSyncHandler, opts: InvokeOptions): Promise<{ status: number; body: string | undefined }> {
  let status = 0
  let body: string | undefined
  const req: DocSyncRequest = { headers: { 'content-type': 'application/json', ...opts.headers }, url: opts.url, method: opts.method, body: opts.body ?? {} }
  const res: DocSyncResponse = {
    setHeader() {},
    status(code) {
      status = code
      return res
    },
    send(text?: string) {
      body = text
    },
    end(text?: string) {
      body = text
    },
  }
  await handler(req, res)
  return { status, body }
}

/** Captures before/after snapshots around a mutation, like Eventarc would. */
export async function change(ref: DocumentReference, mutate: () => Promise<unknown>) {
  const before = await ref.get()
  await mutate()
  const after = await ref.get()
  return { before, after }
}

export function silentLogger(entries: { level: string; message: string; fields?: Record<string, unknown> }[] = []) {
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    entries.push({ level, message, fields })
  }
  return { entries, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }
}
