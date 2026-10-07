/**
 * Configuration types and validation.
 *
 * The same config object is consumed by the Cloud Run handler
 * (`createDocSyncHandler`) and by the CLI (`doc-sync validate|setup|deploy|rebuild|dev`).
 */
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

export type ResolvedRule = ResolvedConnection | ResolvedAggregate

/** Config with defaults applied and patterns parsed. */
export interface ResolvedConfig extends DocSyncConfig {
  database: string
  serviceRegion: string
  connections: ResolvedConnection[]
  aggregates: ResolvedAggregate[]
}

/** Identity helper that gives you type checking and completion in `doc-sync.config.ts`. */
export function defineConfig(config: DocSyncConfig): DocSyncConfig {
  return config
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
  if (!Array.isArray(connections)) problems.push('`connections` must be an array')
  if (!Array.isArray(aggregates)) problems.push('`aggregates` must be an array')
  const connList = Array.isArray(connections) ? connections : []
  const aggList = Array.isArray(aggregates) ? aggregates : []
  if (connList.length + aggList.length === 0) problems.push('at least one entry in `connections` or `aggregates` is required')

  const names = new Map<string, string>()
  const writtenFields: { rule: string; target: CollectionPattern; field: string }[] = []
  const idFields: { target: CollectionPattern; field: string }[] = []
  const resolvedConnections: ResolvedConnection[] = []
  const resolvedAggregates: ResolvedAggregate[] = []

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

  const cycle = findCycle([...resolvedConnections, ...resolvedAggregates])
  if (cycle) problems.push(`rules form a loop (each one's write triggers the next): ${cycle.join(' -> ')}`)

  if (str(config.name)) {
    const seen = new Map<string, string>()
    for (const p of collectionsOf({ connections: resolvedConnections, aggregates: resolvedAggregates })) {
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
    database: config.database ?? '(default)',
    serviceRegion: config.serviceRegion ?? config.region,
    connections: resolvedConnections,
    aggregates: resolvedAggregates,
  }
}

/**
 * Every collection that is a source or a target of some rule, one entry per distinct
 * collection (placeholder names ignored), sorted by path. One trigger is created per entry.
 */
export function collectionsOf(config: {
  connections?: readonly { source: string; target: string }[]
  aggregates?: readonly { source: string; target: string }[]
}): CollectionPattern[] {
  const byKey = new Map<string, CollectionPattern>()
  for (const r of [...(config.connections ?? []), ...(config.aggregates ?? [])]) {
    for (const raw of [r.source, r.target]) {
      if (typeof raw !== 'string') continue
      try {
        const p = parseCollectionPattern(raw)
        if (!byKey.has(p.key)) byKey.set(p.key, p)
      } catch {
        // reported by validateConfig
      }
    }
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
  if (rule.kind === 'connection') return !isResolvable(rule.targetPattern, rule.sourcePattern.params)
  return rule.idField !== undefined && !isResolvable(rule.sourcePattern, rule.targetPattern.params)
}

/**
 * Finds a loop of rules where each rule's write changes a field the next rule watches on
 * the same collection. Chains without such a loop always terminate because a rule skips
 * when none of its watched fields changed.
 */
function findCycle(rules: ResolvedRule[]): string[] | undefined {
  const watched = (r: ResolvedRule) => (r.kind === 'connection' ? r.fields : r.watchedFields)
  const next = new Map<string, string[]>()
  for (const a of rules) {
    next.set(
      a.name,
      rules
        .filter((b) => b.sourcePattern.key === a.targetPattern.key && watched(b).some((f) => fieldPathsOverlap(f, a.targetField)))
        .map((b) => b.name),
    )
  }
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
