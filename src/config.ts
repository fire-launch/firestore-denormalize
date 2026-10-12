/**
 * Configuration types and validation.
 *
 * The same config object is consumed by the Cloud Run handler
 * (`createDocSyncHandler`) and by the CLI (`doc-sync validate|setup|deploy|rebuild|dev`).
 */
import { createHash } from 'node:crypto'
import type { DocumentData, DocumentSnapshot, Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { fieldPathsOverlap, isValidFieldPath, setField, splitFieldPath } from './fields.js'
import { type CollectionPattern, isResolvable, parseCollectionPattern, patternSlug, patternsIntersect } from './paths.js'

/** What to write into `targetField` when the source document no longer exists. */
export type OnSourceDelete = 'setNull' | 'deleteField' | 'nothing'

/**
 * Copy sync: copy `fields` of `source/{id}` into `target.{targetField}` wherever `target.{idField} == id`.
 *
 * `source` / `target` are collection paths. Subcollections use placeholders for parent IDs:
 * `users/{uid}/posts`. Every placeholder of `source` must also appear in `target`, so the
 * source of a target can be located. Field names may be dotted paths (`address.city`).
 */
export interface Connection {
  kind: 'connection'
  /** Unique name, used in logs. */
  name: string
  /** Collection the data is copied from. */
  source: string
  /** Collection the data is copied to. */
  target: string
  /** Field on the target holding the source document ID (a string). */
  idField: string
  /** Fields to copy from the source. Missing fields are omitted. */
  fields: string[]
  /** Field on the target that receives the copied map. */
  targetField: string
  /** Behaviour when the source document is missing/deleted. */
  onSourceDelete: OnSourceDelete
  /**
   * Run this rule on a Cloud Scheduler cron (unix-cron, 5 fields, e.g. `'0 3 * * *'`) instead of
   * on Firestore events: `deploy` creates a job that calls `/schedule/<name>` on the function,
   * which rebuilds this rule. This rule ignores events (other rules on the same collections still run on them).
   */
  schedule?: string
  /** IANA time zone for `schedule`. Default `Etc/UTC`. */
  timeZone?: string
  /**
   * Defer this rule: events only mark what changed, and a Cloud Tasks task recomputes it once
   * per interval (`'90s'`, `'10m'`, `'1h'`). Lifecycle events (base created/deleted) stay
   * immediate. Not with `schedule`.
   */
  defer?: string
}

/**
 * Count / sum: keep `target.{targetField}` equal to `count()` or `sum(field)` over the
 * source documents that belong to the target. The value is always recomputed with an
 * aggregation query, never adjusted with `increment()`.
 *
 * The target is identified either by a field on the source (`idField: 'postId'`) or by a
 * placeholder of the source path (`idParam: 'postId'` for `source: 'post/{postId}/like'`).
 */
export interface AggregateRule {
  kind: 'aggregate'
  /** Unique name, used in logs. */
  name: string
  /** Collection whose documents are counted / summed. */
  source: string
  /** Collection holding the result. */
  target: string
  /** Field on the source holding the target document ID. Use this or `idParam`. */
  idField?: string
  /** Placeholder of `source` holding the target document ID. Use this or `idField`. */
  idParam?: string
  /** `'count'` or `{ sum: '<numeric field on the source>' }`. */
  aggregate: 'count' | { sum: string }
  /** Field on the target that receives the number. */
  targetField: string
  /**
   * Run this rule on a Cloud Scheduler cron (unix-cron, 5 fields, e.g. `'0 3 * * *'`) instead of
   * on Firestore events: `deploy` creates a job that calls `/schedule/<name>` on the function,
   * which rebuilds this rule. This rule ignores events (other rules on the same collections still run on them).
   */
  schedule?: string
  /** IANA time zone for `schedule`. Default `Etc/UTC`. */
  timeZone?: string
  /**
   * Defer this rule: events only mark what changed, and a Cloud Tasks task recomputes it once
   * per interval (`'90s'`, `'10m'`, `'1h'`). Lifecycle events (base created/deleted) stay
   * immediate. Not with `schedule`.
   */
  defer?: string
}

/** Sort key of a view source query: a field path, or `[field, direction]`. */
export type ViewOrder = string | [field: string, direction: 'asc' | 'desc']

/**
 * One source collection of a view and how its documents relate to the target document.
 * Exactly one of `idField`, `idParam` or `refField` is required.
 */
export interface ViewSource {
  /** Collection path pattern, e.g. `comment` or `post/{postId}/comment`. */
  collection: string
  /** Many-to-one: field on the source holding the target document ID. */
  idField?: string
  /** Many-to-one: placeholder of `collection` holding the target document ID (`post/{postId}/comment` with `idParam: 'postId'`). */
  idParam?: string
  /** One-to-one: field on the *target* holding the source document ID (like a connection). */
  refField?: string
  /** Ordering of the source query (many-to-one sources only). */
  orderBy?: ViewOrder[]
  /** Maximum number of source documents read (many-to-one sources only). */
  limit?: number
  /**
   * Source fields whose change triggers a recompute. Default: any change. `idField` and the
   * `orderBy` fields are always watched in addition, since they decide membership and order.
   */
  watch?: string[]
}

/** What `build` receives: the target and the current documents of every source, all freshly read. */
export interface BuildContext<S extends Record<string, ViewSource> = Record<string, ViewSource>> {
  target: DocumentSnapshot
  /** The base document (views with `base`); always exists when `build` runs. */
  base?: DocumentSnapshot
  /** Documents per source key, in query order. A `refField` source has zero or one document. */
  sources: { [K in keyof S]: QueryDocumentSnapshot[] }
  /** The Firestore instance the handler uses, for extra reads. Reads happen after the target was read, so the conditional write stays safe. */
  firestore: Firestore
}

/** The source change `patch` is asked to apply. */
export interface ViewChange {
  /** Key of the changed source in `sources`. */
  source: string
  /** Path of the changed source document. */
  path: string
  /** The document as the event reported it before the change (`undefined` for a create). Informational. */
  before?: DocumentData
  /**
   * The document as it is *now*: a fresh read taken after the target was read, not the event's
   * payload. `undefined` when it no longer exists, even if the event was a create.
   */
  after?: DocumentData
}

export interface PatchContext {
  /** Freshly read target document. */
  target: DocumentSnapshot
  /** The base document (views with `base`); always exists when `patch` runs. */
  base?: DocumentSnapshot
  /** The Firestore instance the handler uses, for a small extra read (e.g. refilling a "latest N" list after a delete). */
  firestore: Firestore
}

/**
 * View: keep the declared `targetFields` of `target` equal to the matching paths of
 * `build(...)`, an object computed by user code from the documents of one or more source
 * collections. For shapes the other rules cannot express: "latest N items", a map keyed by
 * id, a custom summary, a read model spread over several fields.
 */
export interface ViewRule<S extends Record<string, ViewSource> = Record<string, ViewSource>, T extends DocumentData = DocumentData> {
  kind: 'view'
  /** Unique name, used in logs. */
  name: string
  /** Collection holding the derived value. */
  target: string
  /**
   * Field paths of the target this view writes (`title`, `stats.count`, `profile`). Only these
   * paths are read from the `build` result; a path whose value is `undefined` is deleted.
   * `'rest'` (views with `base` only) adds every root key no rule declares.
   */
  targetFields: string[]
  /**
   * Collection whose document with the same ID decides whether the target exists: the target is
   * created when the base exists and deleted when it does not. Must have the same placeholders as `target`.
   */
  base?: string
  /** Source collections keyed by the name used in `build` / `patch`. May be omitted when `base` is set. */
  sources?: S
  /**
   * Recomputes the declared fields from a fresh read of the base and every source. Must be
   * deterministic. Return `undefined` to delete every declared field. Used by the handler,
   * `rebuild` and `verify`.
   */
  build(ctx: BuildContext<S>): T | undefined | Promise<T | undefined>
  /**
   * Optional fast path: derive the new values from the current ones (`current` holds the
   * declared paths as they are on the target, plus the `rest` keys) and one changed source
   * document (one fresh read) instead of reading every source. Return `undefined` to fall back
   * to `build`. Events can be delivered more than once and out of order, so `patch` must be
   * idempotent and must only use `change.after` (the current state) to decide what the item
   * looks like, keyed by document id. `rebuild` and `verify` never use it.
   */
  patch?(current: T, change: ViewChange, ctx: PatchContext): T | undefined | Promise<T | undefined>
  /**
   * Run this rule on a Cloud Scheduler cron (unix-cron, 5 fields, e.g. `'0 3 * * *'`) instead of
   * on Firestore events: `deploy` creates a job that calls `/schedule/<name>` on the function,
   * which rebuilds this rule. This rule ignores events (other rules on the same collections still run on them).
   */
  schedule?: string
  /** IANA time zone for `schedule`. Default `Etc/UTC`. */
  timeZone?: string
  /**
   * Defer this rule: events only mark what changed, and a Cloud Tasks task recomputes it once
   * per interval (`'90s'`, `'10m'`, `'1h'`). Lifecycle events (base created/deleted) stay
   * immediate. Not with `schedule`.
   */
  defer?: string
}

/**
 * Projection: `target/{id}` mirrors the declared paths of `base/{id}` and exists exactly when
 * the base does. A view with `base`, no `sources` and a generated `build`; add aggregates or
 * views on `target` for derived fields.
 */
export interface ProjectionRule {
  kind: 'projection'
  /** Unique name, used in logs. */
  name: string
  /** Collection to mirror. */
  base: string
  /** Collection receiving one document per base document, same ID. Same placeholders as `base`. */
  target: string
  /** Paths copied from the base as they are. `'rest'` is not supported. */
  targetFields: string[]
  /**
   * Run this rule on a Cloud Scheduler cron (unix-cron, 5 fields, e.g. `'0 3 * * *'`) instead of
   * on Firestore events: `deploy` creates a job that calls `/schedule/<name>` on the function,
   * which rebuilds this rule. This rule ignores events (other rules on the same collections still run on them).
   */
  schedule?: string
  /** IANA time zone for `schedule`. Default `Etc/UTC`. */
  timeZone?: string
  /**
   * Defer this rule: events only mark what changed, and a Cloud Tasks task recomputes it once
   * per interval (`'90s'`, `'10m'`, `'1h'`). Lifecycle events (base created/deleted) stay
   * immediate. Not with `schedule`.
   */
  defer?: string
}

/** One rule of any kind. */
export type Rule = Connection | AggregateRule | ViewRule | ProjectionRule

export interface DocSyncConfig {
  /** Instance name. Used for trigger names and labels (lowercase letters, digits, hyphens). */
  name: string
  /** Eventarc trigger location. Must match the Firestore database location (e.g. `asia-northeast1`, `nam5`). */
  region: string
  /** Firestore database ID. Defaults to `(default)`. */
  database?: string
  /** Name of the Cloud Run service (the deployed function) that receives events. */
  service: string
  /** Region of the Cloud Run service. Defaults to `region`; required when `region` is a multi-region (`nam5`, `eur3`, ...), which Cloud Run does not have. */
  serviceRegion?: string
  /** Service account used by the triggers. A bare ID is expanded to `<id>@<project>.iam.gserviceaccount.com`. */
  serviceAccount: string
  /** The rules, in any order: {@link defineConnection}, {@link defineAggregate}, {@link defineView} and {@link defineProjection} results, or objects with a `kind`. */
  rules: Rule[]
}

export interface ResolvedConnection extends Connection {
  sourcePattern: CollectionPattern
  targetPattern: CollectionPattern
  /** Set when the rule runs on a schedule instead of on events. */
  scheduled?: ResolvedSchedule
  /** Set when the rule's recompute is deferred instead of running on every event. */
  deferred?: { everyMs: number }
}

export interface ResolvedAggregate extends AggregateRule {
  sourcePattern: CollectionPattern
  targetPattern: CollectionPattern
  /** Source fields whose change requires a recompute (`idField` and/or the summed field). */
  watchedFields: string[]
  /** Set when the rule runs on a schedule instead of on events. */
  scheduled?: ResolvedSchedule
  /** Set when the rule's recompute is deferred instead of running on every event. */
  deferred?: { everyMs: number }
}

/** A rule's `schedule` after validation. */
export interface ResolvedSchedule {
  cron: string
  timeZone: string
}

export interface ResolvedViewSource {
  /** Key in `ViewRule.sources`. */
  key: string
  collection: string
  pattern: CollectionPattern
  idField?: string
  idParam?: string
  refField?: string
  orderBy: { field: string; direction: 'asc' | 'desc' }[]
  limit?: number
  /** Source fields whose change triggers a recompute; `undefined` means any change. */
  watch?: string[]
}

export interface ResolvedView {
  kind: 'view'
  name: string
  target: string
  /** Declared field paths, without `'rest'`. */
  targetFields: string[]
  /** Whether `'rest'` was declared. */
  rest: boolean
  /** Root keys of the target that `'rest'` must never touch: every root of a field written or used as an id by any rule on this collection. */
  reservedRootKeys: string[]
  base?: string
  basePattern?: CollectionPattern
  targetPattern: CollectionPattern
  sources: ResolvedViewSource[]
  build: ViewRule['build']
  patch?: ViewRule['patch']
  /** Set when the view was made from `defineProjection`. */
  projection?: true
  /** Set when the rule runs on a schedule instead of on events. */
  scheduled?: ResolvedSchedule
  /** Set when the rule's recompute is deferred instead of running on every event. */
  deferred?: { everyMs: number }
}

export type ResolvedRule = ResolvedConnection | ResolvedAggregate | ResolvedView

/** Config with defaults applied, patterns parsed and rules grouped by kind. */
export interface ResolvedConfig extends Omit<DocSyncConfig, 'rules'> {
  /** Marks a config that already went through {@link validateConfig}. */
  resolved: true
  database: string
  serviceRegion: string
  connections: ResolvedConnection[]
  aggregates: ResolvedAggregate[]
  views: ResolvedView[]
}

/** Identity helper that gives you type checking and completion in `doc-sync.config.ts`. */
export function defineConfig(config: DocSyncConfig): DocSyncConfig {
  return config
}

/** Expands a bare service-account id to `<id>@<project>.iam.gserviceaccount.com`. */
export function serviceAccountEmail(config: Pick<ResolvedConfig, 'serviceAccount'>, project: string): string {
  return config.serviceAccount.includes('@')
    ? config.serviceAccount
    : `${config.serviceAccount}@${project}.iam.gserviceaccount.com`
}

/** Cloud Tasks queue that carries the continuation of scheduled runs that ran out of budget. */
export function scheduleQueueName(instanceName: string): string {
  return `${instanceName}-schedule`
}

/** Validates a raw config, or returns an already resolved one unchanged. */
export function resolveConfig(config: DocSyncConfig | ResolvedConfig): ResolvedConfig {
  return (config as ResolvedConfig).resolved === true ? (config as ResolvedConfig) : validateConfig(config as DocSyncConfig)
}

/** Tags a copy rule with its `kind` so it can go into `rules`. */
export function defineConnection(rule: Omit<Connection, 'kind'>): Connection {
  return { kind: 'connection', ...rule }
}

/** Tags a count / sum rule with its `kind` so it can go into `rules`. */
export function defineAggregate(rule: Omit<AggregateRule, 'kind'>): AggregateRule {
  return { kind: 'aggregate', ...rule }
}

/** Tags a view with its `kind` and types `build` / `patch` from the view's own `sources` keys. */
export function defineView<S extends Record<string, ViewSource>, T extends DocumentData>(view: Omit<ViewRule<S, T>, 'kind'>): ViewRule<S, T> {
  return { kind: 'view', ...view } as ViewRule<S, T>
}

/** Tags a projection with its `kind` so it can go into `rules`. */
export function defineProjection(rule: Omit<ProjectionRule, 'kind'>): ProjectionRule {
  return { kind: 'projection', ...rule }
}

/** The `build` of a projection: the declared paths of the base, as they are. */
function projectionBuild(paths: string[]): ViewRule['build'] {
  return ({ base }) => {
    const out: DocumentData = {}
    for (const p of paths) {
      const v: unknown = base!.get(p)
      if (v !== undefined) setField(out, p, v)
    }
    return out
  }
}

/** Every rule of a resolved config, connections first. */
export function rulesOf(config: ResolvedConfig): ResolvedRule[] {
  return [...config.connections, ...config.aggregates, ...config.views]
}

export class ConfigError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`Invalid doc-sync config:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

const INSTANCE_NAME = /^[a-z][a-z0-9-]*$/
const TRIGGER_NAME = /^[a-z]([a-z0-9-]*[a-z0-9])?$/
const SERVICE_NAME = /^[a-z]([a-z0-9-]*[a-z0-9])?$/
/** Firestore multi-region locations (`nam5`, `eur3`, `nam7`, ...), which are not Cloud Run regions. */
const MULTI_REGION = /^(nam|eur|asia)\d+$/
const TRIGGER_NAME_MAX = 63
/** Prefix budget for composite names: `TRIGGER_NAME_MAX` minus `-` and the 8-char hash. */
const RESOURCE_PREFIX_MAX = TRIGGER_NAME_MAX - 9

const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/
/** `90s`, `10m`, `1h`, `1h30m` → milliseconds; `undefined` when not a duration. */
export function parseDuration(s: string): number | undefined {
  const m = DURATION.exec(s)
  if (!m || s === '') return undefined
  const [, h = '0', mi = '0', sec = '0'] = m
  return ((Number(h) * 60 + Number(mi)) * 60 + Number(sec)) * 1000
}

/**
 * Validates the config and applies defaults. Throws {@link ConfigError} listing every problem found.
 */
export function validateConfig(config: DocSyncConfig): ResolvedConfig {
  const problems: string[] = []

  if (!config || typeof config !== 'object') {
    throw new ConfigError(['config must be an object (did you `export default defineConfig(...)`?)'])
  }

  if (!str(config.name)) problems.push('`name` is required')
  else if (!INSTANCE_NAME.test(config.name)) {
    problems.push(`\`name\` must match ${INSTANCE_NAME} (got "${config.name}")`)
  }
  if (!str(config.region)) problems.push('`region` is required')
  if (!str(config.service)) problems.push('`service` is required')
  else if (!SERVICE_NAME.test(config.service)) problems.push(`\`service\` must be a Cloud Run service name matching ${SERVICE_NAME} (got "${config.service}")`)
  if (str(config.region) && MULTI_REGION.test(config.region) && config.serviceRegion === undefined) {
    problems.push(`\`serviceRegion\` is required when \`region\` is a multi-region ("${config.region}"): Cloud Run needs a regular region such as us-central1`)
  }
  if (!str(config.serviceAccount)) problems.push('`serviceAccount` is required')
  if (config.database !== undefined && !str(config.database)) problems.push('`database` must be a non-empty string')
  if (config.serviceRegion !== undefined && !str(config.serviceRegion)) {
    problems.push('`serviceRegion` must be a non-empty string')
  }

  const rules: unknown[] = Array.isArray(config.rules) ? config.rules : []
  if (!Array.isArray(config.rules)) problems.push('`rules` must be an array')
  else if (rules.length === 0) problems.push('`rules` must have at least one entry')
  // Keep the original index of every rule for messages about rules without a usable name.
  const connList: { rule: Connection; i: number }[] = []
  const aggList: { rule: AggregateRule; i: number }[] = []
  const viewList: { rule: ViewRule; i: number; label?: string; projection?: true }[] = []
  const projList: { rule: ProjectionRule; i: number }[] = []
  rules.forEach((r, i) => {
    const kind = (r as { kind?: unknown } | null)?.kind
    if (!r || typeof r !== 'object') problems.push(`rules[${i}]: must be an object`)
    else if (kind === 'connection') connList.push({ rule: r as Connection, i })
    else if (kind === 'aggregate') aggList.push({ rule: r as AggregateRule, i })
    else if (kind === 'view') viewList.push({ rule: r as ViewRule, i })
    else if (kind === 'projection') projList.push({ rule: r as ProjectionRule, i })
    else problems.push(`rules[${i}]: \`kind\` must be 'connection' | 'aggregate' | 'view' | 'projection' (use defineConnection / defineAggregate / defineView / defineProjection)`)
  })

  const names = new Map<string, string>()
  const CRON_FIELD = /^[A-Za-z0-9*,/?#LW-]+$/
  const SAFE_RULE_NAME = /^[A-Za-z0-9_-]+$/
  /** Resolves `schedule` / `timeZone`: `undefined` when the rule has none, `null` after reporting a problem. */
  const schedule = (r: { name?: unknown; schedule?: unknown; timeZone?: unknown }, label: string): ResolvedSchedule | undefined | null => {
    if (r.schedule === undefined) {
      if (r.timeZone !== undefined) {
        problems.push(`${label}: \`timeZone\` requires \`schedule\``)
        return null
      }
      return undefined
    }
    const fields = typeof r.schedule === 'string' ? r.schedule.trim().split(/\s+/) : []
    if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) {
      problems.push(`${label}: \`schedule\` must be a unix-cron expression with 5 fields (e.g. "0 3 * * *")`)
      return null
    }
    if (r.timeZone !== undefined && !str(r.timeZone)) {
      problems.push(`${label}: \`timeZone\` must be an IANA time zone name`)
      return null
    }
    if (!str(r.name) || !SAFE_RULE_NAME.test(r.name)) {
      // The name becomes a Cloud Scheduler job name and a URL segment.
      problems.push(`${label}: a scheduled rule's \`name\` must match [A-Za-z0-9_-]`)
      return null
    }
    return { cron: fields.join(' '), timeZone: (r.timeZone as string | undefined) ?? 'Etc/UTC' }
  }
  const DEFER_MIN_MS = 10_000
  const DEFER_MAX_MS = 24 * 60 * 60 * 1000
  /** Resolves `defer`: `undefined` when the rule has none, `null` after reporting a problem. */
  const deferResolver = (r: { name?: unknown; schedule?: unknown; defer?: unknown }, label: string): { everyMs: number } | undefined | null => {
    if (r.defer === undefined) return undefined
    if (r.schedule !== undefined) {
      problems.push(`${label}: \`defer\` and \`schedule\` cannot be combined`)
      return null
    }
    const everyMs = typeof r.defer === 'string' ? parseDuration(r.defer) : undefined
    if (everyMs === undefined) {
      problems.push(`${label}: \`defer\` must be a duration like "10m"`)
      return null
    }
    if (everyMs < DEFER_MIN_MS || everyMs > DEFER_MAX_MS) {
      problems.push(`${label}: \`defer\` must be between 10s and 24h`)
      return null
    }
    if (!str(r.name) || !SAFE_RULE_NAME.test(r.name)) {
      // The name becomes part of the Cloud Tasks task id.
      problems.push(`${label}: a deferred rule's \`name\` must match [A-Za-z0-9_-]`)
      return null
    }
    return { everyMs }
  }
  const writtenFields: { rule: string; target: CollectionPattern; field: string }[] = []
  const idFields: { target: CollectionPattern; field: string }[] = []
  const resolvedConnections: ResolvedConnection[] = []
  const resolvedAggregates: ResolvedAggregate[] = []
  const resolvedViews: ResolvedView[] = []

  const checkName = (rule: { name?: unknown }, label: string) => {
    if (!str(rule.name)) problems.push(`${label}: \`name\` is required`)
    else {
      const seen = names.get(rule.name)
      if (seen) problems.push(`${label}: duplicate name (also ${seen})`)
      names.set(rule.name, label)
    }
  }
  const pattern = (raw: unknown, label: string, key: string): CollectionPattern | undefined => {
    if (!str(raw)) {
      problems.push(`${label}: \`${key}\` is required`)
      return undefined
    }
    try {
      return parseCollectionPattern(raw)
    } catch (err) {
      problems.push(`${label}: \`${key}\` ${(err as Error).message}`)
      return undefined
    }
  }
  const fieldPath = (raw: unknown, label: string, key: string, required = true): raw is string => {
    if (raw === undefined && !required) return false
    if (!str(raw)) {
      problems.push(`${label}: \`${key}\` is required`)
      return false
    }
    if (!isValidFieldPath(raw)) {
      problems.push(`${label}: \`${key}\` must be a field path without ~ * / [ ] or empty segments: "${raw}"`)
      return false
    }
    return true
  }

  connList.forEach(({ rule: c, i }) => {
    const label = str(c?.name) ? `connection "${c.name}"` : `rules[${i}]`
    if (!c || typeof c !== 'object') {
      problems.push(`${label}: must be an object`)
      return
    }
    checkName(c, label)
    const source = pattern(c.source, label, 'source')
    const target = pattern(c.target, label, 'target')
    const okId = fieldPath(c.idField, label, 'idField')
    const okTarget = fieldPath(c.targetField, label, 'targetField')
    let okFields = false
    if (!Array.isArray(c.fields) || c.fields.length === 0 || !c.fields.every(str)) {
      problems.push(`${label}: \`fields\` must be a non-empty array of field names`)
    } else {
      okFields = true
      const dup = c.fields.find((f, j) => c.fields.indexOf(f) !== j)
      if (dup) problems.push(`${label}: \`fields\` contains "${dup}" more than once`)
      for (const f of c.fields) if (!isValidFieldPath(f)) problems.push(`${label}: \`fields\` entry "${f}" is not a valid field path`)
      for (const f of c.fields) {
        for (const g of c.fields) if (f !== g && f.startsWith(`${g}.`)) problems.push(`${label}: \`fields\` "${f}" is already covered by "${g}"`)
      }
    }
    if (!['setNull', 'deleteField', 'nothing'].includes(c.onSourceDelete)) {
      problems.push(`${label}: \`onSourceDelete\` must be 'setNull' | 'deleteField' | 'nothing'`)
    }
    if (source && target) {
      if (source.key === target.key) problems.push(`${label}: \`source\` and \`target\` must be different collections`)
      if (!isResolvable(source, target.params)) {
        const missing = source.params.filter((p) => !target.params.includes(p))
        problems.push(`${label}: placeholder(s) {${missing.join('}, {')}} of \`source\` must also appear in \`target\``)
      }
    }
    if (okId && okTarget && fieldPathsOverlap(c.idField, c.targetField)) {
      problems.push(`${label}: \`idField\` and \`targetField\` must not overlap`)
    }
    if (target && okTarget) writtenFields.push({ rule: label, target, field: c.targetField })
    if (target && okId) idFields.push({ target, field: c.idField })
    const scheduled = schedule(c, label)
    const deferred = deferResolver(c, label)
    if (source && target && okId && okTarget && okFields && scheduled !== null && deferred !== null) {
      resolvedConnections.push({ ...c, sourcePattern: source, targetPattern: target, scheduled: scheduled ?? undefined, deferred: deferred ?? undefined })
    }
  })

  aggList.forEach(({ rule: a, i }) => {
    const label = str(a?.name) ? `aggregate "${a.name}"` : `rules[${i}]`
    if (!a || typeof a !== 'object') {
      problems.push(`${label}: must be an object`)
      return
    }
    checkName(a, label)
    const source = pattern(a.source, label, 'source')
    const target = pattern(a.target, label, 'target')
    const okTarget = fieldPath(a.targetField, label, 'targetField')
    const hasIdField = a.idField !== undefined
    const hasIdParam = a.idParam !== undefined
    if (hasIdField === hasIdParam) problems.push(`${label}: exactly one of \`idField\` or \`idParam\` is required`)
    const okId = hasIdField ? fieldPath(a.idField, label, 'idField') : false
    if (hasIdParam && !str(a.idParam)) problems.push(`${label}: \`idParam\` must be a placeholder name`)
    let sumField: string | undefined
    if (a.aggregate !== 'count') {
      if (!a.aggregate || typeof a.aggregate !== 'object' || !fieldPath(a.aggregate.sum, label, 'aggregate.sum')) {
        if (!a.aggregate || typeof a.aggregate !== 'object') problems.push(`${label}: \`aggregate\` must be 'count' or { sum: '<field>' }`)
      } else sumField = a.aggregate.sum
    }
    if (source && target) {
      if (source.key === target.key) problems.push(`${label}: \`source\` and \`target\` must be different collections`)
      if (hasIdParam && str(a.idParam)) {
        if (!source.params.includes(a.idParam)) problems.push(`${label}: \`idParam\` {${a.idParam}} is not a placeholder of \`source\``)
        if (target.params.includes(a.idParam)) problems.push(`${label}: \`idParam\` {${a.idParam}} must not appear in \`target\``)
        const unbound = source.params.filter((p) => p !== a.idParam && !target.params.includes(p))
        if (unbound.length) problems.push(`${label}: placeholder(s) {${unbound.join('}, {')}} of \`source\` must appear in \`target\` when using \`idParam\``)
      }
      if (!isResolvable(target, source.params)) {
        const missing = target.params.filter((p) => !source.params.includes(p))
        problems.push(`${label}: placeholder(s) {${missing.join('}, {')}} of \`target\` must also appear in \`source\``)
      } else if (hasIdField && target.params.length && !isResolvable(source, target.params)) {
        // A collection-group aggregation cannot be filtered by path, so documents under other parents would be counted.
        const extra = source.params.filter((p) => !target.params.includes(p))
        problems.push(
          `${label}: \`source\` has placeholder(s) {${extra.join('}, {')}} that \`target\` lacks; a collection-group aggregation would also count documents of other \`target\` parents. Use \`idParam\`, or a \`target\` without placeholders`,
        )
      }
    }
    if (target && okTarget) writtenFields.push({ rule: label, target, field: a.targetField })
    const scheduled = schedule(a, label)
    const deferred = deferResolver(a, label)
    if (source && target && okTarget && (okId || (hasIdParam && str(a.idParam))) && (a.aggregate === 'count' || sumField) && scheduled !== null && deferred !== null) {
      const watched = [a.idField, sumField].filter((f): f is string => typeof f === 'string')
      resolvedAggregates.push({ ...a, sourcePattern: source, targetPattern: target, watchedFields: watched, scheduled: scheduled ?? undefined, deferred: deferred ?? undefined })
    }
  })

  /** The base declared for each target collection, so every base view of a target agrees. */
  const baseByTarget = new Map<string, { key: string; raw: string; rule: string }>()

  projList.forEach(({ rule: p, i }) => {
    const label = str(p?.name) ? `projection "${p.name}"` : `rules[${i}]`
    if (!p || typeof p !== 'object') {
      problems.push(`${label}: must be an object`)
      return
    }
    let ok = true
    if (!str(p.base)) {
      problems.push(`${label}: \`base\` is required`)
      ok = false
    }
    if (!Array.isArray(p.targetFields) || p.targetFields.length === 0 || !p.targetFields.every((f) => typeof f === 'string')) {
      problems.push(`${label}: \`targetFields\` must be a non-empty array of field paths`)
      ok = false
    } else if (p.targetFields.includes('rest')) {
      problems.push(`${label}: 'rest' is not supported by a projection`)
      ok = false
    }
    for (const k of ['sources', 'build', 'patch', 'exclude', 'rename'] as const) {
      if (k in p) {
        problems.push(`${label}: \`${k}\` does not apply to a projection`)
        ok = false
      }
    }
    if (!ok) return
    viewList.push({
      rule: {
        kind: 'view',
        name: p.name,
        target: p.target,
        base: p.base,
        targetFields: p.targetFields,
        build: projectionBuild(p.targetFields),
        schedule: p.schedule,
        timeZone: p.timeZone,
        defer: p.defer,
      },
      i,
      label,
      projection: true,
    })
  })

  viewList.forEach(({ rule: v, i, label: givenLabel, projection }) => {
    const label = givenLabel ?? (str(v?.name) ? `view "${v.name}"` : `rules[${i}]`)
    if (!v || typeof v !== 'object') {
      problems.push(`${label}: must be an object`)
      return
    }
    checkName(v, label)
    const target = pattern(v.target, label, 'target')
    const okTargetFieldsShape = Array.isArray(v.targetFields) && v.targetFields.length > 0 && v.targetFields.every((f) => typeof f === 'string')
    if (!okTargetFieldsShape) problems.push(`${label}: \`targetFields\` must be a non-empty array of field paths`)
    const declared: string[] = okTargetFieldsShape ? (v.targetFields as string[]) : []
    const explicit = declared.filter((f) => f !== 'rest')
    const restCount = declared.length - explicit.length
    let okTargetFields = okTargetFieldsShape
    for (const f of explicit) {
      if (!isValidFieldPath(f)) {
        problems.push(`${label}: \`targetFields\` entry "${f}" is not a valid field path`)
        okTargetFields = false
      }
    }
    for (let a = 0; a < explicit.length; a++) {
      for (let b = a + 1; b < explicit.length; b++) {
        if (fieldPathsOverlap(explicit[a]!, explicit[b]!)) {
          problems.push(`${label}: \`targetFields\` "${explicit[a]}" and "${explicit[b]}" overlap`)
          okTargetFields = false
        }
      }
    }
    const hasBase = v.base !== undefined
    const basePattern = hasBase ? pattern(v.base, label, 'base') : undefined
    let okBase = !hasBase || basePattern !== undefined
    if (basePattern && target) {
      if (basePattern.key === target.key) {
        problems.push(`${label}: \`base\` and \`target\` must be different collections`)
        okBase = false
      }
      const sameParams = basePattern.params.length === target.params.length && basePattern.params.every((p) => target.params.includes(p))
      if (!sameParams) {
        problems.push(`${label}: \`base\` must have the same placeholders as \`target\``)
        okBase = false
      }
      const prev = baseByTarget.get(target.key)
      if (prev && prev.key !== basePattern.key) {
        problems.push(`${label}: \`base\` "${v.base}" differs from "${prev.raw}" declared by ${prev.rule} for the same target`)
        okBase = false
      } else if (!prev && okBase) baseByTarget.set(target.key, { key: basePattern.key, raw: v.base as string, rule: label })
    }
    if (restCount > 1) {
      problems.push(`${label}: 'rest' may appear once in \`targetFields\``)
      okTargetFields = false
    }
    if (restCount > 0 && !hasBase) {
      problems.push(`${label}: 'rest' in \`targetFields\` requires \`base\``)
      okTargetFields = false
    }

    const sourcesIsObject = v.sources === undefined || (v.sources !== null && typeof v.sources === 'object' && !Array.isArray(v.sources))
    if (!sourcesIsObject) problems.push(`${label}: \`sources\` must be an object keyed by source name`)
    const sourceEntries: [string, ViewSource][] = sourcesIsObject && v.sources ? Object.entries(v.sources as Record<string, ViewSource>) : []
    if (sourcesIsObject && sourceEntries.length === 0 && !hasBase) problems.push(`${label}: \`sources\` must have at least one entry (or set \`base\`)`)

    const okBuild = typeof v.build === 'function'
    if (!okBuild) problems.push(`${label}: \`build\` must be a function`)
    const okPatch = v.patch === undefined || typeof v.patch === 'function'
    if (!okPatch) problems.push(`${label}: \`patch\` must be a function`)

    let sourcesOk = sourcesIsObject && (sourceEntries.length > 0 || hasBase)
    const resolvedSources: ResolvedViewSource[] = []
    for (const [key, s] of sourceEntries) {
      const sLabel = `${label}: source "${key}"`
      if (key === 'base') {
        // `RuleResult.source` reports the base as "base"; a source of that name would be indistinguishable in logs.
        problems.push(`${label}: source key "base" is reserved`)
        sourcesOk = false
        continue
      }
      if (!s || typeof s !== 'object') {
        problems.push(`${sLabel}: must be an object`)
        sourcesOk = false
        continue
      }
      const collection = pattern(s.collection, sLabel, 'collection')
      const hasIdField = s.idField !== undefined
      const hasIdParam = s.idParam !== undefined
      const hasRefField = s.refField !== undefined
      const kindCount = [hasIdField, hasIdParam, hasRefField].filter(Boolean).length
      if (kindCount !== 1) problems.push(`${sLabel}: exactly one of \`idField\`, \`idParam\` or \`refField\` is required`)

      const okIdField = hasIdField ? fieldPath(s.idField, sLabel, 'idField') : false
      const okRefField = hasRefField ? fieldPath(s.refField, sLabel, 'refField') : false
      let okIdParam = false
      if (hasIdParam) {
        if (!str(s.idParam)) {
          problems.push(`${sLabel}: \`idParam\` must be a placeholder name`)
        } else if (collection && !collection.params.includes(s.idParam)) {
          problems.push(`${sLabel}: \`idParam\` {${s.idParam}} is not a placeholder of \`collection\``)
        } else if (collection) {
          okIdParam = true
        }
      }

      const orderBy: { field: string; direction: 'asc' | 'desc' }[] = []
      let okOrderBy = true
      if (s.orderBy !== undefined) {
        if (!Array.isArray(s.orderBy)) {
          problems.push(`${sLabel}: \`orderBy\` must be an array of field paths or [field, 'asc' | 'desc']`)
          okOrderBy = false
        } else {
          for (const entry of s.orderBy) {
            if (typeof entry === 'string') {
              if (!isValidFieldPath(entry)) {
                problems.push(`${sLabel}: \`orderBy\` entry "${entry}" is not a valid field path`)
                okOrderBy = false
              } else orderBy.push({ field: entry, direction: 'asc' })
            } else if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string') {
              const [field, direction] = entry
              if (!isValidFieldPath(field)) {
                problems.push(`${sLabel}: \`orderBy\` entry "${field}" is not a valid field path`)
                okOrderBy = false
              } else if (direction !== 'asc' && direction !== 'desc') {
                problems.push(`${sLabel}: \`orderBy\` entry "${field}" direction must be 'asc' | 'desc'`)
                okOrderBy = false
              } else {
                orderBy.push({ field, direction })
              }
            } else {
              problems.push(`${sLabel}: \`orderBy\` must be an array of field paths or [field, 'asc' | 'desc']`)
              okOrderBy = false
            }
          }
        }
      }

      let okLimit = true
      if (s.limit !== undefined && (typeof s.limit !== 'number' || !Number.isInteger(s.limit) || s.limit <= 0)) {
        problems.push(`${sLabel}: \`limit\` must be a positive integer`)
        okLimit = false
      }

      let watch: string[] | undefined
      let okWatch = true
      if (s.watch !== undefined) {
        if (!Array.isArray(s.watch) || s.watch.length === 0 || !s.watch.every((f) => typeof f === 'string' && isValidFieldPath(f))) {
          problems.push(`${sLabel}: \`watch\` must be a non-empty array of field paths`)
          okWatch = false
        } else {
          watch = s.watch
        }
      }

      if (hasRefField) {
        if (s.orderBy !== undefined) problems.push(`${sLabel}: \`orderBy\` does not apply to a \`refField\` source`)
        if (s.limit !== undefined) problems.push(`${sLabel}: \`limit\` does not apply to a \`refField\` source`)
      }

      if (collection && target) {
        if (collection.key === target.key) problems.push(`${label}: source "${key}" and \`target\` must be different collections`)
        if (hasIdParam && str(s.idParam)) {
          if (target.params.includes(s.idParam)) problems.push(`${label}: \`idParam\` {${s.idParam}} must not appear in \`target\``)
          const unbound = collection.params.filter((p) => p !== s.idParam && !target.params.includes(p))
          if (unbound.length) problems.push(`${label}: placeholder(s) {${unbound.join('}, {')}} of source "${key}" must appear in \`target\``)
          const missing = target.params.filter((p) => !collection.params.includes(p))
          if (missing.length) problems.push(`${label}: placeholder(s) {${missing.join('}, {')}} of \`target\` must also appear in source "${key}"`)
        }
        if (hasIdField) {
          // A changed source locates its target from its own path, so every target placeholder must be bound there.
          const missing = target.params.filter((p) => !collection.params.includes(p))
          if (missing.length) problems.push(`${label}: placeholder(s) {${missing.join('}, {')}} of \`target\` must also appear in source "${key}"`)
        }
        if (hasRefField) {
          const missing = collection.params.filter((p) => !target.params.includes(p))
          if (missing.length) problems.push(`${label}: placeholder(s) {${missing.join('}, {')}} of source "${key}" must also appear in \`target\``)
        }
      }

      if (okRefField) {
        for (const f of explicit) {
          if (fieldPathsOverlap(s.refField!, f)) problems.push(`${sLabel}: \`refField\` "${s.refField}" and \`targetFields\` must not overlap ("${f}")`)
        }
      }

      if (target && okRefField) idFields.push({ target, field: s.refField! })

      const kindOk = hasIdField ? okIdField : hasRefField ? okRefField : hasIdParam ? okIdParam : false
      const sourceValid = collection !== undefined && kindCount === 1 && kindOk && okOrderBy && okLimit && okWatch
      if (sourceValid) {
        // A `watch` list always covers the fields that decide membership and order, or the view could go stale silently.
        if (watch) watch = [...new Set([...watch, ...(s.idField !== undefined ? [s.idField] : []), ...orderBy.map((o) => o.field)])]
        resolvedSources.push({ key, collection: s.collection, pattern: collection!, idField: s.idField, idParam: s.idParam, refField: s.refField, orderBy, limit: s.limit, watch })
      } else {
        sourcesOk = false
      }
    }

    if (target && okTargetFields) for (const f of explicit) writtenFields.push({ rule: label, target, field: f })

    const scheduled = schedule(v, label)
    const deferred = deferResolver(v, label)
    if (target && okTargetFields && okBuild && okPatch && sourcesOk && okBase && scheduled !== null && deferred !== null) {
      resolvedViews.push({
        kind: 'view',
        name: v.name,
        target: v.target,
        targetFields: explicit,
        rest: restCount === 1,
        reservedRootKeys: [],
        base: v.base,
        basePattern,
        targetPattern: target,
        sources: resolvedSources,
        build: v.build,
        patch: v.patch,
        projection,
        scheduled: scheduled ?? undefined,
        deferred: deferred ?? undefined,
      })
    }
  })

  // Two `rest` views on one target would each delete what the other wrote.
  const restOwner = new Map<string, string>()
  for (const view of resolvedViews) {
    if (!view.rest) continue
    const prev = restOwner.get(view.targetPattern.key)
    if (prev) problems.push(`view "${view.name}": only one view per target may declare 'rest' (view "${prev}" already does)`)
    else restOwner.set(view.targetPattern.key, view.name)
  }
  // `rest` owns every root key no rule declares: collect the declared roots per target collection.
  for (const view of resolvedViews) {
    if (!view.rest) continue
    const roots = new Set<string>()
    for (const w of writtenFields) if (w.target.key === view.targetPattern.key) roots.add(splitFieldPath(w.field)[0]!)
    for (const id of idFields) if (id.target.key === view.targetPattern.key) roots.add(splitFieldPath(id.field)[0]!)
    view.reservedRootKeys = [...roots].sort()
  }

  // Two rules must not write overlapping fields of the same collection
  for (let i = 0; i < writtenFields.length; i++) {
    for (let j = i + 1; j < writtenFields.length; j++) {
      const a = writtenFields[i]!
      const b = writtenFields[j]!
      if (a.target.key === b.target.key && fieldPathsOverlap(a.field, b.field)) {
        problems.push(`${b.rule}: target field "${b.target.raw}.${b.field}" overlaps "${a.field}" written by ${a.rule}`)
      }
    }
  }
  // A written field must not be an idField of a rule on the same collection
  for (const w of writtenFields) {
    if (idFields.some((id) => id.target.key === w.target.key && fieldPathsOverlap(id.field, w.field))) {
      problems.push(`${w.rule}: target field "${w.target.raw}.${w.field}" is used as an \`idField\` by another rule`)
    }
  }

  const cycle = findCycle([...resolvedConnections, ...resolvedAggregates, ...resolvedViews])
  if (cycle) problems.push(`rules form a loop (each one's write triggers the next): ${cycle.join(' -> ')}`)

  // Two different patterns must not match the same documents: events would be processed twice and the overlap checks above would miss them.
  const patterns = collectionsOf({ connections: resolvedConnections, aggregates: resolvedAggregates, views: resolvedViews })
  for (let i = 0; i < patterns.length; i++) {
    for (let j = i + 1; j < patterns.length; j++) {
      if (patternsIntersect(patterns[i]!, patterns[j]!)) {
        problems.push(`collections "${patterns[i]!.raw}" and "${patterns[j]!.raw}" can match the same documents; use one pattern for them`)
      }
    }
  }

  if (str(config.name)) {
    const seen = new Map<string, string>()
    for (const p of patterns) {
      const trigger = triggerName(config.name, p)
      if (!TRIGGER_NAME.test(trigger) || trigger.length > TRIGGER_NAME_MAX) {
        problems.push(
          `trigger name "${trigger}" (collection "${p.raw}") must match ${TRIGGER_NAME} and be at most ${TRIGGER_NAME_MAX} characters`,
        )
      }
      const other = seen.get(trigger)
      if (other) problems.push(`collections "${other}" and "${p.raw}" both map to trigger "${trigger}"`)
      else seen.set(trigger, p.raw)
    }
  }

  if (problems.length) throw new ConfigError(problems)

  return {
    ...config,
    resolved: true,
    database: config.database ?? '(default)',
    serviceRegion: config.serviceRegion ?? config.region,
    connections: resolvedConnections,
    aggregates: resolvedAggregates,
    views: resolvedViews,
  }
}

/**
 * Every collection that is a source or a target of some rule, one entry per distinct
 * collection (placeholder names ignored), sorted by path. One trigger is created per entry.
 */
export function collectionsOf(config: {
  connections?: readonly { source: string; target: string }[]
  aggregates?: readonly { source: string; target: string }[]
  views?: readonly { target: string; base?: string; sources?: Record<string, { collection: string }> | readonly { collection: string }[] }[]
}): CollectionPattern[] {
  const byKey = new Map<string, CollectionPattern>()
  const add = (raw: unknown) => {
    if (typeof raw !== 'string') return
    try {
      const p = parseCollectionPattern(raw)
      if (!byKey.has(p.key)) byKey.set(p.key, p)
    } catch {
      // reported by validateConfig
    }
  }
  for (const r of [...(config.connections ?? []), ...(config.aggregates ?? [])]) {
    add(r.source)
    add(r.target)
  }
  for (const v of config.views ?? []) {
    add(v?.target)
    add(v?.base)
    const sources = v?.sources
    if (sources && typeof sources === 'object') for (const s of Object.values(sources)) add((s as { collection?: unknown })?.collection)
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** Rules that run on a schedule instead of on events. */
export function scheduledRules(config: ResolvedConfig): ResolvedRule[] {
  return rulesOf(config).filter((r) => r.scheduled !== undefined)
}

/** Rules whose recompute is deferred instead of running on every event. */
export function deferredRules(config: ResolvedConfig): ResolvedRule[] {
  return rulesOf(config).filter((r) => r.deferred !== undefined)
}

/**
 * Collections that need an Eventarc trigger: every source, target and base of the rules that
 * run on events. A collection used only by scheduled rules gets no trigger.
 */
export function triggerCollectionsOf(config: ResolvedConfig): CollectionPattern[] {
  const byKey = new Map<string, CollectionPattern>()
  const add = (p: CollectionPattern | undefined) => {
    if (p && !byKey.has(p.key)) byKey.set(p.key, p)
  }
  for (const r of rulesOf(config)) {
    if (r.scheduled) continue
    add(r.targetPattern)
    if (r.kind === 'view') {
      add(r.basePattern)
      for (const s of r.sources) add(s.pattern)
    } else add(r.sourcePattern)
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** 8 hex chars of sha256 over the instance name and a resource key: composite names stay unique across instances and across slugs that coincide. */
export function resourceHash(instanceName: string, key: string): string {
  return createHash('sha256').update(`${instanceName}\n${key}`).digest('hex').slice(0, 8)
}

/** `<instance>-<slug>` cut to the prefix budget, never ending in a hyphen. */
function resourcePrefix(instanceName: string, slug: string): string {
  return `${instanceName}-${slug}`.slice(0, RESOURCE_PREFIX_MAX).replace(/-+$/, '')
}

/** Eventarc trigger name: `<instance>-<collection ids joined by ->-<hash>`, lower-case, `_` replaced by `-`. */
export function triggerName(instanceName: string, collection: string | CollectionPattern): string {
  const p = typeof collection === 'string' ? parseCollectionPattern(collection) : collection
  return `${resourcePrefix(instanceName, patternSlug(p))}-${resourceHash(instanceName, p.key)}`
}

/** Cloud Scheduler job name of a scheduled rule: `<instance>-<rule>-<hash>`. */
export function jobName(instanceName: string, rule: string): string {
  return `${resourcePrefix(instanceName, rule)}-${resourceHash(instanceName, rule)}`
}

/** Whether running the rule on a change of its source needs a collection-group query (and the matching index). */
export function needsCollectionGroupQuery(rule: ResolvedRule): boolean {
  return collectionGroupQueries(rule).length > 0
}

/**
 * The collection-group queries a rule may run, as `{ collection, field }` (the field needs a
 * collection-group index). Empty when every query targets a concrete collection.
 */
export function collectionGroupQueries(rule: ResolvedRule): { collection: string; field: string }[] {
  if (rule.kind === 'connection') {
    return isResolvable(rule.targetPattern, rule.sourcePattern.params) ? [] : [{ collection: rule.target, field: rule.idField }]
  }
  if (rule.kind === 'aggregate') {
    return rule.idField !== undefined && !isResolvable(rule.sourcePattern, rule.targetPattern.params)
      ? [{ collection: rule.source, field: rule.idField }]
      : []
  }
  const queries: { collection: string; field: string }[] = []
  for (const s of rule.sources) {
    if (s.idField !== undefined && !isResolvable(s.pattern, rule.targetPattern.params)) {
      queries.push({ collection: s.collection, field: s.idField })
    }
    if (s.refField !== undefined && !isResolvable(rule.targetPattern, s.pattern.params)) {
      queries.push({ collection: rule.target, field: s.refField })
    }
  }
  return queries
}

/** One rule's write that makes another rule run: `from` writes `field` (`collection.path`) which `to` watches. */
export interface WriteTrigger {
  from: string
  field: string
  to: string
}

/**
 * Every (writer, watcher) pair among the rules: `a` writes `a.targetField` on a collection
 * that `b` reads as a source, and `b` watches that field (or any field). Order: writers in
 * config order, then watchers in config order.
 */
export function writeTriggers(config: ResolvedConfig): WriteTrigger[] {
  return writeTriggerEdges(rulesOf(config))
}

function writeTriggerEdges(rules: ResolvedRule[]): WriteTrigger[] {
  const watchers = (r: ResolvedRule): { key: string; fields: string[] | undefined }[] => {
    if (r.scheduled) return []
    if (r.kind === 'connection') return [{ key: r.sourcePattern.key, fields: r.fields }]
    if (r.kind === 'aggregate') return [{ key: r.sourcePattern.key, fields: r.watchedFields }]
    return [...(r.basePattern ? [{ key: r.basePattern.key, fields: undefined }] : []), ...r.sources.map((s) => ({ key: s.pattern.key, fields: s.watch }))]
  }
  /** Field paths a rule writes; `undefined` when it may write any field (`rest`). */
  const written = (r: ResolvedRule): string[] | undefined => (r.kind === 'view' ? (r.rest ? undefined : r.targetFields) : [r.targetField])
  const edges: WriteTrigger[] = []
  for (const a of rules) {
    const fields = written(a)
    for (const b of rules) {
      const hit = watchers(b).some(
        (w) => w.key === a.targetPattern.key && (w.fields === undefined || fields === undefined || w.fields.some((f) => fields.some((t) => fieldPathsOverlap(f, t)))),
      )
      if (hit) edges.push({ from: a.name, field: `${a.target}.${fields ? fields.join(',') : '*'}`, to: b.name })
    }
  }
  return edges
}

/**
 * Finds a loop of rules where each rule's write changes a field the next rule watches on
 * the same collection. Chains without such a loop always terminate because a rule skips
 * when none of its watched fields changed.
 */
function findCycle(rules: ResolvedRule[]): string[] | undefined {
  const next = new Map<string, string[]>()
  for (const r of rules) next.set(r.name, [])
  for (const e of writeTriggerEdges(rules)) next.get(e.from)!.push(e.to)
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (node: string): string[] | undefined => {
    state.set(node, 'visiting')
    stack.push(node)
    for (const n of next.get(node) ?? []) {
      const s = state.get(n)
      if (s === 'visiting') return [...stack.slice(stack.indexOf(n)), n]
      if (s === undefined) {
        const found = visit(n)
        if (found) return found
      }
    }
    stack.pop()
    state.set(node, 'done')
    return undefined
  }
  for (const r of rules) {
    if (!state.has(r.name)) {
      const found = visit(r.name)
      if (found) return found
    }
  }
  return undefined
}
