/**
 * Pure functions that turn a config into gcloud invocations. Kept free of I/O so they can be unit tested.
 */
import { collectionsOf, triggerName, type ResolvedConfig } from '../config.js'
import { type CollectionPattern, eventarcPathPattern, normalizePathPattern } from '../paths.js'

export const INSTANCE_LABEL = 'doc-sync-instance'
export const EVENT_TYPE = 'google.cloud.firestore.document.v1.written'

export function serviceAccountEmail(config: Pick<ResolvedConfig, 'serviceAccount'>, project: string): string {
  return config.serviceAccount.includes('@')
    ? config.serviceAccount
    : `${config.serviceAccount}@${project}.iam.gserviceaccount.com`
}

export interface TriggerSpec {
  name: string
  collection: CollectionPattern
}

export function desiredTriggers(config: ResolvedConfig): TriggerSpec[] {
  return collectionsOf(config).map((collection) => ({ name: triggerName(config.name, collection), collection }))
}

/** Subset of the Eventarc Trigger resource as printed by `gcloud eventarc triggers list --format=json`. */
export interface ExistingTrigger {
  name: string
  labels?: Record<string, string>
  destination?: { cloudRun?: { service?: string; region?: string } }
  eventFilters?: { attribute: string; value: string; operator?: string }[]
  serviceAccount?: string
  eventDataContentType?: string
}

/** Keeps only triggers that belong to this instance and strips the resource path from the name. */
export function ownedTriggers(all: ExistingTrigger[], instanceName: string): ExistingTrigger[] {
  return all
    .filter((t) => t.labels?.[INSTANCE_LABEL] === instanceName)
    .map((t) => ({ ...t, name: t.name.split('/').pop() ?? t.name }))
}

export interface TriggerPlan {
  create: TriggerSpec[]
  /** Exists but differs from the config (destination, filters, service account, ...). */
  update: { trigger: TriggerSpec; differences: string[] }[]
  remove: string[]
  keep: TriggerSpec[]
}

export function planTriggers(
  desired: TriggerSpec[],
  existing: ExistingTrigger[],
  expected?: { config: ResolvedConfig; project: string },
): TriggerPlan {
  const byName = new Map(existing.map((t) => [t.name, t]))
  const desiredNames = new Set(desired.map((t) => t.name))
  const plan: TriggerPlan = { create: [], update: [], keep: [], remove: [] }
  for (const t of desired) {
    const current = byName.get(t.name)
    if (!current) plan.create.push(t)
    else {
      const differences = expected ? triggerDifferences(expected.config, expected.project, t, current) : []
      if (differences.length) plan.update.push({ trigger: t, differences })
      else plan.keep.push(t)
    }
  }
  plan.remove = [...byName.keys()].filter((n) => !desiredNames.has(n)).sort()
  return plan
}

/** Human-readable list of fields where the existing trigger does not match the config. */
export function triggerDifferences(
  config: ResolvedConfig,
  project: string,
  trigger: TriggerSpec,
  current: ExistingTrigger,
): string[] {
  const diffs: string[] = []
  const filter = (attr: string) => current.eventFilters?.find((f) => f.attribute === attr)
  const check = (label: string, actual: string | undefined, wanted: string, norm = (x: string) => x) => {
    if (actual !== undefined && norm(actual) !== norm(wanted)) diffs.push(`${label}: ${actual} -> ${wanted}`)
  }
  check('service', current.destination?.cloudRun?.service, config.service)
  check('service region', current.destination?.cloudRun?.region, config.serviceRegion)
  check('event type', filter('type')?.value, EVENT_TYPE)
  check('database', filter('database')?.value, config.database)
  check('document', filter('document')?.value, eventarcPathPattern(trigger.collection), normalizePathPattern)
  check('service account', current.serviceAccount, serviceAccountEmail(config, project))
  check('content type', current.eventDataContentType, 'application/protobuf')
  return diffs
}

export function triggerCreateArgs(config: ResolvedConfig, project: string, trigger: TriggerSpec): string[] {
  return ['eventarc', 'triggers', 'create', trigger.name, ...triggerSettingsArgs(config, project, trigger), `--labels=${INSTANCE_LABEL}=${config.name}`]
}

/** `gcloud eventarc triggers update` accepts the same settings flags as `create`. */
export function triggerUpdateArgs(config: ResolvedConfig, project: string, trigger: TriggerSpec): string[] {
  return ['eventarc', 'triggers', 'update', trigger.name, ...triggerSettingsArgs(config, project, trigger)]
}

function triggerSettingsArgs(config: ResolvedConfig, project: string, trigger: TriggerSpec): string[] {
  return [
    `--project=${project}`,
    `--location=${config.region}`,
    `--destination-run-service=${config.service}`,
    `--destination-run-region=${config.serviceRegion}`,
    `--event-filters=type=${EVENT_TYPE}`,
    `--event-filters=database=${config.database}`,
    `--event-filters-path-pattern=document=${eventarcPathPattern(trigger.collection)}`,
    '--event-data-content-type=application/protobuf',
    `--service-account=${serviceAccountEmail(config, project)}`,
  ]
}

export function triggerDeleteArgs(config: ResolvedConfig, project: string, name: string): string[] {
  return ['eventarc', 'triggers', 'delete', name, `--project=${project}`, `--location=${config.region}`, '--quiet']
}

export function triggerListArgs(config: ResolvedConfig, project: string): string[] {
  return ['eventarc', 'triggers', 'list', `--project=${project}`, `--location=${config.region}`, '--format=json']
}
