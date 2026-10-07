/**
 * Encoding of `DocumentEventData` protobuf payloads from Admin SDK snapshots.
 * Used by `doc-sync dev` (the emulator bridge) and by tests; the inverse of `decode.ts`.
 */
import type { DocumentSnapshot, Timestamp } from 'firebase-admin/firestore'
import { DocumentReference, GeoPoint, Timestamp as TimestampClass } from 'firebase-admin/firestore'
import protobuf from 'protobufjs'
import descriptor from './proto/firestore-events.json' with { type: 'json' }

const root = protobuf.Root.fromJSON(descriptor as protobuf.INamespace)
const DocumentEventData = root.lookupType('google.events.cloud.firestore.v1.DocumentEventData')

export interface EncodableDocument {
  /** Document path relative to the database root. */
  path: string
  data: Record<string, unknown>
  createTime?: Timestamp
  updateTime?: Timestamp
}

export interface EncodeOptions {
  project: string
  database?: string
}

/** Builds the protobuf body Eventarc sends for a `written` event. Pass `undefined` for a missing side (create / delete). */
export function encodeDocumentEventData(
  before: EncodableDocument | DocumentSnapshot | undefined,
  after: EncodableDocument | DocumentSnapshot | undefined,
  opts: EncodeOptions,
): Buffer {
  const prefix = `projects/${opts.project}/databases/${opts.database ?? '(default)'}/documents/`
  const payload = { oldValue: toProtoDocument(before, prefix), value: toProtoDocument(after, prefix) }
  const err = DocumentEventData.verify(payload)
  if (err) throw new Error(`invalid DocumentEventData: ${err}`)
  return Buffer.from(DocumentEventData.encode(DocumentEventData.create(payload)).finish())
}

function toProtoDocument(doc: EncodableDocument | DocumentSnapshot | undefined, prefix: string) {
  if (!doc) return undefined
  const ts = (t: Timestamp | undefined) => (t ? { seconds: t.seconds, nanos: t.nanoseconds } : undefined)
  if (isSnapshot(doc)) {
    if (!doc.exists) return undefined
    return { name: prefix + doc.ref.path, fields: toProtoFields(doc.data() ?? {}), createTime: ts(doc.createTime), updateTime: ts(doc.updateTime) }
  }
  return { name: prefix + doc.path, fields: toProtoFields(doc.data), createTime: ts(doc.createTime), updateTime: ts(doc.updateTime) }
}

function isSnapshot(doc: EncodableDocument | DocumentSnapshot): doc is DocumentSnapshot {
  return typeof (doc as DocumentSnapshot).data === 'function'
}

function toProtoFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toProtoValue(v)]))
}

function toProtoValue(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return { nullValue: 0 }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: v } : { doubleValue: v }
  if (typeof v === 'bigint') return { integerValue: v.toString() }
  if (typeof v === 'string') return { stringValue: v }
  if (v instanceof TimestampClass) return { timestampValue: { seconds: v.seconds, nanos: v.nanoseconds } }
  if (v instanceof Date) return { timestampValue: { seconds: Math.floor(v.getTime() / 1000), nanos: (v.getTime() % 1000) * 1e6 } }
  if (v instanceof GeoPoint) return { geoPointValue: { latitude: v.latitude, longitude: v.longitude } }
  if (v instanceof DocumentReference) {
    const db = (v.firestore as unknown as { _settings?: { databaseId?: string }; projectId?: string })
    return { referenceValue: `projects/${db.projectId ?? '_'}/databases/${db._settings?.databaseId ?? '(default)'}/documents/${v.path}` }
  }
  if (v instanceof Uint8Array) return { bytesValue: v }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toProtoValue) } }
  if (typeof v === 'object') return { mapValue: { fields: toProtoFields(v as Record<string, unknown>) } }
  throw new Error(`cannot encode value of type ${typeof v}`)
}
