/**
 * HTTP handler for Eventarc Firestore events.
 *
 * Event payloads are only used to decide whether work is needed. The values
 * written to targets are always re-read from Firestore, and every write is
 * conditional on the target's `updateTime` observed before the source was read.
 */
import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Query,
} from 'firebase-admin/firestore'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { type Connection, type DocSyncConfig, type ResolvedConfig, validateConfig } from './config.js'
import { DecodeError, decodeDocumentEventData, type DecodedDocument } from './decode.js'
import { isEqual } from './equal.js'
import { jsonLogger, type Logger } from './logger.js'

export interface DocSyncHandlerOptions {
  /** Firestore instance to use. Defaults to `getFirestore()` (or `getFirestore(database)` for a named database). */
  firestore?: Firestore
  /** Defaults to a structured JSON logger. `console` and `firebase-functions/logger` work too. */
  logger?: Logger
  /** How many times to redo a target whose conditional write failed. Default 5. */
  maxRetries?: number
  /** Page size for the target query (`where idField == sourceId`). Default 500. */
  pageSize?: number
}

/** Request shape accepted by the handler. Express / firebase-functions requests satisfy it. */
export interface DocSyncRequest {
  headers: Record<string, string | string[] | undefined>
  body?: unknown
  rawBody?: Uint8Array
  [Symbol.asyncIterator]?(): AsyncIterator<unknown>
}

/** Response shape accepted by the handler. Express responses and `http.ServerResponse` satisfy it. */
export interface DocSyncResponse {
  statusCode?: number
  status?(code: number): unknown
  send?(...args: any[]): unknown
  end?(...args: any[]): unknown
}

export type DocSyncHandler = (req: DocSyncRequest, res: DocSyncResponse) => Promise<void>

/** Result of processing one connection for one event. */
export interface ConnectionResult {
  connection: string
  role: 'source' | 'target'
  action: 'skip' | 'write' | 'delete'
  /** Why nothing was written (only for `skip`). */
  reason?: string
  /** Number of target documents inspected. */
  targets: number
  /** Number of documents written. */
  writes: number
  /** Number of conditional writes that failed and were redone. */
  retries: number
}

const DELETE = Symbol('FieldValue.delete')
const NOTHING = Symbol('nothing')
type Desired = DocumentData | null | typeof DELETE
type Computed = Desired | typeof NOTHING

const GRPC_FAILED_PRECONDITION = 9
const GRPC_NOT_FOUND = 5

export class RetriesExhaustedError extends Error {
  constructor(path: string, attempts: number) {
    super(`conditional write for ${path} still failing after ${attempts} attempts`)
    this.name = 'RetriesExhaustedError'
  }
}

/**
 * Creates the handler. Validates the config and throws {@link ConfigError} if it is invalid.
 */
export function createDocSyncHandler(config: DocSyncConfig, options: DocSyncHandlerOptions = {}): DocSyncHandler {
  const resolved = validateConfig(config)
  const logger = options.logger ?? jsonLogger
  const maxRetries = options.maxRetries ?? 5
  const pageSize = options.pageSize ?? 500
  let firestore = options.firestore
  const db = (): Firestore => {
    if (!firestore) {
      firestore = resolved.database === '(default)' ? getFirestore() : getFirestore(resolved.database)
    }
    return firestore
  }

  const bySource = new Map<string, Connection[]>()
  const byTarget = new Map<string, Connection[]>()
  for (const c of resolved.connections) {
    bySource.set(c.source, [...(bySource.get(c.source) ?? []), c])
    byTarget.set(c.target, [...(byTarget.get(c.target) ?? []), c])
  }

  const processor = new Processor(resolved, db, logger, maxRetries, pageSize)

  return async function docSyncHandler(req, res) {
    const startedAt = Date.now()
    const eventId = header(req, 'ce-id')
    const eventType = header(req, 'ce-type')

    let event
    try {
      const body = await readBody(req)
      event = decodeDocumentEventData(body, header(req, 'content-type'), db())
    } catch (err) {
      if (err instanceof DecodeError) {
        logger.error('doc-sync: failed to decode event, dropping it', { eventId, eventType, error: err })
        return respond(res, 204)
      }
      logger.error('doc-sync: failed before processing, will be retried by Eventarc', { eventId, eventType, error: err })
      return respond(res, 500)
    }

    const database = header(req, 'ce-database') ?? event.database
    if (database !== undefined && database !== resolved.database) {
      logger.info('doc-sync: event for another database, ignored', { eventId, database, expected: resolved.database })
      return respond(res, 204)
    }

    const document = header(req, 'ce-document') ?? event.after?.path ?? event.before?.path
    if (!document) {
      logger.error('doc-sync: event without a document path, dropping it', { eventId, eventType })
      return respond(res, 204)
    }
    const segments = document.split('/')
    if (segments.length !== 2 || !segments[0] || !segments[1]) {
      logger.warn('doc-sync: only top-level collections are supported, ignored', { eventId, document })
      return respond(res, 204)
    }
    const [collection, docId] = segments as [string, string]

    const asSource = bySource.get(collection) ?? []
    const asTarget = byTarget.get(collection) ?? []
    if (asSource.length === 0 && asTarget.length === 0) {
      logger.warn('doc-sync: no connection uses this collection, ignored', { eventId, document })
      return respond(res, 204)
    }

    // Source-side tasks fan out to different documents and run in parallel. Target-side tasks
    // all write the same document, so they run one after another to avoid racing each other.
    const settled = await Promise.allSettled([
      ...asSource.map((c) => processor.asSource(c, docId, event.before, event.after)),
      ...sequential(asTarget.map((c) => () => processor.asTarget(c, docId, event.before, event.after))),
    ])

    let failed = false
    settled.forEach((r, i) => {
      const conn = i < asSource.length ? asSource[i]! : asTarget[i - asSource.length]!
      if (r.status === 'fulfilled') {
        logger.info('doc-sync: processed', { eventId, document, ...r.value, durationMs: Date.now() - startedAt })
      } else {
        failed = true
        logger.error('doc-sync: failed, will be retried by Eventarc', {
          eventId,
          document,
          connection: conn.name,
          error: r.reason,
          durationMs: Date.now() - startedAt,
        })
      }
    })
    return respond(res, failed ? 500 : 204)
  }
}

class Processor {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly db: () => Firestore,
    private readonly logger: Logger,
    private readonly maxRetries: number,
    private readonly pageSize: number,
  ) {}

  /** 5.2: the changed document is a source of `conn`. */
  async asSource(
    conn: Connection,
    sourceId: string,
    before: DecodedDocument | undefined,
    after: DecodedDocument | undefined,
  ): Promise<ConnectionResult> {
    const result: ConnectionResult = { connection: conn.name, role: 'source', action: 'skip', targets: 0, writes: 0, retries: 0 }
    if (before && after && conn.fields.every((f) => isEqual(before.data[f], after.data[f]))) {
      result.reason = 'fields unchanged'
      return result
    }

    const firestore = this.db()
    const sourceRef = firestore.collection(conn.source).doc(sourceId)
    const base: Query = firestore.collection(conn.target).where(conn.idField, '==', sourceId).limit(this.pageSize)
    const writer = firestore.bulkWriter()
    const pending: Promise<void>[] = []
    const retry: DocumentReference[] = []
    const failures: unknown[] = []
    let last: DocumentSnapshot | undefined

    for (;;) {
      const page = await (last ? base.startAfter(last) : base).get()
      if (page.empty) break
      result.targets += page.size

      // Read the source only after the targets, so a stale source value can never pass the precondition.
      const sourceSnap = await sourceRef.get()
      const desired = computeDesired(sourceSnap, conn, conn.onSourceDelete)
      if (desired === NOTHING) {
        result.reason = 'source missing and onSourceDelete=nothing'
        break
      }

      for (const target of page.docs) {
        if (!needsWrite(target, conn.targetField, desired)) continue
        const p = writer
          .update(target.ref, { [conn.targetField]: toFieldValue(desired) }, { lastUpdateTime: target.updateTime })
          .then(() => {
            result.writes++
            result.action = desired === DELETE ? 'delete' : 'write'
          })
          .catch((err: unknown) => {
            // Never reject here: a rejection with no handler attached yet would be an unhandledRejection.
            if (isCode(err, GRPC_FAILED_PRECONDITION)) retry.push(target.ref)
            else if (!isCode(err, GRPC_NOT_FOUND)) failures.push(err)
          })
        pending.push(p)
      }

      if (page.size < this.pageSize) break
      last = page.docs[page.docs.length - 1]
    }

    await writer.close()
    await Promise.all(pending)
    if (failures.length) throw failures[0]

    for (const ref of retry) {
      result.retries++
      const outcome = await this.syncOne(ref, conn, { sourceId, onSourceDelete: conn.onSourceDelete }, 1)
      if (outcome !== 'skip') {
        result.writes++
        result.action = outcome
      }
    }
    if (result.writes === 0 && !result.reason) result.reason = result.targets ? 'targets up to date' : 'no targets'
    return result
  }

  /** 5.3: the changed document is a target of `conn`. */
  async asTarget(
    conn: Connection,
    targetId: string,
    before: DecodedDocument | undefined,
    after: DecodedDocument | undefined,
  ): Promise<ConnectionResult> {
    const result: ConnectionResult = { connection: conn.name, role: 'target', action: 'skip', targets: 1, writes: 0, retries: 0 }
    if (!after) {
      result.reason = 'target deleted'
      return result
    }
    if (before && isEqual(before.data[conn.idField], after.data[conn.idField])) {
      result.reason = 'idField unchanged'
      return result
    }
    const ref = this.db().collection(conn.target).doc(targetId)
    const outcome = await this.syncOne(ref, conn, undefined, 0)
    if (outcome === 'skip') result.reason = 'target up to date'
    else {
      result.writes = 1
      result.action = outcome
    }
    return result
  }

  /**
   * Re-reads one target, then its source, and performs a single conditional write.
   * Redoes itself when the precondition fails. `attempt` is 0 for a first try and
   * counts redos from 1; more than `maxRetries` redos throw {@link RetriesExhaustedError}.
   *
   * `deleted` describes the source event being processed, if any: when the target still
   * points at that source and it is gone, `onSourceDelete` applies. A target pointing at
   * any other missing source is left alone (same as the target-side rule).
   */
  private async syncOne(
    ref: DocumentReference,
    conn: Connection,
    deleted: { sourceId: string; onSourceDelete: Connection['onSourceDelete'] } | undefined,
    attempt: number,
  ): Promise<'skip' | 'write' | 'delete'> {
    if (attempt > this.maxRetries) throw new RetriesExhaustedError(ref.path, attempt)
    const target = await ref.get()
    if (!target.exists) return 'skip'

    const currentId: unknown = target.get(conn.idField)
    let desired: Computed
    if (currentId === undefined || currentId === null || currentId === '') {
      desired = DELETE
    } else if (typeof currentId !== 'string') {
      this.logger.warn('doc-sync: idField is not a string, skipped', {
        connection: conn.name,
        document: ref.path,
        idField: conn.idField,
        type: typeof currentId,
      })
      return 'skip'
    } else {
      const sourceSnap = await this.db().collection(conn.source).doc(currentId).get()
      const onMissing = deleted && deleted.sourceId === currentId ? deleted.onSourceDelete : 'nothing'
      desired = computeDesired(sourceSnap, conn, onMissing)
    }
    if (desired === NOTHING || !needsWrite(target, conn.targetField, desired)) return 'skip'

    try {
      await ref.update({ [conn.targetField]: toFieldValue(desired) }, { lastUpdateTime: target.updateTime })
      return desired === DELETE ? 'delete' : 'write'
    } catch (err) {
      if (isCode(err, GRPC_NOT_FOUND)) return 'skip'
      if (!isCode(err, GRPC_FAILED_PRECONDITION)) throw err
      return this.syncOne(ref, conn, deleted, attempt + 1)
    }
  }
}

function computeDesired(
  source: DocumentSnapshot,
  conn: Connection,
  onMissing: Connection['onSourceDelete'],
): Computed {
  if (source.exists) {
    const data = source.data() ?? {}
    const out: DocumentData = {}
    for (const f of conn.fields) if (data[f] !== undefined) out[f] = data[f]
    return out
  }
  switch (onMissing) {
    case 'setNull':
      return null
    case 'deleteField':
      return DELETE
    default:
      return NOTHING
  }
}

function needsWrite(target: DocumentSnapshot, targetField: string, desired: Desired): boolean {
  const current: unknown = target.get(targetField)
  if (desired === DELETE) return current !== undefined
  return !isEqual(current, desired)
}

function toFieldValue(desired: Desired): unknown {
  return desired === DELETE ? FieldValue.delete() : desired
}

/** Runs the tasks one after another; returns one promise per task (settled in order) so callers can still use allSettled. */
function sequential<T>(tasks: (() => Promise<T>)[]): Promise<T>[] {
  let chain: Promise<unknown> = Promise.resolve()
  return tasks.map((task) => {
    const p = chain.then(task)
    chain = p.catch(() => undefined)
    return p
  })
}

function isCode(err: unknown, code: number): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code
}

function header(req: DocSyncRequest, name: string): string | undefined {
  const v = req.headers[name] ?? req.headers[name.toLowerCase()]
  const s = Array.isArray(v) ? v[0] : v
  return s === undefined || s === '' ? undefined : s
}

async function readBody(req: DocSyncRequest): Promise<Uint8Array | string | object | undefined> {
  if (req.rawBody instanceof Uint8Array) return req.rawBody
  if (req.body instanceof Uint8Array || typeof req.body === 'string') return req.body
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    return req.body
  }
  if (typeof req[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = []
    for await (const chunk of req as AsyncIterable<unknown>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array))
    }
    return chunks.length ? Buffer.concat(chunks) : undefined
  }
  return undefined
}

function respond(res: DocSyncResponse, code: number): void {
  if (typeof res.status === 'function') {
    const r = res.status(code) as DocSyncResponse | undefined
    const target = r && typeof r === 'object' ? r : res
    if (typeof target.send === 'function') target.send()
    else if (typeof target.end === 'function') target.end()
    return
  }
  res.statusCode = code
  if (typeof res.end === 'function') res.end()
}

export { DecodeError }
