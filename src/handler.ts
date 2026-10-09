/**
 * HTTP handler for Eventarc Firestore events.
 *
 * Event payloads are only used to decide whether work is needed. The values
 * written to targets are always re-read from Firestore (or recomputed with an
 * aggregation query), and every write is conditional on the target's `updateTime`
 * observed before the source was read.
 */
import type { DocumentData, DocumentReference, DocumentSnapshot, Firestore, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { AggregateField, FieldValue, getFirestore } from 'firebase-admin/firestore'
import {
  type DocSyncConfig,
  needsCollectionGroupQuery,
  type ResolvedAggregate,
  type ResolvedConfig,
  type ResolvedConnection,
  type ResolvedRule,
  type ResolvedView,
  type ResolvedViewSource,
  resolveConfig,
  rulesOf,
  type ViewChange,
} from './config.js'
import { DecodeError, decodeDocumentEventData, type DecodedDocument } from './decode.js'
import { isEqual } from './equal.js'
import { getField, setField } from './fields.js'
import { jsonLogger, type Logger } from './logger.js'
import { type DocumentMatch, matchDocumentPath, resolveCollectionPath } from './paths.js'
import { forEachLimit } from './walk.js'

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
  kind: 'connection' | 'aggregate' | 'view'
  role: 'source' | 'target'
  /** Key of the matched view source (views, role `source`). */
  source?: string
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
/** A value to store in the target field, or `DELETE` for "the field must be absent". */
type Desired = unknown
type Computed = Desired | typeof NOTHING
type Outcome = 'skip' | 'write' | 'delete'

/** Result of comparing one target with what its sources say it should hold. */
export interface CheckResult {
  /** `ok`: up to date. `mismatch`: differs. `skip`: nothing to check (target missing, idField not a string, ...). */
  status: 'ok' | 'mismatch' | 'skip'
  reason?: string
  /** Current value of `targetField` (`undefined` when absent). */
  actual?: unknown
  /** Value `targetField` should hold (`undefined` when it should be absent). Only for `mismatch`. */
  expected?: unknown
}

/** Options for {@link Processor.check}. */
export interface CheckOptions {
  /** Shares source reads between targets (e.g. within one page of `verify`). */
  sourceCache?: Map<string, Promise<DocumentSnapshot>>
}

/** Options shared by {@link Processor.syncCopy} and {@link Processor.syncAggregate}. */
export interface SyncOptions {
  /** 0 (default) for a first try; redos count from 1. */
  attempt?: number
  /** Already-read target snapshot to use for the first attempt instead of reading again. */
  target?: DocumentSnapshot
  /** Compute and compare only; report what would be written without writing. */
  dryRun?: boolean
  /** Shares source reads between targets (e.g. within one page of `rebuild`). */
  sourceCache?: Map<string, Promise<DocumentSnapshot>>
}

export interface DeletedSource {
  /** Path of the deleted source. Omit to apply `onSourceDelete` to every missing source (`rebuild`). */
  sourcePath?: string
  onSourceDelete: ResolvedConnection['onSourceDelete']
}

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
export function createDocSyncHandler(config: DocSyncConfig | ResolvedConfig, options: DocSyncHandlerOptions = {}): DocSyncHandler {
  const resolved = resolveConfig(config)
  const logger = options.logger ?? jsonLogger
  let firestore = options.firestore
  const db = (): Firestore => {
    if (!firestore) {
      firestore = resolved.database === '(default)' ? getFirestore() : getFirestore(resolved.database)
    }
    return firestore
  }
  const processor = new Processor(db, logger, options.maxRetries ?? 5, options.pageSize ?? 500)
  const rules = rulesOf(resolved)

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
    const { before, after } = event
    for (const rule of rules) {
      if (rule.kind === 'view') {
        for (const source of rule.sources) {
          const asSource = matchDocumentPath(source.pattern, document)
          if (asSource) parallel.push({ rule: rule.name, run: () => processor.viewSource(rule, source, asSource, before, after) })
        }
      } else {
        const asSource = matchDocumentPath(rule.sourcePattern, document)
        if (asSource) {
          parallel.push({
            rule: rule.name,
            run: () =>
              rule.kind === 'connection'
                ? processor.connectionSource(rule, asSource, before, after)
                : processor.aggregateSource(rule, asSource, before, after),
          })
        }
      }
      const asTarget = matchDocumentPath(rule.targetPattern, document)
      if (asTarget) {
        onSameDoc.push({
          rule: rule.name,
          run: () =>
            rule.kind === 'connection'
              ? processor.connectionTarget(rule, asTarget, before, after)
              : rule.kind === 'aggregate'
                ? processor.aggregateTarget(rule, asTarget, before, after)
                : processor.viewTarget(rule, asTarget, before, after),
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

  // ---------------------------------------------------------------- any rule

  /** Brings one target of any rule in line with its sources (see {@link syncCopy}, {@link syncAggregate}, {@link syncView}). */
  sync(ref: DocumentReference, rule: ResolvedRule, opts: SyncOptions = {}): Promise<Outcome> {
    switch (rule.kind) {
      case 'connection':
        return this.syncCopy(ref, rule, { ...opts, deleted: { onSourceDelete: rule.onSourceDelete } })
      case 'aggregate':
        return this.syncAggregate(ref, rule, opts)
      case 'view':
        return this.syncView(ref, rule, opts)
    }
  }

  /**
   * Compares an already-read target with what its sources say it should hold, without
   * writing. Missing sources of a connection follow `onSourceDelete`, as in `rebuild`.
   */
  async check(target: DocumentSnapshot, rule: ResolvedRule, opts: CheckOptions = {}): Promise<CheckResult> {
    if (!target.exists) return { status: 'skip', reason: 'target missing' }
    const computed =
      rule.kind === 'connection'
        ? await this.computeCopy(target, rule, { sourceCache: opts.sourceCache, deleted: { onSourceDelete: rule.onSourceDelete } })
        : rule.kind === 'aggregate'
          ? await this.computeAggregate(target, rule)
          : await this.computeView(target, rule, {})
    const actual: unknown = target.get(rule.targetField)
    if (computed.value === NOTHING) return { status: 'skip', reason: computed.reason, actual }
    if (!needsWrite(target, rule.targetField, computed.value)) return { status: 'ok', actual }
    return { status: 'mismatch', actual, expected: computed.value === DELETE ? undefined : computed.value }
  }

  /**
   * Writes `desired` to `ref.{field}` conditional on the `updateTime` of `target`, the snapshot
   * the value was computed from. On a failed precondition `redo` runs the whole read-compute-write
   * again (bounded by `maxRetries`, counted through `attempt`).
   */
  private async write(ref: DocumentReference, target: DocumentSnapshot, field: string, desired: Desired, redo: () => Promise<Outcome>): Promise<Outcome> {
    const outcome: Outcome = desired === DELETE ? 'delete' : 'write'
    try {
      await ref.update({ [field]: toFieldValue(desired) }, { lastUpdateTime: target.updateTime })
      return outcome
    } catch (err) {
      if (isCode(err, GRPC_NOT_FOUND)) return 'skip'
      if (!isCode(err, GRPC_FAILED_PRECONDITION)) throw err
      return redo()
    }
  }

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
      count(result, await this.syncCopy(ref, conn, { deleted: { sourcePath: source.path, onSourceDelete: conn.onSourceDelete }, attempt: 1 }))
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
    count(result, await this.syncCopy(this.db().doc(target.path), conn, {}))
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
  async syncCopy(ref: DocumentReference, conn: ResolvedConnection, opts: SyncOptions & { deleted?: DeletedSource }): Promise<Outcome> {
    const attempt = opts.attempt ?? 0
    if (attempt > this.maxRetries) throw new RetriesExhaustedError(ref.path, attempt)
    const target = opts.target && attempt === 0 ? opts.target : await ref.get()
    if (!target.exists) return 'skip'
    const { value } = await this.computeCopy(target, conn, opts)
    if (value === NOTHING || !needsWrite(target, conn.targetField, value)) return 'skip'
    if (opts.dryRun) return value === DELETE ? 'delete' : 'write'
    return this.write(ref, target, conn.targetField, value, () => this.syncCopy(ref, conn, { ...opts, attempt: attempt + 1, sourceCache: undefined }))
  }

  /** The value `conn.targetField` of `target` should hold, read from the source it points at. */
  private async computeCopy(
    target: DocumentSnapshot,
    conn: ResolvedConnection,
    opts: { sourceCache?: Map<string, Promise<DocumentSnapshot>>; deleted?: DeletedSource },
  ): Promise<{ value: Computed; reason?: string }> {
    const currentId: unknown = target.get(conn.idField)
    if (currentId === undefined || currentId === null || currentId === '') return { value: DELETE }
    if (typeof currentId !== 'string') {
      this.logger.warn('doc-sync: idField is not a string, skipped', {
        rule: conn.name,
        document: target.ref.path,
        idField: conn.idField,
        type: typeof currentId,
      })
      return { value: NOTHING, reason: 'idField is not a string' }
    }
    const sourcePath = this.sourcePathFor(conn, target.ref.path, currentId)
    if (!sourcePath) return { value: NOTHING, reason: 'cannot locate source' }
    const sourceSnap = await this.readSource(sourcePath, opts.sourceCache)
    const { deleted } = opts
    const applies = deleted && (deleted.sourcePath === undefined || deleted.sourcePath === sourcePath)
    const value = copyValue(sourceSnap, conn, applies ? deleted.onSourceDelete : 'nothing')
    return value === NOTHING ? { value, reason: 'source missing' } : { value }
  }

  /** Reads a source document, sharing reads across targets of the same page when a cache is given. */
  private readSource(path: string, cache?: Map<string, Promise<DocumentSnapshot>>): Promise<DocumentSnapshot> {
    if (!cache) return this.db().doc(path).get()
    let p = cache.get(path)
    if (!p) {
      p = this.db().doc(path).get()
      cache.set(path, p)
    }
    return p
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
      count(result, await this.syncAggregate(this.db().doc(`${targetCollection}/${id}`), rule, {}))
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
    count(result, await this.syncAggregate(this.db().doc(target.path), rule, {}))
    if (result.writes === 0) result.reason = 'target up to date'
    return result
  }

  /** Reads the target, runs the aggregation query, writes the number if it differs (conditional on the target's updateTime). */
  async syncAggregate(ref: DocumentReference, rule: ResolvedAggregate, opts: SyncOptions): Promise<Outcome> {
    const attempt = opts.attempt ?? 0
    if (attempt > this.maxRetries) throw new RetriesExhaustedError(ref.path, attempt)
    const target = opts.target && attempt === 0 ? opts.target : await ref.get()
    if (!target.exists) return 'skip'
    const { value } = await this.computeAggregate(target, rule)
    if (value === NOTHING || !needsWrite(target, rule.targetField, value)) return 'skip'
    if (opts.dryRun) return 'write'
    return this.write(ref, target, rule.targetField, value, () => this.syncAggregate(ref, rule, { ...opts, attempt: attempt + 1 }))
  }

  /** The number `rule.targetField` of `target` should hold, from an aggregation query over its sources. */
  private async computeAggregate(target: DocumentSnapshot, rule: ResolvedAggregate): Promise<{ value: Computed; reason?: string }> {
    const query = this.sourcesOf(rule, target.ref.path)
    if (!query) return { value: NOTHING, reason: 'target path does not match the rule' }
    return { value: await aggregateValue(query, rule) }
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
  static usesCollectionGroup(rule: ResolvedRule): boolean {
    return needsCollectionGroupQuery(rule)
  }

  // ---------------------------------------------------------------- views

  /** A document of one of the view's sources changed: recompute every target it belongs to. */
  async viewSource(
    view: ResolvedView,
    source: ResolvedViewSource,
    match: DocumentMatch,
    before: DecodedDocument | undefined,
    after: DecodedDocument | undefined,
  ): Promise<RuleResult> {
    const result = newResult(view, 'source')
    result.source = source.key
    if (before && after) {
      const unchanged = source.watch ? source.watch.every((f) => isEqual(getField(before.data, f), getField(after.data, f))) : isEqual(before.data, after.data)
      if (unchanged) {
        result.reason = source.watch ? 'watched fields unchanged' : 'unchanged'
        return result
      }
    }
    const change: ViewChange = { source: source.key, path: match.path, before: before?.data, after: after?.data }
    const resolvable = await this.forEachViewTarget(view, source, match, before, after, async (ref, snapshot) => {
      result.targets++
      count(result, await this.syncView(ref, view, { change, target: snapshot }))
    })
    if (!resolvable) {
      result.reason = 'target collection unresolvable'
      return result
    }
    if (result.writes === 0) result.reason = result.targets ? 'targets up to date' : 'no targets'
    return result
  }

  /** A target was created, or one of the fields pointing at a `refField` source changed: recompute it. */
  async viewTarget(
    view: ResolvedView,
    target: DocumentMatch,
    before: DecodedDocument | undefined,
    after: DecodedDocument | undefined,
  ): Promise<RuleResult> {
    const result = newResult(view, 'target')
    result.targets = 1
    if (!after) {
      result.reason = 'target deleted'
      return result
    }
    if (before) {
      const refFields = view.sources.map((s) => s.refField).filter((f): f is string => f !== undefined)
      if (refFields.every((f) => isEqual(getField(before.data, f), getField(after.data, f)))) {
        result.reason = refFields.length ? 'refFields unchanged' : 'not a create'
        return result
      }
    }
    count(result, await this.syncView(this.db().doc(target.path), view, {}))
    if (result.writes === 0) result.reason = 'target up to date'
    return result
  }

  /**
   * Reads the target, computes the value with `patch` (when a `change` is given and the view
   * defines one) or `build`, and writes it if it differs, conditional on the target's `updateTime`.
   */
  async syncView(ref: DocumentReference, view: ResolvedView, opts: SyncOptions & { change?: ViewChange }): Promise<Outcome> {
    const attempt = opts.attempt ?? 0
    if (attempt > this.maxRetries) throw new RetriesExhaustedError(ref.path, attempt)
    const target = opts.target && attempt === 0 ? opts.target : await ref.get()
    if (!target.exists) return 'skip'
    const { value } = await this.computeView(target, view, opts)
    if (value === NOTHING || !needsWrite(target, view.targetField, value)) return 'skip'
    if (opts.dryRun) return value === DELETE ? 'delete' : 'write'
    return this.write(ref, target, view.targetField, value, () => this.syncView(ref, view, { ...opts, attempt: attempt + 1 }))
  }

  /** The value `view.targetField` of `target` should hold: `patch` applied to the current value, or `build` over fresh reads. */
  private async computeView(target: DocumentSnapshot, view: ResolvedView, opts: { change?: ViewChange }): Promise<{ value: Computed; reason?: string }> {
    if (opts.change && view.patch) {
      // The event payload may be stale or duplicated; give `patch` the document as it is now (read after the target).
      const current = await this.db().doc(opts.change.path).get()
      const change: ViewChange = { ...opts.change, after: current.exists ? current.data() : undefined }
      const patched = await view.patch(target.get(view.targetField), change, { target, firestore: this.db() })
      if (patched !== undefined) return { value: patched }
    }
    const sources: Record<string, QueryDocumentSnapshot[]> = {}
    for (const source of view.sources) {
      const docs = await this.viewSourceDocs(view, source, target)
      if (docs === undefined) return { value: NOTHING, reason: `source "${source.key}" unresolvable for this target` }
      sources[source.key] = docs
    }
    const built = await view.build({ target, sources, firestore: this.db() })
    return { value: built === undefined ? DELETE : built }
  }

  /** Current documents of one source for a target: a query (`idField` / `idParam`) or the one referenced document (`refField`). */
  private async viewSourceDocs(view: ResolvedView, source: ResolvedViewSource, target: DocumentSnapshot): Promise<QueryDocumentSnapshot[] | undefined> {
    const m = matchDocumentPath(view.targetPattern, target.ref.path)
    if (!m) return undefined
    if (source.refField !== undefined) {
      const id: unknown = target.get(source.refField)
      if (id === undefined || id === null || id === '') return []
      if (typeof id !== 'string' || id.includes('/')) {
        this.logger.warn('doc-sync: refField is not a document id, treated as unset', { rule: view.name, document: target.ref.path, refField: source.refField })
        return []
      }
      const collection = resolveCollectionPath(source.pattern, m.params)
      if (!collection) return undefined
      const snap = await this.db().doc(`${collection}/${id}`).get()
      return snap.exists ? [snap as QueryDocumentSnapshot] : []
    }
    let query: Query
    if (source.idParam !== undefined) {
      const concrete = resolveCollectionPath(source.pattern, { ...m.params, [source.idParam]: m.id })
      if (!concrete) return undefined
      query = this.db().collection(concrete)
    } else {
      const concrete = resolveCollectionPath(source.pattern, m.params)
      const base = concrete ? this.db().collection(concrete) : this.db().collectionGroup(source.pattern.collectionId)
      query = base.where(source.idField!, '==', m.id)
    }
    for (const o of source.orderBy) query = query.orderBy(o.field, o.direction)
    if (source.limit !== undefined) query = query.limit(source.limit)
    // A collection group may include same-named collections elsewhere; those are filtered out,
    // and with `limit` we keep paging until enough matching documents are found.
    const out: QueryDocumentSnapshot[] = []
    let last: QueryDocumentSnapshot | undefined
    for (;;) {
      const snap = await (last ? query.startAfter(last) : query).get()
      for (const d of snap.docs) if (matchDocumentPath(source.pattern, d.ref.path) && this.sourceBelongsTo(source, m, d.ref.path)) out.push(d)
      if (source.limit === undefined || out.length >= source.limit || snap.size < source.limit) break
      last = snap.docs[snap.docs.length - 1]
    }
    return source.limit === undefined ? out : out.slice(0, source.limit)
  }

  /** For collection-group results: keep only sources whose path params agree with the target's. */
  private sourceBelongsTo(source: ResolvedViewSource, target: DocumentMatch, sourcePath: string): boolean {
    const sm = matchDocumentPath(source.pattern, sourcePath)
    if (!sm) return false
    return Object.entries(target.params).every(([k, v]) => sm.params[k] === undefined || sm.params[k] === v)
  }

  /**
   * Runs `fn` for every target to recompute after a source document changed. Returns false
   * when the target collection cannot be resolved from the source path. `refField` sources
   * fan out to a query, processed page by page with bounded parallelism; the page's snapshots
   * are passed along so the first attempt needs no extra read.
   */
  private async forEachViewTarget(
    view: ResolvedView,
    source: ResolvedViewSource,
    match: DocumentMatch,
    before: DecodedDocument | undefined,
    after: DecodedDocument | undefined,
    fn: (ref: DocumentReference, snapshot?: DocumentSnapshot) => Promise<void>,
  ): Promise<boolean> {
    const firestore = this.db()
    if (source.refField !== undefined) {
      const concrete = resolveCollectionPath(view.targetPattern, match.params)
      const base = concrete ? firestore.collection(concrete) : firestore.collectionGroup(view.targetPattern.collectionId)
      const query = base.where(source.refField, '==', match.id).limit(this.pageSize)
      let last: DocumentSnapshot | undefined
      for (;;) {
        const page = await (last ? query.startAfter(last) : query).get()
        const docs = page.docs.filter((d) => {
          const tm = matchDocumentPath(view.targetPattern, d.ref.path)
          return tm !== undefined && Object.entries(match.params).every(([k, v]) => tm.params[k] === undefined || tm.params[k] === v)
        })
        await forEachLimit(docs, VIEW_FANOUT_CONCURRENCY, (d) => fn(d.ref, d))
        if (page.size < this.pageSize) break
        last = page.docs[page.docs.length - 1]
      }
      return true
    }
    const ids = new Set<string>()
    for (const doc of [before, after]) {
      if (!doc) continue
      const id = source.idField !== undefined ? getField(doc.data, source.idField) : match.params[source.idParam!]
      if (typeof id === 'string' && id !== '' && !id.includes('/')) ids.add(id)
    }
    const targetCollection = resolveCollectionPath(view.targetPattern, match.params)
    if (!targetCollection) return false
    for (const id of ids) await fn(firestore.doc(`${targetCollection}/${id}`))
    return true
  }
}

/** Targets of one view source change recomputed in parallel (each one reads its own sources). */
const VIEW_FANOUT_CONCURRENCY = 10

async function aggregateValue(query: Query, rule: ResolvedAggregate): Promise<number> {
  if (rule.aggregate === 'count') {
    const snap = await query.count().get()
    return snap.data().count
  }
  const snap = await query.aggregate({ total: AggregateField.sum(rule.aggregate.sum) }).get()
  const total = snap.data().total
  return typeof total === 'number' ? total : Number(total ?? 0)
}

function newResult(rule: ResolvedRule, role: RuleResult['role']): RuleResult {
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
