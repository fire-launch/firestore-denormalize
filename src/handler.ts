/**
 * HTTP handler for Eventarc Firestore events.
 *
 * Event payloads are only used to decide whether work is needed. The values
 * written to targets are always re-read from Firestore (or recomputed with an
 * aggregation query), and every write is conditional on the target's `updateTime`
 * observed before the source was read.
 */
import type { DocumentData, DocumentReference, DocumentSnapshot, Firestore, Query } from 'firebase-admin/firestore'
import { AggregateField, FieldValue, getFirestore } from 'firebase-admin/firestore'
import {
  type DocSyncConfig,
  type ResolvedAggregate,
  type ResolvedConfig,
  type ResolvedConnection,
  validateConfig,
} from './config.js'
import { DecodeError, decodeDocumentEventData, type DecodedDocument } from './decode.js'
import { isEqual } from './equal.js'
import { getField, setField } from './fields.js'
import { jsonLogger, type Logger } from './logger.js'
import { type DocumentMatch, isResolvable, matchDocumentPath, resolveCollectionPath } from './paths.js'

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

/** Result of processing one rule for one event. */
export interface RuleResult {
  rule: string
  kind: 'connection' | 'aggregate'
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
/** @deprecated renamed to {@link RuleResult} */
export type ConnectionResult = RuleResult

const DELETE = Symbol('FieldValue.delete')
const NOTHING = Symbol('nothing')
type Desired = DocumentData | number | null | typeof DELETE
type Computed = Desired | typeof NOTHING
type Outcome = 'skip' | 'write' | 'delete'

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
  let firestore = options.firestore
  const db = (): Firestore => {
    if (!firestore) {
      firestore = resolved.database === '(default)' ? getFirestore() : getFirestore(resolved.database)
    }
    return firestore
  }
  const processor = new Processor(db, logger, options.maxRetries ?? 5, options.pageSize ?? 500)
  const rules = [...resolved.connections, ...resolved.aggregates]

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

    type Task = { rule: string; run: () => Promise<RuleResult> }
    const parallel: Task[] = []
    const onSameDoc: Task[] = []
    for (const rule of rules) {
      const asSource = matchDocumentPath(rule.sourcePattern, document)
      if (asSource) {
        parallel.push({
          rule: rule.name,
          run: () =>
            rule.kind === 'connection'
              ? processor.connectionSource(rule, asSource, event.before, event.after)
              : processor.aggregateSource(rule, asSource, event.before, event.after),
        })
      }
      const asTarget = matchDocumentPath(rule.targetPattern, document)
      if (asTarget) {
        onSameDoc.push({
          rule: rule.name,
          run: () =>
            rule.kind === 'connection'
              ? processor.connectionTarget(rule, asTarget, event.before, event.after)
              : processor.aggregateTarget(rule, asTarget, event.before, event.after),
        })
      }
    }
    if (parallel.length === 0 && onSameDoc.length === 0) {
      logger.warn('doc-sync: no rule matches this document, ignored', { eventId, document })
      return respond(res, 204)
    }

    // Source-side tasks fan out to other documents and run in parallel. Target-side tasks
    // all write the event's own document, so they run one after another to avoid racing each other.
    const tasks = [...parallel, ...onSameDoc]
    const settled = await Promise.allSettled([...parallel.map((t) => t.run()), ...sequential(onSameDoc.map((t) => t.run))])

    let failed = false
    settled.forEach((r, i) => {
      const durationMs = Date.now() - startedAt
      if (r.status === 'fulfilled') {
        logger.info('doc-sync: processed', { eventId, document, ...r.value, durationMs })
      } else {
        failed = true
        logger.error('doc-sync: failed, will be retried by Eventarc', {
          eventId,
          document,
          rule: tasks[i]!.rule,
          error: r.reason,
          durationMs,
        })
      }
    })
    return respond(res, failed ? 500 : 204)
  }
}

/**
 * The read / compute / conditional-write logic shared by the handler, `rebuild` and `verify`.
 */
export class Processor {
  constructor(
    private readonly db: () => Firestore,
    private readonly logger: Logger,
    private readonly maxRetries: number,
    private readonly pageSize: number,
  ) {}

  // ---------------------------------------------------------------- copy sync

  /** 5.2: the changed document is a source of `conn`. */
  async connectionSource(
    conn: ResolvedConnection,
    source: DocumentMatch,
    before: DecodedDocument | undefined,
    after: DecodedDocument | undefined,
  ): Promise<RuleResult> {
    const result = newResult(conn, 'source')
    if (before && after && conn.fields.every((f) => isEqual(getField(before.data, f), getField(after.data, f)))) {
      result.reason = 'fields unchanged'
      return result
    }

    const firestore = this.db()
    const sourceRef = firestore.doc(source.path)
    const query = this.targetsOf(conn, source).limit(this.pageSize)
    const writer = firestore.bulkWriter()
    const pending: Promise<void>[] = []
    const retry: DocumentReference[] = []
    const failures: unknown[] = []
    let last: DocumentSnapshot | undefined

    for (;;) {
      const page = await (last ? query.startAfter(last) : query).get()
      if (page.empty) break
      const docs = page.docs.filter((d) => this.belongsTo(conn, source, d.ref.path))
      result.targets += docs.length

      // Read the source only after the targets, so a stale source value can never pass the precondition.
      const sourceSnap = await sourceRef.get()
      const desired = copyValue(sourceSnap, conn, conn.onSourceDelete)
      if (desired === NOTHING) {
        result.reason = 'source missing and onSourceDelete=nothing'
        break
      }

      for (const target of docs) {
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
      count(result, await this.syncCopy(ref, conn, { sourcePath: source.path, onSourceDelete: conn.onSourceDelete }, 1))
    }
    if (result.writes === 0 && !result.reason) result.reason = result.targets ? 'targets up to date' : 'no targets'
    return result
  }

  /** 5.3: the changed document is a target of `conn`. */
  async connectionTarget(
    conn: ResolvedConnection,
    target: DocumentMatch,
    before: DecodedDocument | undefined,
    after: DecodedDocument | undefined,
  ): Promise<RuleResult> {
    const result = newResult(conn, 'target')
    result.targets = 1
    if (!after) {
      result.reason = 'target deleted'
      return result
    }
    if (before && isEqual(getField(before.data, conn.idField), getField(after.data, conn.idField))) {
      result.reason = 'idField unchanged'
      return result
    }
    count(result, await this.syncCopy(this.db().doc(target.path), conn, undefined, 0))
    if (result.writes === 0) result.reason = 'target up to date'
    return result
  }

  /**
   * Re-reads one target, then its source, and performs a single conditional write.
   * Redoes itself when the precondition fails. `attempt` is 0 for a first try and
   * counts redos from 1; more than `maxRetries` redos throw {@link RetriesExhaustedError}.
   *
   * `deleted` describes the source event being processed, if any: when the target still
   * points at that source and it is gone, `onSourceDelete` applies. A target pointing at
   * any other missing source is left alone (same as the target-side rule). `rebuild`
   * passes `{ onSourceDelete }` without a path to apply the policy to every missing source.
   */
  async syncCopy(
    ref: DocumentReference,
    conn: ResolvedConnection,
    deleted: { sourcePath?: string; onSourceDelete: ResolvedConnection['onSourceDelete'] } | undefined,
    attempt: number,
  ): Promise<Outcome> {
    if (attempt > this.maxRetries) throw new RetriesExhaustedError(ref.path, attempt)
    const target = await ref.get()
    if (!target.exists) return 'skip'

    const currentId: unknown = target.get(conn.idField)
    let desired: Computed
    if (currentId === undefined || currentId === null || currentId === '') {
      desired = DELETE
    } else if (typeof currentId !== 'string') {
      this.logger.warn('doc-sync: idField is not a string, skipped', {
        rule: conn.name,
        document: ref.path,
        idField: conn.idField,
        type: typeof currentId,
      })
      return 'skip'
    } else {
      const sourcePath = this.sourcePathFor(conn, ref.path, currentId)
      if (!sourcePath) return 'skip'
      const sourceSnap = await this.db().doc(sourcePath).get()
      const applies = deleted && (deleted.sourcePath === undefined || deleted.sourcePath === sourcePath)
      desired = copyValue(sourceSnap, conn, applies ? deleted.onSourceDelete : 'nothing')
    }
    if (desired === NOTHING || !needsWrite(target, conn.targetField, desired)) return 'skip'

    try {
      await ref.update({ [conn.targetField]: toFieldValue(desired) }, { lastUpdateTime: target.updateTime })
      return desired === DELETE ? 'delete' : 'write'
    } catch (err) {
      if (isCode(err, GRPC_NOT_FOUND)) return 'skip'
      if (!isCode(err, GRPC_FAILED_PRECONDITION)) throw err
      return this.syncCopy(ref, conn, deleted, attempt + 1)
    }
  }

  /** Query for the targets of a source document: a concrete collection when the path allows it, else a collection group. */
  targetsOf(conn: ResolvedConnection, source: DocumentMatch): Query {
    const concrete = resolveCollectionPath(conn.targetPattern, source.params)
    const base = concrete ? this.db().collection(concrete) : this.db().collectionGroup(conn.targetPattern.collectionId)
    return base.where(conn.idField, '==', source.id)
  }

  /** For collection-group results: keep only documents whose path matches the target pattern with the source's params. */
  private belongsTo(conn: ResolvedConnection, source: DocumentMatch, targetPath: string): boolean {
    const m = matchDocumentPath(conn.targetPattern, targetPath)
    if (!m) return false
    return Object.entries(source.params).every(([k, v]) => m.params[k] === undefined || m.params[k] === v)
  }

  /** Path of the source document a target points at, derived from the target's own path and `idField` value. */
  private sourcePathFor(conn: ResolvedConnection, targetPath: string, currentId: string): string | undefined {
    const m = matchDocumentPath(conn.targetPattern, targetPath)
    const collection = m && resolveCollectionPath(conn.sourcePattern, m.params)
    if (!collection || currentId.includes('/')) {
      this.logger.warn('doc-sync: cannot locate source for target, skipped', { rule: conn.name, document: targetPath, id: currentId })
      return undefined
    }
    return `${collection}/${currentId}`
  }

  // ---------------------------------------------------------------- aggregates

  /** A counted / summed document changed: recompute for every target it belonged to before and after. */
  async aggregateSource(
    rule: ResolvedAggregate,
    source: DocumentMatch,
    before: DecodedDocument | undefined,
    after: DecodedDocument | undefined,
  ): Promise<RuleResult> {
    const result = newResult(rule, 'source')
    if (before && after && rule.watchedFields.every((f) => isEqual(getField(before.data, f), getField(after.data, f)))) {
      result.reason = 'watched fields unchanged'
      return result
    }
    const ids = new Set<string>()
    for (const doc of [before, after]) {
      if (!doc) continue
      const id = rule.idField ? getField(doc.data, rule.idField) : source.params[rule.idParam!]
      if (typeof id === 'string' && id !== '' && !id.includes('/')) ids.add(id)
    }
    const targetCollection = resolveCollectionPath(rule.targetPattern, source.params)
    if (!targetCollection) {
      result.reason = 'target collection unresolvable'
      return result
    }
    for (const id of ids) {
      result.targets++
      count(result, await this.syncAggregate(this.db().doc(`${targetCollection}/${id}`), rule, 0))
    }
    if (result.writes === 0) result.reason = result.targets ? 'targets up to date' : 'no target id'
    return result
  }

  /** A target was created: give it its initial value. Other target changes are ignored. */
  async aggregateTarget(
    rule: ResolvedAggregate,
    target: DocumentMatch,
    before: DecodedDocument | undefined,
    after: DecodedDocument | undefined,
  ): Promise<RuleResult> {
    const result = newResult(rule, 'target')
    result.targets = 1
    if (!after) {
      result.reason = 'target deleted'
      return result
    }
    if (before) {
      result.reason = 'not a create'
      return result
    }
    count(result, await this.syncAggregate(this.db().doc(target.path), rule, 0))
    if (result.writes === 0) result.reason = 'target up to date'
    return result
  }

  /** Reads the target, runs the aggregation query, writes the number if it differs (conditional on the target's updateTime). */
  async syncAggregate(ref: DocumentReference, rule: ResolvedAggregate, attempt: number): Promise<Outcome> {
    if (attempt > this.maxRetries) throw new RetriesExhaustedError(ref.path, attempt)
    const target = await ref.get()
    if (!target.exists) return 'skip'

    const query = this.sourcesOf(rule, ref.path)
    if (!query) return 'skip'
    const value = await aggregateValue(query, rule)
    if (isEqual(target.get(rule.targetField), value)) return 'skip'

    try {
      await ref.update({ [rule.targetField]: value }, { lastUpdateTime: target.updateTime })
      return 'write'
    } catch (err) {
      if (isCode(err, GRPC_NOT_FOUND)) return 'skip'
      if (!isCode(err, GRPC_FAILED_PRECONDITION)) throw err
      return this.syncAggregate(ref, rule, attempt + 1)
    }
  }

  /** Query over the source documents that belong to a target document. */
  sourcesOf(rule: ResolvedAggregate, targetPath: string): Query | undefined {
    const m = matchDocumentPath(rule.targetPattern, targetPath)
    if (!m) return undefined
    const params = rule.idParam ? { ...m.params, [rule.idParam]: m.id } : m.params
    const concrete = resolveCollectionPath(rule.sourcePattern, params)
    if (rule.idParam) {
      if (!concrete) return undefined
      return this.db().collection(concrete)
    }
    const base = concrete ? this.db().collection(concrete) : this.db().collectionGroup(rule.sourcePattern.collectionId)
    return base.where(rule.idField!, '==', m.id)
  }

  /** Whether running `rule` on a change of its source would use a collection-group query. */
  static usesCollectionGroup(rule: ResolvedConnection | ResolvedAggregate): boolean {
    return rule.kind === 'connection'
      ? !isResolvable(rule.targetPattern, rule.sourcePattern.params)
      : rule.idField !== undefined && !isResolvable(rule.sourcePattern, rule.targetPattern.params)
  }
}

async function aggregateValue(query: Query, rule: ResolvedAggregate): Promise<number> {
  if (rule.aggregate === 'count') {
    const snap = await query.count().get()
    return snap.data().count
  }
  const snap = await query.aggregate({ total: AggregateField.sum(rule.aggregate.sum) }).get()
  const total = snap.data().total
  return typeof total === 'number' ? total : Number(total ?? 0)
}

function newResult(rule: ResolvedConnection | ResolvedAggregate, role: RuleResult['role']): RuleResult {
  return { rule: rule.name, kind: rule.kind, role, action: 'skip', targets: 0, writes: 0, retries: 0 }
}

function count(result: RuleResult, outcome: Outcome): void {
  if (outcome === 'skip') return
  result.writes++
  result.action = outcome
}

/** The value `targetField` should have: a map of the copied fields, or the `onSourceDelete` outcome. */
export function copyValue(
  source: DocumentSnapshot,
  conn: ResolvedConnection,
  onMissing: ResolvedConnection['onSourceDelete'],
): Computed {
  if (source.exists) {
    const out: DocumentData = {}
    for (const f of conn.fields) {
      const v = source.get(f)
      if (v !== undefined) setField(out, f, v)
    }
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
