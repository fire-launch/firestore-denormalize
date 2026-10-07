import { initializeApp, getApps } from 'firebase-admin/app'
import {
  type DocumentReference,
  type DocumentSnapshot,
  DocumentReference as DocRef,
  type Firestore,
  GeoPoint,
  getFirestore,
  Timestamp,
} from 'firebase-admin/firestore'
import protobuf from 'protobufjs'
import descriptor from '../src/proto/firestore-events.json' with { type: 'json' }
import type { DocSyncHandler, DocSyncRequest, DocSyncResponse } from '../src/index.js'

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

const root = protobuf.Root.fromJSON(descriptor as protobuf.INamespace)
const DocumentEventData = root.lookupType('google.events.cloud.firestore.v1.DocumentEventData')

export function resourceName(path: string): string {
  return `projects/${PROJECT}/databases/(default)/documents/${path}`
}

function toProtoValue(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return { nullValue: 0 }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: v } : { doubleValue: v }
  if (typeof v === 'string') return { stringValue: v }
  if (v instanceof Timestamp) return { timestampValue: { seconds: v.seconds, nanos: v.nanoseconds } }
  if (v instanceof GeoPoint) return { geoPointValue: { latitude: v.latitude, longitude: v.longitude } }
  if (v instanceof DocRef) return { referenceValue: resourceName(v.path) }
  if (v instanceof Uint8Array) return { bytesValue: v }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toProtoValue) } }
  if (typeof v === 'object') return { mapValue: { fields: toProtoFields(v as Record<string, unknown>) } }
  throw new Error(`unsupported value: ${String(v)}`)
}

function toProtoFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toProtoValue(v)]))
}

function toProtoDocument(snap: DocumentSnapshot | undefined): Record<string, unknown> | undefined {
  if (!snap || !snap.exists) return undefined
  const ts = (t: Timestamp | undefined) => (t ? { seconds: t.seconds, nanos: t.nanoseconds } : undefined)
  return {
    name: resourceName(snap.ref.path),
    fields: toProtoFields(snap.data() ?? {}),
    createTime: ts(snap.createTime),
    updateTime: ts(snap.updateTime),
  }
}

/** Encodes a DocumentEventData protobuf from two snapshots (either may be missing / non-existent). */
export function encodeEvent(before: DocumentSnapshot | undefined, after: DocumentSnapshot | undefined): Buffer {
  const payload = { oldValue: toProtoDocument(before), value: toProtoDocument(after) }
  const err = DocumentEventData.verify(payload)
  if (err) throw new Error(err)
  return Buffer.from(DocumentEventData.encode(DocumentEventData.create(payload)).finish())
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
