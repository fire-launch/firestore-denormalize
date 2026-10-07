/**
 * Configuration types and validation.
 *
 * The same config object is consumed by the Cloud Run handler
 * (`createDocSyncHandler`) and by the CLI (`doc-sync validate|setup|deploy`).
 */

/** What to write into `targetField` when the source document no longer exists. */
export type OnSourceDelete = 'setNull' | 'deleteField' | 'nothing'

/** One denormalization rule: copy `fields` of `source/{id}` into `target.{targetField}`. */
export interface Connection {
  /** Unique name, used in logs. */
  name: string
  /** Top-level collection the data is copied from. */
  source: string
  /** Top-level collection the data is copied to. */
  target: string
  /** Field on the target holding the source document ID (a string). */
  idField: string
  /** Top-level field names to copy from the source. Missing fields are omitted. */
  fields: string[]
  /** Field on the target that receives the copied map. */
  targetField: string
  /** Behaviour when the source document is missing/deleted. */
  onSourceDelete: OnSourceDelete
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
  connections: Connection[]
}

/** Config with defaults applied. */
export interface ResolvedConfig extends DocSyncConfig {
  database: string
  serviceRegion: string
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
/** Field names are used both as Firestore field paths and as literal keys of decoded payloads, so path syntax is not allowed. */
const FIELD_NAME_FORBIDDEN = /[.~*/[\]]/
const TRIGGER_NAME = /^[a-z][a-z0-9-]*$/
const TRIGGER_NAME_MAX = 63

/**
 * Validates the config and applies defaults. Throws {@link ConfigError} listing every problem found.
 */
export function validateConfig(config: DocSyncConfig): ResolvedConfig {
  const problems: string[] = []
  const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

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

  const connections = Array.isArray(config.connections) ? config.connections : []
  if (!Array.isArray(config.connections) || connections.length === 0) {
    problems.push('`connections` must be a non-empty array')
  }

  const names = new Map<string, number>()
  const targetFields = new Map<string, { connection: string; target: string; field: string }>()
  const targetIdFields = new Map<string, Set<string>>()

  connections.forEach((c, i) => {
    const label = str(c?.name) ? `connection "${c.name}"` : `connections[${i}]`
    if (!c || typeof c !== 'object') {
      problems.push(`${label}: must be an object`)
      return
    }
    if (!str(c.name)) problems.push(`${label}: \`name\` is required`)
    else {
      const seen = names.get(c.name)
      if (seen !== undefined) problems.push(`${label}: duplicate name (also connections[${seen}])`)
      names.set(c.name, i)
    }
    for (const key of ['source', 'target', 'idField', 'targetField'] as const) {
      if (!str(c[key])) problems.push(`${label}: \`${key}\` is required`)
    }
    for (const key of ['source', 'target'] as const) {
      if (str(c[key]) && c[key].includes('/')) {
        problems.push(`${label}: \`${key}\` must be a top-level collection (subcollections are not supported): "${c[key]}"`)
      }
    }
    for (const key of ['idField', 'targetField'] as const) {
      if (str(c[key]) && FIELD_NAME_FORBIDDEN.test(c[key])) {
        problems.push(`${label}: \`${key}\` must be a top-level field name without . ~ * / [ ]: "${c[key]}"`)
      }
    }
    if (str(c.source) && str(c.target) && c.source === c.target) {
      problems.push(`${label}: \`source\` and \`target\` must be different collections`)
    }
    if (!Array.isArray(c.fields) || c.fields.length === 0 || !c.fields.every(str)) {
      problems.push(`${label}: \`fields\` must be a non-empty array of field names`)
    } else {
      const dup = c.fields.find((f, j) => c.fields.indexOf(f) !== j)
      if (dup) problems.push(`${label}: \`fields\` contains "${dup}" more than once`)
      const bad = c.fields.find((f) => FIELD_NAME_FORBIDDEN.test(f))
      if (bad) problems.push(`${label}: \`fields\` must be top-level field names without . ~ * / [ ]: "${bad}"`)
    }
    if (!['setNull', 'deleteField', 'nothing'].includes(c.onSourceDelete)) {
      problems.push(`${label}: \`onSourceDelete\` must be 'setNull' | 'deleteField' | 'nothing'`)
    }
    if (str(c.idField) && str(c.targetField) && c.idField === c.targetField) {
      problems.push(`${label}: \`idField\` and \`targetField\` must be different`)
    }
    if (str(c.target) && str(c.targetField)) {
      const key = JSON.stringify([c.target, c.targetField])
      const other = targetFields.get(key)
      if (other) {
        problems.push(`${label}: target field "${c.target}.${c.targetField}" is already written by connection "${other.connection}"`)
      } else targetFields.set(key, { connection: c.name, target: c.target, field: c.targetField })
    }
    if (str(c.target) && str(c.idField)) {
      if (!targetIdFields.has(c.target)) targetIdFields.set(c.target, new Set())
      targetIdFields.get(c.target)!.add(c.idField)
    }
  })

  // A targetField of one connection must not be the idField of another on the same target
  for (const { connection, target, field } of targetFields.values()) {
    if (targetIdFields.get(target)?.has(field)) {
      problems.push(`connection "${connection}": target field "${target}.${field}" is used as an \`idField\` by another connection`)
    }
  }

  const cycle = findCycle(connections.filter((c) => str(c?.source) && str(c?.target)))
  if (cycle) problems.push(`circular dependency between collections: ${cycle.join(' -> ')}`)

  if (str(config.name)) {
    const seen = new Map<string, string>()
    for (const collection of collectionsOf({ connections })) {
      const trigger = triggerName(config.name, collection)
      if (!TRIGGER_NAME.test(trigger) || trigger.length > TRIGGER_NAME_MAX) {
        problems.push(
          `trigger name "${trigger}" (collection "${collection}") must match ${TRIGGER_NAME} and be at most ${TRIGGER_NAME_MAX} characters`,
        )
      }
      const other = seen.get(trigger)
      if (other) problems.push(`collections "${other}" and "${collection}" both map to trigger "${trigger}"`)
      else seen.set(trigger, collection)
    }
  }

  if (problems.length) throw new ConfigError(problems)

  return {
    ...config,
    database: config.database ?? '(default)',
    serviceRegion: config.serviceRegion ?? config.region,
  }
}

/** Sorted list of every collection that is a source or a target. One trigger is created per collection. */
export function collectionsOf(config: Pick<DocSyncConfig, 'connections'>): string[] {
  const set = new Set<string>()
  for (const c of config.connections ?? []) {
    if (typeof c?.source === 'string') set.add(c.source)
    if (typeof c?.target === 'string') set.add(c.target)
  }
  return [...set].sort()
}

/** Eventarc trigger name for a collection: `<instance>-<collection>` with `_` replaced by `-`. */
export function triggerName(instanceName: string, collection: string): string {
  return `${instanceName}-${collection.replace(/_/g, '-')}`
}

/** Returns the first cycle found in the source -> target graph, or undefined. */
function findCycle(connections: Connection[]): string[] | undefined {
  const edges = new Map<string, Set<string>>()
  for (const c of connections) {
    if (!edges.has(c.source)) edges.set(c.source, new Set())
    edges.get(c.source)!.add(c.target)
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (node: string): string[] | undefined => {
    state.set(node, 'visiting')
    stack.push(node)
    for (const next of edges.get(node) ?? []) {
      const s = state.get(next)
      if (s === 'visiting') return [...stack.slice(stack.indexOf(next)), next]
      if (s === undefined) {
        const found = visit(next)
        if (found) return found
      }
    }
    stack.pop()
    state.set(node, 'done')
    return undefined
  }

  for (const node of edges.keys()) {
    if (!state.has(node)) {
      const found = visit(node)
      if (found) return found
    }
  }
  return undefined
}
