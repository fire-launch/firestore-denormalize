/**
 * Pure functions that turn a config into gcloud invocations. Kept free of I/O so they can be unit tested.
 */
import { jobName, scheduledRules, serviceAccountEmail, triggerCollectionsOf, triggerName, type ResolvedConfig } from '../config.js'
import { type CollectionPattern, eventarcPathPattern, normalizePathPattern } from '../paths.js'

export const INSTANCE_LABEL = 'doc-sync-instance'
export const EVENT_TYPE = 'google.cloud.firestore.document.v1.written'

export { jobName, serviceAccountEmail } from '../config.js'

export interface TriggerSpec {
  name: string
  collection: CollectionPattern
}

export function desiredTriggers(config: ResolvedConfig): TriggerSpec[] {
  return triggerCollectionsOf(config).map((collection) => ({ name: triggerName(config.name, collection), collection }))
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

// ---------------------------------------------------------------- Cloud Scheduler jobs (scheduled rules)

export const SCHEDULE_PATH = '/schedule/'

export interface JobSpec {
  name: string
  rule: string
  cron: string
  timeZone: string
}

/** One Cloud Scheduler job per scheduled rule. */
export function desiredJobs(config: ResolvedConfig): JobSpec[] {
  return scheduledRules(config).map((r) => ({ name: jobName(config.name, r.name), rule: r.name, cron: r.scheduled!.cron, timeZone: r.scheduled!.timeZone }))
}

/** Subset of the Scheduler Job resource as printed by `gcloud scheduler jobs list --format=json`. */
export interface ExistingJob {
  name: string
  description?: string
  schedule?: string
  timeZone?: string
  httpTarget?: { uri?: string; httpMethod?: string; oidcToken?: { serviceAccountEmail?: string; audience?: string } }
  retryConfig?: { retryCount?: number; minBackoffDuration?: string }
}

/** Jobs have no labels, so ownership is recorded in the description. Strips the resource path from the name. */
export function ownedJobs(all: ExistingJob[], instanceName: string): ExistingJob[] {
  return all
    .filter((j) => j.description === `${INSTANCE_LABEL}=${instanceName}`)
    .map((j) => ({ ...j, name: j.name.split('/').pop() ?? j.name }))
}

export interface JobPlan {
  create: JobSpec[]
  update: { job: JobSpec; differences: string[] }[]
  remove: string[]
  keep: JobSpec[]
}

export function planJobs(desired: JobSpec[], existing: ExistingJob[], expected?: { config: ResolvedConfig; project: string; serviceUrl: string }): JobPlan {
  const byName = new Map(existing.map((j) => [j.name, j]))
  const desiredNames = new Set(desired.map((j) => j.name))
  const plan: JobPlan = { create: [], update: [], keep: [], remove: [] }
  for (const job of desired) {
    const current = byName.get(job.name)
    if (!current) plan.create.push(job)
    else {
      const differences = expected ? jobDifferences(expected.config, expected.project, job, current, expected.serviceUrl) : []
      if (differences.length) plan.update.push({ job, differences })
      else plan.keep.push(job)
    }
  }
  plan.remove = [...byName.keys()].filter((n) => !desiredNames.has(n)).sort()
  return plan
}

export function jobDifferences(config: ResolvedConfig, project: string, job: JobSpec, current: ExistingJob, serviceUrl: string): string[] {
  const diffs: string[] = []
  const check = (label: string, actual: string | undefined, wanted: string) => {
    if (actual !== undefined && actual !== wanted) diffs.push(`${label}: ${actual} -> ${wanted}`)
  }
  check('schedule', current.schedule, job.cron)
  check('time zone', current.timeZone, job.timeZone)
  check('uri', current.httpTarget?.uri, jobUri(serviceUrl, job))
  check('http method', current.httpTarget?.httpMethod, 'POST')
  check('service account', current.httpTarget?.oidcToken?.serviceAccountEmail, serviceAccountEmail(config, project))
  check('audience', current.httpTarget?.oidcToken?.audience, serviceUrl)
  check('retry attempts', current.retryConfig?.retryCount?.toString(), '3')
  check('min backoff', current.retryConfig?.minBackoffDuration, '60s')
  return diffs
}

function jobUri(serviceUrl: string, job: JobSpec): string {
  return `${serviceUrl.replace(/\/+$/, '')}${SCHEDULE_PATH}${encodeURIComponent(job.rule)}`
}

function jobSettingsArgs(config: ResolvedConfig, project: string, job: JobSpec, serviceUrl: string): string[] {
  return [
    `--project=${project}`,
    `--location=${config.serviceRegion}`,
    `--schedule=${job.cron}`,
    `--time-zone=${job.timeZone}`,
    `--uri=${jobUri(serviceUrl, job)}`,
    '--http-method=POST',
    `--oidc-service-account-email=${serviceAccountEmail(config, project)}`,
    `--oidc-token-audience=${serviceUrl}`,
    '--attempt-deadline=1800s',
    '--max-retry-attempts=3',
    '--min-backoff=60s',
    `--description=${INSTANCE_LABEL}=${config.name}`,
  ]
}

export function jobCreateArgs(config: ResolvedConfig, project: string, job: JobSpec, serviceUrl: string): string[] {
  return ['scheduler', 'jobs', 'create', 'http', job.name, ...jobSettingsArgs(config, project, job, serviceUrl)]
}

export function jobUpdateArgs(config: ResolvedConfig, project: string, job: JobSpec, serviceUrl: string): string[] {
  return ['scheduler', 'jobs', 'update', 'http', job.name, ...jobSettingsArgs(config, project, job, serviceUrl)]
}

export function jobDeleteArgs(config: ResolvedConfig, project: string, name: string): string[] {
  return ['scheduler', 'jobs', 'delete', name, `--project=${project}`, `--location=${config.serviceRegion}`, '--quiet']
}

export function jobListArgs(config: ResolvedConfig, project: string): string[] {
  return ['scheduler', 'jobs', 'list', `--project=${project}`, `--location=${config.serviceRegion}`, '--format=json']
}

/** Prints the Cloud Run service URL (empty / NOT_FOUND before the first deploy). */
export function serviceUrlArgs(config: ResolvedConfig, project: string): string[] {
  return ['run', 'services', 'describe', config.service, `--region=${config.serviceRegion}`, `--project=${project}`, '--format=value(status.url)']
}
