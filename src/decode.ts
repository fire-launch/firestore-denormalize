/**
 * Decoding of Eventarc Firestore events (`google.events.cloud.firestore.v1.DocumentEventData`).
 *
 * Both `application/protobuf` (the default for Firestore triggers) and
 * `application/json` payloads are supported. Values are converted to the same
 * JS types the Admin SDK returns, so they can be compared with `isEqual`.
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore'
import { GeoPoint, Timestamp } from 'firebase-admin/firestore'
import protobuf from 'protobufjs'
import descriptor from './proto/firestore-events.json' with { type: 'json' }

export interface DecodedDocument {
  /** Document path relative to the database root, e.g. `post/abc`. */
  path: string
  data: DocumentData
}

export interface DecodedEvent {
  /** State before the change. `undefined` for a create. */
  before: DecodedDocument | undefined
  /** State after the change. `undefined` for a delete. */
  after: DecodedDocument | undefined
  /** Database ID taken from the document resource name, if present. */
  database: string | undefined
}

export class DecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DecodeError'
  }
}

const root = protobuf.Root.fromJSON(descriptor as protobuf.INamespace)
const DocumentEventData = root.lookupType('google.events.cloud.firestore.v1.DocumentEventData')

type RawDocument = {
  name?: string
  fields?: Record<string, RawValue>
}
type RawValue = Record<string, unknown>
type RawEvent = { value?: RawDocument; oldValue?: RawDocument }

/**
 * Decodes a request body. `body` is a Buffer for protobuf, or a Buffer / string / parsed object for JSON.
 */
export function decodeDocumentEventData(
  body: Uint8Array | string | object | undefined,
  contentType: string | undefined,
  firestore: Firestore,
): DecodedEvent {
  const raw = toRawEvent(body, contentType)
  const before = toDocument(raw.oldValue, firestore)
  const after = toDocument(raw.value, firestore)
  const name = raw.value?.name || raw.oldValue?.name
  return { before, after, database: name ? parseResourceName(name)?.database : undefined }
}

function toRawEvent(body: Uint8Array | string | object | undefined, contentType: string | undefined): RawEvent {
  const isJson = contentType?.includes('json') ?? false
  const isProto = contentType?.includes('protobuf') || contentType?.includes('octet-stream')
  try {
    if (body === undefined || body === null) throw new DecodeError('empty request body')
    if (!isJson && (isProto || body instanceof Uint8Array)) {
      if (!(body instanceof Uint8Array)) throw new DecodeError('protobuf payload must be a Buffer')
      const message = DocumentEventData.decode(body)
      return DocumentEventData.toObject(message, {
        longs: String,
        enums: String,
        bytes: String,
        defaults: false,
        oneofs: true,
      }) as RawEvent
    }
    if (typeof body === 'string') return JSON.parse(body) as RawEvent
    if (body instanceof Uint8Array) return JSON.parse(Buffer.from(body).toString('utf8')) as RawEvent
    return body as RawEvent
  } catch (err) {
    if (err instanceof DecodeError) throw err
    throw new DecodeError(`failed to decode ${contentType ?? 'unknown content type'} payload: ${(err as Error).message}`, {
      cause: err,
    })
  }
}

function toDocument(doc: RawDocument | undefined, firestore: Firestore): DecodedDocument | undefined {
  if (!doc || typeof doc !== 'object') return undefined
  if (!doc.name && !doc.fields) return undefined
  if (!doc.name) throw new DecodeError('document without a resource name')
  const parsed = parseResourceName(doc.name)
  if (!parsed) throw new DecodeError(`unexpected document resource name: ${doc.name}`)
  const data: DocumentData = {}
  for (const [key, value] of Object.entries(doc.fields ?? {})) data[key] = fromValue(value, firestore)
  return { path: parsed.path, data }
}

/** `projects/{p}/databases/{d}/documents/{path}` */
export function parseResourceName(name: string): { project: string; database: string; path: string } | undefined {
  const m = /^projects\/([^/]+)\/databases\/([^/]+)\/documents\/(.+)$/.exec(name)
  if (!m) return undefined
  return { project: m[1]!, database: m[2]!, path: m[3]! }
}

function fromValue(v: RawValue, firestore: Firestore): unknown {
  if ('nullValue' in v) return null
  if ('booleanValue' in v) return Boolean(v.booleanValue)
  if ('integerValue' in v) {
    // Like the Admin SDK, use Number when it is exact. Beyond 2^53 keep a BigInt so changes are not masked
    // (decoded values are only ever compared with other decoded values, never with SDK values).
    const n = Number(v.integerValue)
    return Number.isSafeInteger(n) ? n : BigInt(String(v.integerValue))
  }
  if ('doubleValue' in v) return Number(v.doubleValue)
  if ('stringValue' in v) return String(v.stringValue ?? '')
  if ('timestampValue' in v) return toTimestamp(v.timestampValue)
  if ('bytesValue' in v) {
    const b = v.bytesValue
    return b instanceof Uint8Array ? Buffer.from(b) : Buffer.from(String(b ?? ''), 'base64')
  }
  if ('referenceValue' in v) {
    const parsed = parseResourceName(String(v.referenceValue))
    if (!parsed) throw new DecodeError(`unexpected reference value: ${String(v.referenceValue)}`)
    return firestore.doc(parsed.path)
  }
  if ('geoPointValue' in v) {
    const g = (v.geoPointValue ?? {}) as { latitude?: number; longitude?: number }
    return new GeoPoint(g.latitude ?? 0, g.longitude ?? 0)
  }
  if ('arrayValue' in v) {
    const values = ((v.arrayValue ?? {}) as { values?: RawValue[] }).values ?? []
    return values.map((x) => fromValue(x, firestore))
  }
  if ('mapValue' in v) {
    const fields = ((v.mapValue ?? {}) as { fields?: Record<string, RawValue> }).fields ?? {}
    const out: DocumentData = {}
    for (const [k, x] of Object.entries(fields)) out[k] = fromValue(x, firestore)
    return out
  }
  throw new DecodeError(`unknown value type: ${Object.keys(v).join(',') || '(empty)'}`)
}

function toTimestamp(t: unknown): Timestamp {
  if (typeof t === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(t)
    if (!m) throw new DecodeError(`unexpected timestamp: ${t}`)
    const ms = Date.parse(`${m[1]}${m[3]}`)
    const nanos = m[2] ? Number(m[2].padEnd(9, '0')) : 0
    return new Timestamp(Math.floor(ms / 1000), nanos)
  }
  const o = (t ?? {}) as { seconds?: number | string; nanos?: number }
  return new Timestamp(Number(o.seconds ?? 0), Number(o.nanos ?? 0))
}
