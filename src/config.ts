/**
 * Configuration types and validation.
 *
 * The same config object is consumed by the Cloud Run handler
 * (`createDocSyncHandler`) and by the CLI (`doc-sync validate|setup|deploy|rebuild|dev`).
 */
import type { DocumentData, DocumentSnapshot, Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { fieldPathsOverlap, isValidFieldPath } from './fields.js'
import { type CollectionPattern, isResolvable, parseCollectionPattern, patternSlug } from './paths.js'

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
  /** The Firestore instance the handler uses, for a small extra read (e.g. refilling a "latest N" list after a delete). */
  firestore: Firestore
}

/**
 * View: keep `target.{targetField}` equal to `build(...)`, a value computed by user code
 * from the documents of one or more source collections. For shapes the other rules
 * cannot express: "latest N items", a map keyed by id, a custom summary.
 */
export interface ViewRule<S extends Record<string, ViewSource> = Record<string, ViewSource>, T = unknown> {
  /** Unique name, used in logs. */
  name: string
  /** Collection holding the derived value. */
  target: string
  /** Field on the target that receives the value. */
  targetField: string
  /** Source collections keyed by the name used in `build` / `patch`. */
  sources: S
  /**
   * Recomputes the whole value from a fresh read of every source. Must be deterministic.
   * Return `undefined` to delete `targetField`. Used by the handler, `rebuild` and `verify`.
   */
  build(ctx: BuildContext<S>): T | undefined | Promise<T | undefined>
  /**
   * Optional fast path: derive the new value from the current one and the changed document
   * (one fresh read) instead of reading every source. Return `undefined` to fall back to
   * `build`. Events can be delivered more than once and out of order, so `patch` must be
   * idempotent and must only use `change.after` (the current state) to decide what the item
   * looks like, keyed by document id. `rebuild` and `verify` never use it.
   */
  patch?(current: T | undefined, change: ViewChange, ctx: PatchContext): T | undefined | Promise<T | undefined>
}

export interface DocSyncConfig {
  /** Instance name. Used for trigger names and labels (lowercase letters, digits, hyphens). */
  name: string
  /** Eventarc trigger location. Must match the Firestore database location (e.g. `asia-northeast1`, `nam5`). */
  region: string
  /** Firestore database ID. Defaults to `(default)`. */
  database?: string
  /** Name of the Cloud Run service (the deployed function) that receives events. */
  service: string
  /** Region of the Cloud Run service. Defaults to `region`. */
  serviceRegion?: string
  /** Service account used by the triggers. A bare ID is expanded to `<id>@<project>.iam.gserviceaccount.com`. */
  serviceAccount: string
  connections?: Connection[]
  aggregates?: AggregateRule[]
  views?: ViewRule[]
}

export interface ResolvedConnection extends Connection {
  kind: 'connection'
  sourcePattern: CollectionPattern
  targetPattern: CollectionPattern
}

export interface ResolvedAggregate extends AggregateRule {
  kind: 'aggregate'
  sourcePattern: CollectionPattern
  targetPattern: CollectionPattern
  /** Source fields whose change requires a recompute (`idField` and/or the summed field). */
  watchedFields: string[]
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
  targetField: string
  targetPattern: CollectionPattern
  sources: ResolvedViewSource[]
  build: ViewRule['build']
  patch?: ViewRule['patch']
}

export type ResolvedRule = ResolvedConnection | ResolvedAggregate | ResolvedView

/** Config with defaults applied and patterns parsed. */
export interface ResolvedConfig extends Omit<DocSyncConfig, 'views'> {
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

/** Validates a raw config, or returns an already resolved one unchanged. */
export function resolveConfig(config: DocSyncConfig | ResolvedConfig): ResolvedConfig {
  return (config as ResolvedConfig).resolved === true ? (config as ResolvedConfig) : validateConfig(config as DocSyncConfig)
}

/** Identity helper that types `build` / `patch` from the view's own `sources` keys. */
export function defineView<S extends Record<string, ViewSource>, T>(view: ViewRule<S, T>): ViewRule<S, T> {
  return view
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
const TRIGGER_NAME = /^[a-z][a-z0-9-]*$/
const TRIGGER_NAME_MAX = 63

const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

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
  if (!str(config.serviceAccount)) problems.push('`serviceAccount` is required')
  if (config.database !== undefined && !str(config.database)) problems.push('`database` must be a non-empty string')
  if (config.serviceRegion !== undefined && !str(config.serviceRegion)) {
    problems.push('`serviceRegion` must be a non-empty string')
  }

  const connections = config.connections === undefined ? [] : config.connections
  const aggregates = config.aggregates === undefined ? [] : config.aggregates
  const views = config.views === undefined ? [] : config.views
  if (!Array.isArray(connections)) problems.push('`connections` must be an array')
  if (!Array.isArray(aggregates)) problems.push('`aggregates` must be an array')
  if (!Array.isArray(views)) problems.push('`views` must be an array')
  const connList = Array.isArray(connections) ? connections : []
  const aggList = Array.isArray(aggregates) ? aggregates : []
  const viewList = Array.isArray(views) ? views : []
  if (connList.length + aggList.length + viewList.length === 0) {
    problems.push('at least one entry in `connections` or `aggregates` is required')
  }

  const names = new Map<string, string>()
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

  connList.forEach((c, i) => {
    const label = str(c?.name) ? `connection "${c.name}"` : `connections[${i}]`
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
    if (source && target && okId && okTarget && okFields) {
      resolvedConnections.push({ ...c, kind: 'connection', sourcePattern: source, targetPattern: target })
    }
  })

  aggList.forEach((a, i) => {
    const label = str(a?.name) ? `aggregate "${a.name}"` : `aggregates[${i}]`
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
      }
    }
    if (target && okTarget) writtenFields.push({ rule: label, target, field: a.targetField })
    if (source && target && okTarget && (okId || (hasIdParam && str(a.idParam))) && (a.aggregate === 'count' || sumField)) {
      const watched = [a.idField, sumField].filter((f): f is string => typeof f === 'string')
      resolvedAggregates.push({ ...a, kind: 'aggregate', sourcePattern: source, targetPattern: target, watchedFields: watched })
    }
  })

  viewList.forEach((v, i) => {
    const label = str(v?.name) ? `view "${v.name}"` : `views[${i}]`
    if (!v || typeof v !== 'object') {
      problems.push(`${label}: must be an object`)
      return
    }
    checkName(v, label)
    const target = pattern(v.target, label, 'target')
    const okTargetField = fieldPath(v.targetField, label, 'targetField')

    const sourcesIsObject = v.sources !== null && typeof v.sources === 'object' && !Array.isArray(v.sources)
    if (!sourcesIsObject) problems.push(`${label}: \`sources\` must be an object keyed by source name`)
    const sourceEntries: [string, ViewSource][] = sourcesIsObject ? Object.entries(v.sources as Record<string, ViewSource>) : []
    if (sourcesIsObject && sourceEntries.length === 0) problems.push(`${label}: \`sources\` must have at least one entry`)

    const okBuild = typeof v.build === 'function'
    if (!okBuild) problems.push(`${label}: \`build\` must be a function`)
    const okPatch = v.patch === undefined || typeof v.patch === 'function'
    if (!okPatch) problems.push(`${label}: \`patch\` must be a function`)

    let sourcesOk = sourceEntries.length > 0
    const resolvedSources: ResolvedViewSource[] = []
    for (const [key, s] of sourceEntries) {
      const sLabel = `${label}: source "${key}"`
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

      if (okRefField && okTargetField && fieldPathsOverlap(s.refField!, v.targetField)) {
        problems.push(`${sLabel}: \`refField\` "${s.refField}" and \`targetField\` must not overlap`)
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

    if (target && okTargetField) writtenFields.push({ rule: label, target, field: v.targetField })

    if (target && okTargetField && okBuild && okPatch && sourcesOk) {
      resolvedViews.push({
        kind: 'view',
        name: v.name,
        target: v.target,
        targetField: v.targetField,
        targetPattern: target,
        sources: resolvedSources,
        build: v.build,
        patch: v.patch,
      })
    }
  })

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

  if (str(config.name)) {
    const seen = new Map<string, string>()
    for (const p of collectionsOf({ connections: resolvedConnections, aggregates: resolvedAggregates, views: resolvedViews })) {
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
  views?: readonly { target: string; sources: Record<string, { collection: string }> | readonly { collection: string }[] }[]
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
    const sources = v?.sources
    if (sources && typeof sources === 'object') for (const s of Object.values(sources)) add((s as { collection?: unknown })?.collection)
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** Eventarc trigger name: `<instance>-<collection ids joined by ->`, `_` replaced by `-`. */
export function triggerName(instanceName: string, collection: string | CollectionPattern): string {
  const p = typeof collection === 'string' ? parseCollectionPattern(collection) : collection
  return `${instanceName}-${patternSlug(p)}`
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
    if (r.kind === 'connection') return [{ key: r.sourcePattern.key, fields: r.fields }]
    if (r.kind === 'aggregate') return [{ key: r.sourcePattern.key, fields: r.watchedFields }]
    return r.sources.map((s) => ({ key: s.pattern.key, fields: s.watch }))
  }
  const edges: WriteTrigger[] = []
  for (const a of rules) {
    for (const b of rules) {
      const hit = watchers(b).some((w) => w.key === a.targetPattern.key && (w.fields === undefined || w.fields.some((f) => fieldPathsOverlap(f, a.targetField))))
      if (hit) edges.push({ from: a.name, field: `${a.target}.${a.targetField}`, to: b.name })
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
