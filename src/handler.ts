/**
 * HTTP handler for Eventarc Firestore events.
 *
 * Event payloads are only used to decide whether work is needed. The values
 * written to targets are always re-read from Firestore (or recomputed with an
 * aggregation query), and every write is conditional on the target's `updateTime`
 * observed before the source was read.
 */
import type { DocumentData, DocumentReference, DocumentSnapshot, Firestore, Query, QueryDocumentSnapshot, Timestamp } from 'firebase-admin/firestore'
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
  scheduleQueueName,
  serviceAccountEmail,
  type ViewChange,
} from './config.js'
import { DecodeError, decodeDocumentEventData, type DecodedDocument } from './decode.js'
import { isEqual } from './equal.js'
import { getField, isValidFieldPath, setField } from './fields.js'
import { countingFirestore, ReadCounter, type ReadCounts } from './counter.js'
import { jsonLogger, type Logger } from './logger.js'
import { type DocumentMatch, isValidDocumentId, matchDocumentPath, resolveCollectionPath } from './paths.js'
import { forEachLimit } from './walk.js'
import { rebuild } from './rebuild.js'
import { SourceCache } from './source-cache.js'
import {
  continuationRunId,
  createCloudTasksEnqueuer,
  deferBucket,
  deferTaskId,
  enqueueWithRetry,
  parseContinuationBody,
  type ContinuationTask,
  type DirtyUnit,
  type Enqueue,
} from './schedule.js'

export interface DocSyncHandlerOptions {
  /** Firestore instance to use. Defaults to `getFirestore()` (or `getFirestore(database)` for a named database). */
  firestore?: Firestore
  /** Defaults to a structured JSON logger. `console` and `firebase-functions/logger` work too. */
  logger?: Logger
  /** How many times to redo a target whose conditional write failed. Default 5. */
  maxRetries?: number
  /** Page size for the target query (`where idField == sourceId`). Default 500. */
  pageSize?: number
  /** Scheduled runs (`/schedule/<rule>`). The route does no authentication of its own; restrict invocation with Cloud Run IAM (`invoker`) as for events. */
  schedule?: {
    /**
     * Stop at the next page boundary after this long; default 20 minutes (Cloud Scheduler waits at most 30).
     * The function's `timeoutSeconds` must exceed this budget (see the reference's recommended function settings).
     */
    budgetMs?: number
    /** Targets processed in parallel within a page. Default 20. */
    concurrency?: number
    /** GCP project of the Cloud Tasks queue. Default: `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT`, else the Firestore client's project. */
    project?: string
    /** Public URL of this service (`https://…run.app`), used for the continuation task. Default: `https://<host header>`. */
    serviceUrl?: string
    /** Replaces the Cloud Tasks call (tests, emulator, other platforms). Receives the fully built task. */
    enqueue?: Enqueue
    /** Set to `false` to never enqueue a continuation (the run then stops on its budget as in 0.9). Default `true`. */
    continue?: boolean
  }
}

/** Request shape accepted by the handler. Express / firebase-functions requests satisfy it. */
export interface DocSyncRequest {
  headers: Record<string, string | string[] | undefined>
  /**
   * Request URL (path and query), as Express / Node provide it. `/schedule/<rule>` runs that rule's
   * scheduled sync. The route does no authentication of its own; restrict invocation with Cloud Run
   * IAM (`invoker`) as for events.
   */
  url?: string
  /** HTTP method, when the framework provides it. */
  method?: string
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
  setHeader?(name: string, value: string): unknown
}

export type DocSyncHandler = (req: DocSyncRequest, res: DocSyncResponse) => Promise<void>

/** Result of processing one rule for one event. Read counts follow Firestore billing (see {@link ReadCounts}). */
export interface RuleResult extends ReadCounts {
  rule: string
  kind: 'connection' | 'aggregate' | 'view' | 'projection'
  role: 'source' | 'target'
  /** Key of the matched view source (views, role `source`). */
  source?: string
  /** What happened: field write, field deletion, target document created, target document removed, or nothing. */
  action: Outcome
  /** Why nothing was written (only for `skip`). */
  reason?: string
  /** Number of target documents inspected. */
  targets: number
  /** Number of documents written. */
  writes: number
  /** Number of conditional writes that failed and were redone. */
  retries: number
  /** Number of dirty units enqueued (only for `action: 'defer'`). */
  deferred?: number
}

const DELETE = Symbol('FieldValue.delete')
const NOTHING = Symbol('nothing')
/** A value to store in the target field, or `DELETE` for "the field must be absent". */
type Desired = unknown
type Computed = Desired | typeof NOTHING
export type Outcome = 'skip' | 'write' | 'delete' | 'create' | 'remove' | 'defer'

/** Marks one dirty unit instead of recomputing it now; the handler enqueues a Cloud Tasks task that flushes it later. */
type DeferSink = (unit: DirtyUnit) => Promise<void>

/** Options for the per-event processing methods: a shared read cache and, for a deferred rule, the sink that marks a unit dirty instead of recomputing it now. */
interface ProcessOptions {
  cache?: SourceCache
  defer?: DeferSink
}

/** One field whose current value differs from what the rule computes. */
export interface FieldMismatch {
  field: string
  /** Current value (`undefined` when absent). */
  actual: unknown
  /** Value the field should hold (`undefined` when it should be absent). */
  expected: unknown
}

/** Result of comparing one target with what its sources say it should hold. */
export interface CheckResult {
  /** `ok`: up to date. `mismatch`: differs. `skip`: nothing to check (target missing, idField not a string, ...). */
  status: 'ok' | 'mismatch' | 'skip'
  reason?: string
  /** For `mismatch`: `value` (fields differ), `missing` (base exists, target does not), `orphan` (target exists, base does not). */
  issue?: 'value' | 'missing' | 'orphan'
  /** For `value` / `missing`: the differing fields. */
  fields?: FieldMismatch[]
}

/** Options for {@link Processor.check}. */
export interface CheckOptions {
  /** Shares source reads between targets (within one page of `verify`, or one event). */
  sourceCache?: SourceCache
  /** Receives the reads issued. */
  counter?: ReadCounter
  /** Already-read base snapshot to use for the first attempt instead of reading again (views with `base`). */
  base?: DocumentSnapshot
  /** Views with `base`: only remove the target when its base is gone; do nothing when the base exists (second pass of `rebuild` / `verify`). */
  orphansOnly?: boolean
}

/** Options shared by {@link Processor.syncCopy} and {@link Processor.syncAggregate}. */
export interface SyncOptions {
  /** 0 (default) for a first try; redos count from 1. */
  attempt?: number
  /** Already-read target snapshot to use for the first attempt instead of reading again. */
  target?: DocumentSnapshot
  /** Compute and compare only; report what would be written without writing. */
  dryRun?: boolean
  /** Shares source reads between targets (within one page of `rebuild`, or one event). */
  sourceCache?: SourceCache
  /** Receives the reads issued. */
  counter?: ReadCounter
  /** Views with `base`: only remove the target when its base is gone; do nothing when the base exists (second pass of `rebuild` / `verify`). */
  orphansOnly?: boolean
}

export interface DeletedSource {
  /** Path of the deleted source. Omit to apply `onSourceDelete` to every missing source (`rebuild`). */
  sourcePath?: string
  onSourceDelete: ResolvedConnection['onSourceDelete']
}

const GRPC_FAILED_PRECONDITION = 9
const GRPC_NOT_FOUND = 5
const GRPC_ALREADY_EXISTS = 6
const FIRESTORE_EVENT_TYPE_PREFIX = 'google.cloud.firestore.document.v1.'
/** Eventarc payloads hold at most two 1 MiB documents; anything far beyond that is not a Firestore event. */
const MAX_BODY_BYTES = 16 * 1024 * 1024

export class RetriesExhaustedError extends Error {
  constructor(path: string, attempts: number) {
    super(`conditional write for ${path} still failing after ${attempts} attempts`)
    this.name = 'RetriesExhaustedError'
  }
}

export const DEFAULT_SCHEDULE_BUDGET_MS = 20 * 60_000

/** `/schedule/<rule>` → the rule name (URL-decoded); a query string and a trailing slash are ignored. `undefined` for any other path. */
export function scheduledRuleFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  const path = url.split('?')[0]!.replace(/\/+$/, '')
  const m = /^\/schedule\/([^/]+)$/.exec(path)
  if (!m) return undefined
  try {
    return decodeURIComponent(m[1]!)
  } catch {
    return m[1]!
  }
}

function respondJson(res: DocSyncResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.setHeader?.('content-type', 'application/json')
  if (typeof res.status === 'function') {
    const r = res.status(code) as DocSyncResponse | undefined
    const target = r && typeof r === 'object' ? r : res
    if (typeof target.send === 'function') target.send(text)
    else if (typeof target.end === 'function') target.end(text)
    return
  }
  res.statusCode = code
  if (typeof res.end === 'function') res.end(text)
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
  const eventRules = rules.filter((r) => r.scheduled === undefined)
  const enqueue: Enqueue = options.schedule?.enqueue ?? createCloudTasksEnqueuer()

  function scheduleProject(): string | undefined {
    const configured = options.schedule?.project ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT
    if (configured !== undefined) return configured
    // `projectId` is an undocumented getter of the Firestore client; it throws when the client is not initialised.
    try {
      return (db() as unknown as { projectId?: string }).projectId
    } catch {
      return undefined
    }
  }

  function serviceUrlFrom(req: DocSyncRequest): string | undefined {
    if (options.schedule?.serviceUrl) return options.schedule.serviceUrl.replace(/\/+$/, '')
    const host = header(req, 'host')
    return host ? `https://${host}` : undefined
  }

  /** `undefined` for a rule without `deferred`; otherwise a sink that enqueues a Cloud Tasks task flushing `unit` at the end of its bucket. A rejected enqueue throws, so the rule's own task rejects and the event is retried. */
  function deferSinkFor(rule: ResolvedRule, req: DocSyncRequest): DeferSink | undefined {
    if (!rule.deferred) return undefined
    const everyMs = rule.deferred.everyMs
    return async (unit: DirtyUnit) => {
      const project = scheduleProject()
      const serviceUrl = serviceUrlFrom(req)
      if (!project || !serviceUrl) throw new Error('cannot enqueue: project or service URL unknown')
      const { bucket, scheduleTime } = deferBucket(everyMs)
      const task: ContinuationTask = {
        id: deferTaskId(rule.name, bucket, unit),
        rule: rule.name,
        url: `${serviceUrl}/schedule/${encodeURIComponent(rule.name)}`,
        body: { flush: unit },
        scheduleTime,
        serviceAccountEmail: serviceAccountEmail(resolved, project),
        audience: serviceUrl,
        queue: { project, location: resolved.serviceRegion, name: scheduleQueueName(resolved.name) },
      }
      await enqueueWithRetry(enqueue, task)
      logger.info('doc-sync: deferred', { rule: rule.name, unit: unit.unit, path: unit.path, task: task.id })
    }
  }

  /** Flushes one dirty unit of a deferred rule: recomputes it now and answers with the result. */
  async function runFlush(rule: ResolvedRule, flush: DirtyUnit, name: string, startedAt: number, res: DocSyncResponse): Promise<void> {
    try {
      let result: RuleResult
      if (flush.unit === 'target') {
        result = newResult(rule, 'target')
        result.targets = 1
        const counter = new ReadCounter()
        count(result, await processor.sync(db().doc(flush.path), rule, { counter }))
        if (result.writes === 0) result.reason = 'target up to date'
        finish(result, counter)
      } else if (rule.kind === 'connection') {
        const match = matchDocumentPath(rule.sourcePattern, flush.path)
        if (!match) return respondJson(res, 400, { error: 'flush path does not match this rule' })
        result = await processor.connectionSource(rule, match, undefined, undefined, {})
      } else if (rule.kind === 'view') {
        let match: DocumentMatch | undefined
        let foundSource: ResolvedViewSource | undefined
        for (const s of rule.sources) {
          if (s.refField === undefined) continue
          const m = matchDocumentPath(s.pattern, flush.path)
          if (m) {
            match = m
            foundSource = s
            break
          }
        }
        if (!match || !foundSource) return respondJson(res, 400, { error: 'no refField source matches this flush path' })
        result = await processor.viewSource(rule, foundSource, match, undefined, undefined, {})
      } else {
        return respondJson(res, 400, { error: `rule "${name}" has no source unit to flush` })
      }
      return respondJson(res, 200, { ...result, flush, durationMs: Date.now() - startedAt })
    } catch (err) {
      logger.error('doc-sync schedule: flush failed', { rule: name, flush, error: err })
      return respondJson(res, 500, { error: 'flush failed' })
    }
  }

  async function runScheduled(name: string, req: DocSyncRequest, res: DocSyncResponse): Promise<void> {
    const startedAt = Date.now()
    const rule = rules.find((r) => r.name === name)
    if (!rule) {
      logger.warn('doc-sync schedule: unknown or unscheduled rule', { rule: name })
      return respondJson(res, 404, { error: `no scheduled rule "${name}"` })
    }
    let cont: ReturnType<typeof parseContinuationBody> = {}
    try {
      cont = parseContinuationBody(await readBody(req))
    } catch {
      cont = {}
    }
    if (rule.deferred) {
      const flush = cont.flush
      if (!flush) return respondJson(res, 400, { error: 'deferred rules need a flush body' })
      return runFlush(rule, flush, name, startedAt, res)
    }
    if (cont.flush) {
      logger.warn('doc-sync schedule: flush body for a non-deferred rule', { rule: name })
      return respondJson(res, 404, { error: `no scheduled rule "${name}"` })
    }
    if (!rule.scheduled) {
      logger.warn('doc-sync schedule: unknown or unscheduled rule', { rule: name })
      return respondJson(res, 404, { error: `no scheduled rule "${name}"` })
    }
    const runId = continuationRunId(cont.runId, header(req, 'x-cloudscheduler-scheduletime'))
    const chunk = cont.chunk ?? 0
    const passStartedAt = cont.startedAt ?? new Date(startedAt).toISOString()
    try {
      const [result] = await rebuild(resolved, {
        firestore: db(),
        logger,
        rules: [name],
        startAfter: cont.startAfter,
        pageSize: options.pageSize ?? 500,
        concurrency: options.schedule?.concurrency,
        maxRetries: options.maxRetries ?? 5,
        budgetMs: options.schedule?.budgetMs ?? DEFAULT_SCHEDULE_BUDGET_MS,
      })
      let continued = false
      if (!result!.completed && result!.lastPath && options.schedule?.continue !== false) {
        const project = scheduleProject()
        const serviceUrl = serviceUrlFrom(req)
        if (!project || !serviceUrl) {
          logger.error('doc-sync schedule: could not enqueue continuation; the next scheduled run starts over', { rule: name, runId, chunk, reason: !project ? 'project unknown' : 'service URL unknown' })
        } else {
          const task: ContinuationTask = {
            id: `${name}-${runId}-${chunk + 1}`,
            rule: name,
            url: `${serviceUrl}/schedule/${encodeURIComponent(name)}`,
            body: { startAfter: result!.lastPath, runId, chunk: chunk + 1, startedAt: passStartedAt },
            serviceAccountEmail: serviceAccountEmail(resolved, project),
            audience: serviceUrl,
            queue: { project, location: resolved.serviceRegion, name: scheduleQueueName(resolved.name) },
          }
          try {
            await enqueueWithRetry(enqueue, task)
            continued = true
            logger.info('doc-sync schedule: continuation enqueued', { rule: name, runId, chunk: chunk + 1, startAfter: result!.lastPath, task: task.id })
          } catch (err) {
            logger.error('doc-sync schedule: could not enqueue continuation; the next scheduled run starts over', { rule: name, runId, chunk, error: err })
          }
        }
      }
      const body = {
        rule: name,
        runId,
        chunk,
        scanned: result!.scanned,
        written: result!.written,
        completed: result!.completed,
        continued,
        lastPath: result!.lastPath,
        reads: result!.reads,
        queries: result!.queries,
        aggregations: result!.aggregations,
        durationMs: Date.now() - startedAt,
      }
      if (!result!.completed) logger.warn('doc-sync schedule: budget exceeded, run stopped early', body)
      logger.info('doc-sync schedule: run', body)
      return respondJson(res, 200, body)
    } catch (err) {
      // Chunk 0 is the Scheduler's own call, retried by Cloud Scheduler; a later chunk is delivered
      // by the continuation task, retried by Cloud Tasks instead.
      const message = chunk === 0 ? 'doc-sync schedule: run failed, will be retried by Cloud Scheduler' : 'doc-sync schedule: continuation chunk failed, will be retried by Cloud Tasks'
      logger.error(message, { rule: name, runId, chunk, error: err })
      return respondJson(res, 500, { error: 'run failed', runId, chunk })
    }
  }

  return async function docSyncHandler(req, res) {
    const scheduledName = scheduledRuleFromUrl(req.url)
    if (scheduledName !== undefined) {
      if (req.method !== undefined && req.method !== 'POST') return respondJson(res, 405, { error: 'use POST' })
      return runScheduled(scheduledName, req, res)
    }

    const startedAt = Date.now()
    const eventId = header(req, 'ce-id')
    const eventType = header(req, 'ce-type')

    if (eventType !== undefined && !eventType.startsWith(FIRESTORE_EVENT_TYPE_PREFIX)) {
      logger.warn('doc-sync: not a Firestore document event, ignored', { eventId, eventType })
      return respond(res, 204)
    }

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

    // Shares single-document reads across the rules processing this event, never older than the target that reads them.
    const cache = new SourceCache(db)
    type Task = { rule: string; run: () => Promise<RuleResult> }
    const parallel: Task[] = []
    const onSameDoc: Task[] = []
    const { before, after } = event
    for (const rule of eventRules) {
      const opts: ProcessOptions = { cache, defer: deferSinkFor(rule, req) }
      if (rule.kind === 'view') {
        if (rule.basePattern) {
          const asBase = matchDocumentPath(rule.basePattern, document)
          if (asBase) parallel.push({ rule: rule.name, run: () => processor.viewBase(rule, asBase, before, after, opts) })
        }
        for (const source of rule.sources) {
          const asSource = matchDocumentPath(source.pattern, document)
          if (asSource) parallel.push({ rule: rule.name, run: () => processor.viewSource(rule, source, asSource, before, after, opts) })
        }
      } else {
        const asSource = matchDocumentPath(rule.sourcePattern, document)
        if (asSource) {
          parallel.push({
            rule: rule.name,
            run: () =>
              rule.kind === 'connection'
                ? processor.connectionSource(rule, asSource, before, after, opts)
                : processor.aggregateSource(rule, asSource, before, after, opts),
          })
        }
      }
      const asTarget = matchDocumentPath(rule.targetPattern, document)
      if (asTarget) {
        onSameDoc.push({
          rule: rule.name,
          run: () =>
            rule.kind === 'connection'
              ? processor.connectionTarget(rule, asTarget, before, after, opts)
              : rule.kind === 'aggregate'
                ? processor.aggregateTarget(rule, asTarget, before, after, opts)
                : processor.viewTarget(rule, asTarget, before, after, opts),
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
    if (rule.kind === 'view') return this.checkView(target, rule, opts)
    if (!target.exists) return { status: 'skip', reason: 'target missing' }
    const counter = opts.counter ?? new ReadCounter()
    const computed =
      rule.kind === 'connection'
        ? await this.computeCopy(target, rule, { sourceCache: opts.sourceCache, counter, deleted: { onSourceDelete: rule.onSourceDelete } })
        : await this.computeAggregate(target, rule, counter)
    if (computed.value === NOTHING) return { status: 'skip', reason: computed.reason }
    return checkPlan(target, new Map([[rule.targetField, computed.value]]))
  }

  private async checkView(target: DocumentSnapshot, view: ResolvedView, opts: CheckOptions): Promise<CheckResult> {
    const counter = opts.counter ?? new ReadCounter()
    let base: DocumentSnapshot | undefined
    if (view.basePattern) {
      base = await this.readBase(target.ref.path, view, { base: opts.base, sourceCache: opts.sourceCache, notBefore: target.readTime }, counter)
      if (!base) return { status: 'skip', reason: 'base unresolvable' }
      if (!base.exists) return target.exists ? { status: 'mismatch', issue: 'orphan' } : { status: 'skip', reason: 'base and target missing' }
      if (opts.orphansOnly) return { status: 'ok' }
    } else if (!target.exists) return { status: 'skip', reason: 'target missing' }
    const { plan, reason } = await this.computeView(target, view, { counter, base, sourceCache: opts.sourceCache })
    if (plan === NOTHING) return { status: 'skip', reason }
    if (!target.exists) {
      const fields: FieldMismatch[] = [...plan].filter(([, d]) => d !== DELETE).map(([field, expected]) => ({ field, actual: undefined, expected }))
      return { status: 'mismatch', issue: 'missing', fields }
    }
    return checkPlan(target, plan)
  }

  /**
   * Applies `updates` (field path → value or `FieldValue.delete()`) to `ref` conditional on the
   * `updateTime` of `target`, the snapshot the values were computed from. On a failed
   * precondition `redo` runs the whole read-compute-write again.
   */
  private async write(ref: DocumentReference, target: DocumentSnapshot, updates: Record<string, unknown>, outcome: Outcome, redo: () => Promise<Outcome>): Promise<Outcome> {
    try {
      await ref.update(updates, { lastUpdateTime: target.updateTime })
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
    opts: ProcessOptions = {},
  ): Promise<RuleResult> {
    const result = newResult(conn, 'source')
    if (before && after && conn.fields.every((f) => isEqual(getField(before.data, f), getField(after.data, f)))) {
      result.reason = 'fields unchanged'
      return result
    }
    if (opts.defer) return deferOne(result, opts.defer, { unit: 'source', path: source.path })

    const counter = new ReadCounter()
    const firestore = this.db()
    const query = this.targetsOf(conn, source).limit(this.pageSize)
    const writer = firestore.bulkWriter()
    const pending: Promise<void>[] = []
    const retry: DocumentReference[] = []
    const failures: unknown[] = []
    let last: DocumentSnapshot | undefined

    try {
      for (;;) {
        const page = await (last ? query.startAfter(last) : query).get()
        counter.query(page.size)
        if (page.empty) break
        const docs = page.docs.filter((d) => this.belongsTo(conn, source, d.ref.path))
        result.targets += docs.length

        // Read the source only after the targets, so a stale source value can never pass the precondition.
        const sourceSnap = await this.readSource(source.path, counter, opts.cache, page.readTime)
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
    } finally {
      await writer.close()
    }
    await Promise.all(pending)
    if (failures.length) throw failures[0]

    for (const ref of retry) {
      result.retries++
      count(result, await this.syncCopy(ref, conn, { deleted: { sourcePath: source.path, onSourceDelete: conn.onSourceDelete }, attempt: 1, counter }))
    }
    if (result.writes === 0 && !result.reason) result.reason = result.targets ? 'targets up to date' : 'no targets'
    return finish(result, counter)
  }

  /** 5.3: the changed document is a target of `conn`. */
  async connectionTarget(
    conn: ResolvedConnection,
    target: DocumentMatch,
    before: DecodedDocument | undefined,
    after: DecodedDocument | undefined,
    opts: ProcessOptions = {},
  ): Promise<RuleResult> {
    const result = newResult(conn, 'target')
    result.targets = 1
    if (!after) {
      result.reason = 'target deleted'
      return result
    }
    if (before && !fieldRemoved(before, after, conn.targetField) && isEqual(getField(before.data, conn.idField), getField(after.data, conn.idField))) {
      result.reason = 'idField unchanged'
      return result
    }
    // A create (no `before`) gives the target its initial value immediately, same as without defer; only an update to an existing target defers.
    if (before && opts.defer) return deferOne(result, opts.defer, { unit: 'target', path: target.path })
    const counter = new ReadCounter()
    count(result, await this.syncCopy(this.db().doc(target.path), conn, { counter, deleted: { onSourceDelete: conn.onSourceDelete }, sourceCache: opts.cache }))
    if (result.writes === 0) result.reason = 'target up to date'
    return finish(result, counter)
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
    const counter = opts.counter ?? new ReadCounter()
    const target = await this.readTarget(ref, opts, counter)
    if (!target.exists) return 'skip'
    const { value } = await this.computeCopy(target, conn, { ...opts, counter })
    if (value === NOTHING) return 'skip'
    const { updates, outcome } = planUpdates(target, new Map([[conn.targetField, value]]))
    if (outcome === 'skip') return 'skip'
    if (opts.dryRun) return outcome
    return this.write(ref, target, updates, outcome, () => this.syncCopy(ref, conn, { ...opts, counter, attempt: attempt + 1, sourceCache: undefined }))
  }

  /** The target for this attempt: the caller's snapshot on a first try, else a fresh (counted) read. */
  private async readTarget(ref: DocumentReference, opts: SyncOptions, counter: ReadCounter): Promise<DocumentSnapshot> {
    if (opts.target && (opts.attempt ?? 0) === 0) return opts.target
    counter.doc()
    return ref.get()
  }

  /** The value `conn.targetField` of `target` should hold, read from the source it points at. */
  private async computeCopy(
    target: DocumentSnapshot,
    conn: ResolvedConnection,
    opts: { sourceCache?: SourceCache; deleted?: DeletedSource; counter: ReadCounter },
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
    const sourceSnap = await this.readSource(sourcePath, opts.counter, opts.sourceCache, target.readTime)
    const { deleted } = opts
    const applies = deleted && (deleted.sourcePath === undefined || deleted.sourcePath === sourcePath)
    const value = copyValue(sourceSnap, conn, applies ? deleted.onSourceDelete : 'nothing')
    return value === NOTHING ? { value, reason: 'source missing' } : { value }
  }

  /** Reads a source document, sharing reads across targets of the same page/request when a cache is given, never older than `notBefore` (only actual reads are counted). */
  private readSource(path: string, counter: ReadCounter, cache: SourceCache | undefined, notBefore: Timestamp): Promise<DocumentSnapshot> {
    return cache ? cache.get(path, counter, notBefore) : (counter.doc(), this.db().doc(path).get())
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
    if (!collection || !isValidDocumentId(currentId)) {
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
    opts: ProcessOptions = {},
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
      if (typeof id === 'string' && isValidDocumentId(id)) ids.add(id)
    }
    const targetCollection = resolveCollectionPath(rule.targetPattern, source.params)
    if (!targetCollection) {
      result.reason = 'target collection unresolvable'
      return result
    }
    if (opts.defer) return deferUnits(result, opts.defer, [...ids].map((id) => ({ unit: 'target', path: `${targetCollection}/${id}` })))
    const counter = new ReadCounter()
    for (const id of ids) {
      result.targets++
      count(result, await this.syncAggregate(this.db().doc(`${targetCollection}/${id}`), rule, { counter, sourceCache: opts.cache }))
    }
    if (result.writes === 0) result.reason = result.targets ? 'targets up to date' : 'no target id'
    return finish(result, counter)
  }

  /** A target was created: give it its initial value. Other target changes are ignored. */
  async aggregateTarget(
    rule: ResolvedAggregate,
    target: DocumentMatch,
    before: DecodedDocument | undefined,
    after: DecodedDocument | undefined,
    opts: ProcessOptions = {},
  ): Promise<RuleResult> {
    const result = newResult(rule, 'target')
    result.targets = 1
    if (!after) {
      result.reason = 'target deleted'
      return result
    }
    if (before && !fieldRemoved(before, after, rule.targetField)) {
      result.reason = 'not a create'
      return result
    }
    // A create (no `before`) gives the target its initial value immediately, same as without defer; only a field re-added to an existing target defers.
    if (before && opts.defer) return deferOne(result, opts.defer, { unit: 'target', path: target.path })
    const counter = new ReadCounter()
    count(result, await this.syncAggregate(this.db().doc(target.path), rule, { counter, sourceCache: opts.cache }))
    if (result.writes === 0) result.reason = 'target up to date'
    return finish(result, counter)
  }

  /** Reads the target, runs the aggregation query, writes the number if it differs (conditional on the target's updateTime). */
  async syncAggregate(ref: DocumentReference, rule: ResolvedAggregate, opts: SyncOptions): Promise<Outcome> {
    const attempt = opts.attempt ?? 0
    if (attempt > this.maxRetries) throw new RetriesExhaustedError(ref.path, attempt)
    const counter = opts.counter ?? new ReadCounter()
    const target = await this.readTarget(ref, opts, counter)
    if (!target.exists) return 'skip'
    const { value } = await this.computeAggregate(target, rule, counter)
    if (value === NOTHING) return 'skip'
    const { updates, outcome } = planUpdates(target, new Map([[rule.targetField, value]]))
    if (outcome === 'skip') return 'skip'
    if (opts.dryRun) return outcome
    return this.write(ref, target, updates, outcome, () => this.syncAggregate(ref, rule, { ...opts, counter, attempt: attempt + 1 }))
  }

  /** The number `rule.targetField` of `target` should hold, from an aggregation query over its sources. */
  private async computeAggregate(target: DocumentSnapshot, rule: ResolvedAggregate, counter: ReadCounter): Promise<{ value: Computed; reason?: string }> {
    const query = this.sourcesOf(rule, target.ref.path)
    if (!query) return { value: NOTHING, reason: 'target path does not match the rule' }
    counter.aggregation()
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
    opts: ProcessOptions = {},
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
    if (opts.defer) {
      if (source.refField !== undefined) return deferOne(result, opts.defer, { unit: 'source', path: match.path })
      const { targetCollection, ids } = this.viewTargetIdsFor(view, source, match, before, after)
      if (!targetCollection) {
        result.reason = 'target collection unresolvable'
        return result
      }
      return deferUnits(result, opts.defer, [...ids].map((id) => ({ unit: 'target', path: `${targetCollection}/${id}` })))
    }
    const change: ViewChange = { source: source.key, path: match.path, before: before?.data, after: after?.data }
    const counter = new ReadCounter()
    const resolvable = await this.forEachViewTarget(view, source, match, before, after, counter, async (ref, snapshot, changeCache) => {
      result.targets++
      count(result, await this.syncView(ref, view, { change, target: snapshot, counter, changeCache, sourceCache: opts.cache }))
    })
    if (!resolvable) {
      result.reason = 'target collection unresolvable'
      return finish(result, counter)
    }
    if (result.writes === 0) result.reason = result.targets ? 'targets up to date' : 'no targets'
    return finish(result, counter)
  }

  /** A target was created, or one of the fields pointing at a `refField` source changed: recompute it. */
  async viewTarget(
    view: ResolvedView,
    target: DocumentMatch,
    before: DecodedDocument | undefined,
    after: DecodedDocument | undefined,
    opts: ProcessOptions = {},
  ): Promise<RuleResult> {
    const result = newResult(view, 'target')
    result.targets = 1
    if (!after && !view.basePattern) {
      result.reason = 'target deleted'
      return result
    }
    if (!after) {
      // The target of a base view was deleted by hand: recreate it while the base exists. Stays immediate under defer.
      const counter = new ReadCounter()
      count(result, await this.syncView(this.db().doc(target.path), view, { counter, sourceCache: opts.cache }))
      if (result.writes === 0) result.reason = 'nothing to recreate (base missing or unresolvable)'
      return finish(result, counter)
    }
    if (before && !view.targetFields.some((f) => fieldRemoved(before, after, f))) {
      const refFields = view.sources.map((s) => s.refField).filter((f): f is string => f !== undefined)
      if (refFields.every((f) => isEqual(getField(before.data, f), getField(after.data, f)))) {
        result.reason = refFields.length ? 'refFields unchanged' : 'not a create'
        return result
      }
    }
    // A create (no `before`) writes the target immediately, same as without defer; only an update to an existing target defers.
    if (before && opts.defer) return deferOne(result, opts.defer, { unit: 'target', path: target.path })
    const counter = new ReadCounter()
    count(result, await this.syncView(this.db().doc(target.path), view, { counter, sourceCache: opts.cache }))
    if (result.writes === 0) result.reason = 'target up to date'
    return finish(result, counter)
  }

  /** The base document of a view changed: the target with the same ID is created, updated or removed. */
  async viewBase(
    view: ResolvedView,
    match: DocumentMatch,
    before: DecodedDocument | undefined,
    after: DecodedDocument | undefined,
    opts: ProcessOptions = {},
  ): Promise<RuleResult> {
    const result = newResult(view, 'source')
    result.source = 'base'
    if (before && after && isEqual(before.data, after.data)) {
      result.reason = 'unchanged'
      return result
    }
    const collection = resolveCollectionPath(view.targetPattern, match.params)
    if (!collection) {
      result.reason = 'target collection unresolvable'
      return result
    }
    result.targets = 1
    // Create/delete (the target's lifecycle) stays immediate; only an update of an existing base defers.
    if (before && after && opts.defer) {
      const targetPath = targetPathForBase(view, match.path) ?? `${collection}/${match.id}`
      return deferOne(result, opts.defer, { unit: 'target', path: targetPath })
    }
    const counter = new ReadCounter()
    count(result, await this.syncView(this.db().doc(`${collection}/${match.id}`), view, { counter, sourceCache: opts.cache }))
    // `after` missing means the base was just deleted: a skip there means the target was already absent, not that it is up to date.
    if (result.writes === 0) result.reason = after ? 'target up to date' : 'target already absent'
    return finish(result, counter)
  }

  /** The base for this attempt: `opts.base` on a first try when given (`checkView` only), else a fresh (counted) read. `undefined` when the target path does not match the view. */
  private async readBase(
    targetPath: string,
    view: ResolvedView,
    opts: { base?: DocumentSnapshot; attempt?: number; sourceCache?: SourceCache; notBefore: Timestamp },
    counter: ReadCounter,
  ): Promise<DocumentSnapshot | undefined> {
    if (opts.base && (opts.attempt ?? 0) === 0) return opts.base
    const path = basePathForTarget(view, targetPath)
    if (!path) {
      this.logger.warn('doc-sync: cannot locate base for target, skipped', { rule: view.name, document: targetPath })
      return undefined
    }
    return this.readSource(path, counter, opts.sourceCache, opts.notBefore)
  }

  /** Creates the target with the plan's values. `ALREADY_EXISTS` means someone else created it meanwhile: `redo` from a fresh read. */
  private async createTarget(ref: DocumentReference, plan: FieldPlan, redo: () => Promise<Outcome>): Promise<Outcome> {
    const data: DocumentData = {}
    for (const [path, desired] of plan) if (desired !== DELETE) setField(data, path, desired)
    try {
      await ref.create(data)
      return 'create'
    } catch (err) {
      if (!isCode(err, GRPC_ALREADY_EXISTS)) throw err
      return redo()
    }
  }

  /** Removes the target conditional on the `updateTime` it was read with. */
  private async removeTarget(ref: DocumentReference, target: DocumentSnapshot, redo: () => Promise<Outcome>): Promise<Outcome> {
    try {
      await ref.delete({ lastUpdateTime: target.updateTime })
      return 'remove'
    } catch (err) {
      if (isCode(err, GRPC_NOT_FOUND)) return 'skip'
      if (!isCode(err, GRPC_FAILED_PRECONDITION)) throw err
      return redo()
    }
  }

  /**
   * Reads the target (and the base, for views with `base`), computes the declared fields with
   * `patch` (when a `change` is given and the view defines one) or `build`, and writes the paths
   * that differ, conditional on the target's `updateTime`. With `base`: a missing base removes
   * the target, a missing target is created.
   */
  async syncView(ref: DocumentReference, view: ResolvedView, opts: SyncOptions & { change?: ViewChange; changeCache?: ChangeCache }): Promise<Outcome> {
    const attempt = opts.attempt ?? 0
    if (attempt > this.maxRetries) throw new RetriesExhaustedError(ref.path, attempt)
    const counter = opts.counter ?? new ReadCounter()
    const target = await this.readTarget(ref, opts, counter)
    // A redo re-reads everything: no cached target or source (the page cache may hold the base as it was before another writer changed it).
    const redo = () => this.syncView(ref, view, { ...opts, counter, attempt: attempt + 1, target: undefined, sourceCache: undefined })
    let base: DocumentSnapshot | undefined
    if (view.basePattern) {
      // Read after the target above. A cached base is reused only when it was read no earlier than the target,
      // so a concurrent update to the base can never be overwritten with a stale value.
      base = await this.readBase(ref.path, view, { attempt, sourceCache: opts.sourceCache, notBefore: target.readTime }, counter)
      if (!base) return 'skip'
      if (!base.exists) {
        if (!target.exists) return 'skip'
        return opts.dryRun ? 'remove' : this.removeTarget(ref, target, redo)
      }
      if (opts.orphansOnly) return 'skip'
    } else if (!target.exists) return 'skip'
    // A redo re-read the target, so the changed document must be re-read after it as well.
    const { plan } = await this.computeView(target, view, { ...opts, counter, base, changeCache: attempt === 0 ? opts.changeCache : undefined })
    if (plan === NOTHING) return 'skip'
    if (!target.exists) return opts.dryRun ? 'create' : this.createTarget(ref, plan, redo)
    const { updates, outcome } = planUpdates(target, plan)
    if (outcome === 'skip') return 'skip'
    if (opts.dryRun) return outcome
    return this.write(ref, target, updates, outcome, redo)
  }

  /** The values the declared paths of `target` should hold: `patch` applied to the current values, or `build` over fresh reads. */
  private async computeView(
    target: DocumentSnapshot,
    view: ResolvedView,
    opts: { change?: ViewChange; changeCache?: ChangeCache; base?: DocumentSnapshot; counter: ReadCounter; sourceCache?: SourceCache },
  ): Promise<{ plan: FieldPlan | typeof NOTHING; reason?: string }> {
    const { counter, sourceCache } = opts
    const firestore = countingFirestore(this.db(), counter)
    const source = opts.change && view.sources.find((s) => s.key === opts.change!.source)
    if (opts.change && source && view.patch && target.exists) {
      // The event payload may be stale, duplicated or forged: give `patch` the document as it is now,
      // read after the target (once per page when fanning out), and only if it still belongs to this target.
      const { path } = opts.change
      const cache = opts.changeCache
      if (!cache?.doc) {
        counter.doc()
        const read = this.db().doc(path).get()
        if (cache) cache.doc = read
        else return this.patchWith(target, view, source, opts.change, await read, counter, firestore, opts.base, sourceCache)
      }
      return this.patchWith(target, view, source, opts.change, await cache.doc!, counter, firestore, opts.base, sourceCache)
    }
    return this.buildValue(target, view, counter, firestore, opts.base, sourceCache)
  }

  private async patchWith(
    target: DocumentSnapshot,
    view: ResolvedView,
    source: ResolvedViewSource,
    change: ViewChange,
    current: DocumentSnapshot,
    counter: ReadCounter,
    firestore: Firestore,
    base: DocumentSnapshot | undefined,
    sourceCache?: SourceCache,
  ): Promise<{ plan: FieldPlan | typeof NOTHING; reason?: string }> {
    const belongs = current.exists && this.belongsToTarget(view, source, target, current)
    const fresh: ViewChange = { ...change, after: belongs ? current.data() : undefined }
    const patched = await view.patch!(this.currentValues(view, target), fresh, { target, base, firestore })
    if (patched !== undefined) return { plan: this.planOf(view, target, stripUndefined(patched)) }
    return this.buildValue(target, view, counter, firestore, base, sourceCache)
  }

  private async buildValue(
    target: DocumentSnapshot,
    view: ResolvedView,
    counter: ReadCounter,
    firestore: Firestore,
    base: DocumentSnapshot | undefined,
    sourceCache?: SourceCache,
  ): Promise<{ plan: FieldPlan | typeof NOTHING; reason?: string }> {
    const sources: Record<string, QueryDocumentSnapshot[]> = {}
    for (const source of view.sources) {
      const docs = await this.viewSourceDocs(view, source, target, counter, sourceCache)
      if (docs === undefined) return { plan: NOTHING, reason: `source "${source.key}" unresolvable for this target` }
      sources[source.key] = docs
    }
    const built = await view.build({ target, base, sources, firestore })
    return { plan: this.planOf(view, target, built === undefined ? undefined : stripUndefined(built)) }
  }

  /** The declared paths of `view` as they are on `target` (plus every unreserved root key for `rest`), as a nested object: what `patch` receives. */
  private currentValues(view: ResolvedView, target: DocumentSnapshot): DocumentData {
    const out: DocumentData = {}
    for (const path of view.targetFields) {
      const v: unknown = target.get(path)
      if (v !== undefined) setField(out, path, v)
    }
    if (view.rest) {
      const reserved = new Set(view.reservedRootKeys)
      for (const [key, value] of Object.entries(target.data() ?? {})) if (!reserved.has(key) && !Object.hasOwn(out, key)) out[key] = value
    }
    return out
  }

  /**
   * Reads the declared paths out of a build/patch result; a missing path becomes a deletion.
   * With `rest`, every root key of the result that no rule reserves is written too, and every
   * such key on the target that the result lacks is deleted. Undeclared paths are warned about once and ignored.
   */
  private planOf(view: ResolvedView, target: DocumentSnapshot, built: DocumentData | undefined): FieldPlan {
    // A contract violation (build/patch returning something other than an object) must not crash the
    // event: a non-null, non-object result is treated as nothing built; null/undefined stay silent
    // (undefined is the documented "delete everything").
    const data: DocumentData | undefined = built !== null && typeof built === 'object' && !Array.isArray(built) ? built : undefined
    if (built !== null && built !== undefined && data === undefined) {
      this.warnOnce(`${view.name}:not-object`, 'doc-sync: build did not return an object, treated as empty', { rule: view.name })
    }
    const plan: FieldPlan = new Map()
    for (const path of view.targetFields) {
      let v = getField(data, path)
      // A result key written literally as a dotted path equal to a declared path (`{ 'stats.count': 3 }`) counts as that path.
      if (v === undefined && data !== undefined && Object.hasOwn(data, path)) v = data[path]
      plan.set(path, v === undefined ? DELETE : v)
    }
    if (view.rest) {
      const reserved = new Set(view.reservedRootKeys)
      for (const [key, value] of Object.entries(data ?? {})) {
        if (reserved.has(key)) continue
        if (key.includes('.') || !isValidFieldPath(key)) {
          this.warnOnce(`${view.name}:dotted:${key}`, 'doc-sync: build returned a root key that is not a valid field name, ignored', { rule: view.name, field: key })
          continue
        }
        plan.set(key, value)
      }
      for (const key of Object.keys(target.exists ? (target.data() ?? {}) : {})) {
        if (reserved.has(key) || plan.has(key)) continue
        if (key.includes('.') || !isValidFieldPath(key)) {
          // `update()` would read a dotted key as a path (and reject reserved characters): leave such keys alone rather than fail every event.
          this.warnOnce(`${view.name}:target:${key}`, 'doc-sync: target has a root key that is not a valid field name, left in place', {
            rule: view.name,
            document: target.ref.path,
            field: key,
          })
          continue
        }
        plan.set(key, DELETE)
      }
    }
    this.warnUndeclared(view, data)
    return plan
  }

  private readonly warnedOnce = new Set<string>()

  /** Logs `message` once per `key`, ever (not just per view). */
  private warnOnce(key: string, message: string, fields: Record<string, unknown>): void {
    if (this.warnedOnce.has(key)) return
    this.warnedOnce.add(key)
    this.logger.warn(message, fields)
  }

  private warnUndeclared(view: ResolvedView, built: DocumentData | undefined): void {
    const undeclared = undeclaredPaths(view, built)
    for (const path of undeclared) {
      this.warnOnce(`${view.name}:undeclared:${path}`, 'doc-sync: build returned a field the view does not declare, ignored', { rule: view.name, field: path })
    }
  }

  /** Whether `doc` (a fresh read of a source document) is one of `source`'s documents for `target`. */
  private belongsToTarget(view: ResolvedView, source: ResolvedViewSource, target: DocumentSnapshot, doc: DocumentSnapshot): boolean {
    const tm = matchDocumentPath(view.targetPattern, target.ref.path)
    const sm = matchDocumentPath(source.pattern, doc.ref.path)
    if (!tm || !sm) return false
    if (source.refField !== undefined) {
      return target.get(source.refField) === doc.id && resolveCollectionPath(source.pattern, tm.params) === doc.ref.parent.path
    }
    const id = source.idParam !== undefined ? sm.params[source.idParam] : doc.get(source.idField!)
    return id === target.id && this.sourceBelongsTo(source, tm, doc.ref.path)
  }

  /** Current documents of one source for a target: a query (`idField` / `idParam`) or the one referenced document (`refField`). */
  private async viewSourceDocs(
    view: ResolvedView,
    source: ResolvedViewSource,
    target: DocumentSnapshot,
    counter: ReadCounter,
    cache?: SourceCache,
  ): Promise<QueryDocumentSnapshot[] | undefined> {
    const m = matchDocumentPath(view.targetPattern, target.ref.path)
    if (!m) return undefined
    if (source.refField !== undefined) {
      const id: unknown = target.get(source.refField)
      if (id === undefined || id === null || id === '') return []
      if (typeof id !== 'string' || !isValidDocumentId(id)) {
        this.logger.warn('doc-sync: refField is not a document id, treated as unset', { rule: view.name, document: target.ref.path, refField: source.refField })
        return []
      }
      const collection = resolveCollectionPath(source.pattern, m.params)
      if (!collection) return undefined
      const snap = await this.readSource(`${collection}/${id}`, counter, cache, target.readTime)
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
      counter.query(snap.size)
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
    counter: ReadCounter,
    fn: (ref: DocumentReference, snapshot: DocumentSnapshot | undefined, changeCache: ChangeCache) => Promise<void>,
  ): Promise<boolean> {
    const firestore = this.db()
    if (source.refField !== undefined) {
      const concrete = resolveCollectionPath(view.targetPattern, match.params)
      const base = concrete ? firestore.collection(concrete) : firestore.collectionGroup(view.targetPattern.collectionId)
      const query = base.where(source.refField, '==', match.id).limit(this.pageSize)
      let last: DocumentSnapshot | undefined
      for (;;) {
        const page = await (last ? query.startAfter(last) : query).get()
        counter.query(page.size)
        const docs = page.docs.filter((d) => {
          const tm = matchDocumentPath(view.targetPattern, d.ref.path)
          return tm !== undefined && Object.entries(match.params).every(([k, v]) => tm.params[k] === undefined || tm.params[k] === v)
        })
        // One fresh read of the changed document per page: it happens after the page (= every target in it) was read.
        const changeCache: ChangeCache = {}
        await forEachLimit(docs, VIEW_FANOUT_CONCURRENCY, (d) => fn(d.ref, d, changeCache))
        if (page.size < this.pageSize) break
        last = page.docs[page.docs.length - 1]
      }
      return true
    }
    const { targetCollection, ids } = this.viewTargetIdsFor(view, source, match, before, after)
    if (!targetCollection) return false
    for (const id of ids) await fn(firestore.doc(`${targetCollection}/${id}`), undefined, {})
    return true
  }

  /** Target ids of an `idField` / `idParam` source change (and the target collection they belong to): shared by `forEachViewTarget` and `viewSource`'s defer path. */
  private viewTargetIdsFor(
    view: ResolvedView,
    source: ResolvedViewSource,
    match: DocumentMatch,
    before: DecodedDocument | undefined,
    after: DecodedDocument | undefined,
  ): { targetCollection: string | undefined; ids: Set<string> } {
    const ids = new Set<string>()
    for (const doc of [before, after]) {
      if (!doc) continue
      const id = source.idField !== undefined ? getField(doc.data, source.idField) : match.params[source.idParam!]
      if (typeof id === 'string' && isValidDocumentId(id)) ids.add(id)
    }
    const targetCollection = resolveCollectionPath(view.targetPattern, match.params)
    return { targetCollection, ids }
  }

}

/** Shares one read of the changed document between the targets of a page (see `forEachViewTarget`). */
interface ChangeCache {
  doc?: Promise<DocumentSnapshot>
}

/**
 * Removes `undefined` values, which Firestore rejects: map entries are dropped, array elements
 * become `null`. Plain maps and arrays only; Firestore value classes are left as they are.
 */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : stripUndefined(v))) as T
  if (value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = stripUndefined(v)
    return out as T
  }
  return value
}

/** Path of the base document of a target of `view`; `undefined` when the path does not match the view's target pattern. */
export function basePathForTarget(view: ResolvedView, targetPath: string): string | undefined {
  const m = matchDocumentPath(view.targetPattern, targetPath)
  const collection = m && view.basePattern ? resolveCollectionPath(view.basePattern, m.params) : undefined
  return m && collection ? `${collection}/${m.id}` : undefined
}

/** Path of the target that mirrors a base document of `view`; `undefined` when the path does not match the view's base pattern. */
export function targetPathForBase(view: ResolvedView, basePath: string): string | undefined {
  const m = view.basePattern ? matchDocumentPath(view.basePattern, basePath) : undefined
  const collection = m ? resolveCollectionPath(view.targetPattern, m.params) : undefined
  return m && collection ? `${collection}/${m.id}` : undefined
}

function fieldRemoved(before: DecodedDocument, after: DecodedDocument, field: string): boolean {
  return getField(before.data, field) !== undefined && getField(after.data, field) === undefined
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
  const kind = rule.kind === 'view' && rule.projection ? 'projection' : rule.kind
  return { rule: rule.name, kind, role, action: 'skip', targets: 0, writes: 0, retries: 0, reads: 0, queries: 0, aggregations: 0 }
}

function finish(result: RuleResult, counter: ReadCounter): RuleResult {
  return Object.assign(result, counter.counts())
}

function count(result: RuleResult, outcome: Outcome): void {
  if (outcome === 'skip') return
  result.writes++
  result.action = outcome
}

/** Marks every unit dirty via `sink` instead of recomputing it now; the result reports `defer` (or `skip` when there was nothing to mark). */
async function deferUnits(result: RuleResult, sink: DeferSink, units: DirtyUnit[]): Promise<RuleResult> {
  for (const u of units) await sink(u)
  result.action = units.length ? 'defer' : 'skip'
  result.deferred = units.length
  if (!units.length) result.reason = 'no target id'
  return result
}

function deferOne(result: RuleResult, sink: DeferSink, unit: DirtyUnit): Promise<RuleResult> {
  return deferUnits(result, sink, [unit])
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

/** What a rule wants each written field path to hold: a value, or `DELETE` for "the path must be absent". */
type FieldPlan = Map<string, Desired>

/**
 * The `update()` payload for the paths of `plan` whose current value on `target` differs, and
 * the outcome that write would be (`skip` when nothing differs, `delete` when only deletions remain).
 * Without an existing target every non-DELETE entry is included.
 */
function planUpdates(target: DocumentSnapshot | undefined, plan: FieldPlan): { updates: Record<string, unknown>; outcome: Outcome } {
  const updates: Record<string, unknown> = {}
  let outcome: Outcome = 'skip'
  for (const [path, desired] of plan) {
    if (target?.exists ? !needsWrite(target, path, desired) : desired === DELETE) continue
    updates[path] = toFieldValue(desired)
    if (desired !== DELETE) outcome = 'write'
    else if (outcome === 'skip') outcome = 'delete'
  }
  return { updates, outcome }
}

function needsWrite(target: DocumentSnapshot, targetField: string, desired: Desired): boolean {
  const current: unknown = target.get(targetField)
  if (desired === DELETE) return current !== undefined
  return !isEqual(current, desired)
}

/** Compares an existing target with a plan: `ok` when every path already holds its value. */
function checkPlan(target: DocumentSnapshot, plan: FieldPlan): CheckResult {
  const fields: FieldMismatch[] = []
  for (const [path, desired] of plan) {
    if (!needsWrite(target, path, desired)) continue
    fields.push({ field: path, actual: target.get(path), expected: desired === DELETE ? undefined : desired })
  }
  return fields.length ? { status: 'mismatch', issue: 'value', fields } : { status: 'ok' }
}

/** Paths in `built` that no declared `targetFields` entry covers (root keys, or sub-keys next to a declared deeper path). */
function undeclaredPaths(view: ResolvedView, built: DocumentData | undefined, prefix = ''): string[] {
  if (built === undefined) return []
  const out: string[] = []
  for (const [key, value] of Object.entries(built)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (view.targetFields.includes(path)) continue
    if (!prefix && view.rest && !view.reservedRootKeys.includes(key)) continue
    const deeper = view.targetFields.some((f) => f.startsWith(`${path}.`))
    if (deeper && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...undeclaredPaths(view, value as DocumentData, path))
    } else {
      out.push(path)
    }
  }
  return out
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
  const given = req.rawBody instanceof Uint8Array ? req.rawBody : req.body instanceof Uint8Array || typeof req.body === 'string' ? req.body : undefined
  if (given !== undefined) {
    if (given.length > MAX_BODY_BYTES) throw new DecodeError(`request body larger than ${MAX_BODY_BYTES} bytes`)
    return given
  }
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    return req.body
  }
  if (typeof req[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req as AsyncIterable<unknown>) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array)
      total += buf.length
      if (total > MAX_BODY_BYTES) throw new DecodeError(`request body larger than ${MAX_BODY_BYTES} bytes`)
      chunks.push(buf)
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
