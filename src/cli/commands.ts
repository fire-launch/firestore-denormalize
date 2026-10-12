import { collectionGroupQueries, scheduleQueueName, scheduledRules, type ResolvedConfig, type ResolvedRule, writeTriggers } from '../config.js'
import { estimateCost, formatChains } from '../cost.js'
import { startDevBridge } from '../dev.js'
import { rebuild as runRebuild } from '../rebuild.js'
import { verify as runVerify } from '../verify.js'
import type { Logger } from '../logger.js'
import { eventarcPathPattern } from '../paths.js'
import { CommandError, type Runner } from './exec.js'
import {
  desiredJobs,
  desiredTriggers,
  type ExistingJob,
  type ExistingQueue,
  type ExistingTrigger,
  type JobPlan,
  jobCreateArgs,
  jobDeleteArgs,
  jobListArgs,
  jobUpdateArgs,
  ownedJobs,
  ownedTriggers,
  planJobs,
  planTriggers,
  queueCreateArgs,
  queueDescribeArgs,
  queueDifferences,
  queueUpdateArgs,
  serviceAccountEmail,
  serviceUrlArgs,
  triggerCreateArgs,
  triggerDeleteArgs,
  triggerListArgs,
  triggerUpdateArgs,
} from './plan.js'

export interface Context {
  config: ResolvedConfig
  configPath: string
  project: string
  runner: Runner
  log: (line?: string) => void
}

export function printSummary(ctx: Context): void {
  const { config, log } = ctx
  log(`Config:          ${ctx.configPath}`)
  log(`Instance:        ${config.name}`)
  log(`Project:         ${ctx.project}`)
  log(`Region:          ${config.region}`)
  log(`Database:        ${config.database}`)
  log(`Service:         ${config.service} (${config.serviceRegion})`)
  log(`Service account: ${serviceAccountEmail(config, ctx.project)}`)
  log()
  if (config.connections.length) {
    log(`Connections (${config.connections.length}):`)
    for (const c of config.connections) {
      log(`  ${c.name}: ${c.source}.{${c.fields.join(',')}} -> ${c.target}.${c.targetField} (by ${c.idField}, onDelete=${c.onSourceDelete})`)
    }
    log()
  }
  if (config.aggregates.length) {
    log(`Aggregates (${config.aggregates.length}):`)
    for (const a of config.aggregates) {
      const agg = a.aggregate === 'count' ? 'count()' : `sum(${a.aggregate.sum})`
      const by = a.idField ? `by ${a.idField}` : `by {${a.idParam}}`
      log(`  ${a.name}: ${agg} of ${a.source} -> ${a.target}.${a.targetField} (${by})`)
    }
    log()
  }
  if (config.views.length) {
    log(`Views (${config.views.length}):`)
    for (const v of config.views) {
      const shape = `${v.target}.{${[...v.targetFields, ...(v.rest ? ['rest'] : [])].join(',')}}`
      const via = v.projection ? `projection of ${v.base}` : `build(${[...(v.base ? ['base'] : []), ...v.sources.map((s) => s.key)].join(', ')})`
      log(`  ${v.name}: ${via} -> ${shape}${v.base && !v.projection ? ` (base ${v.base}: target exists iff base exists)` : ''}`)
      for (const s of v.sources) {
        const by = s.idField ? `by ${s.idField}` : s.idParam !== undefined ? `by {${s.idParam}}` : `via target.${s.refField}`
        const order = s.orderBy.length ? `, order by ${s.orderBy.map((o) => `${o.field} ${o.direction}`).join(', ')}` : ''
        const limit = s.limit !== undefined ? `, limit ${s.limit}` : ''
        const watch = s.watch !== undefined ? `, watch ${s.watch.join(',')}` : ''
        log(`      ${s.key}: ${s.collection} (${by})${order}${limit}${watch}`)
      }
    }
    log()
  }
  const allRules: ResolvedRule[] = [...config.connections, ...config.aggregates, ...config.views]
  const groupEntries = allRules.flatMap((r) => collectionGroupQueries(r).map((q) => ({ rule: r.name, ...q })))
  if (groupEntries.length) {
    log('Collection-group queries (need a collection-group index on the field, Firestore prints the link on first use):')
    for (const e of groupEntries) log(`  ${e.rule}: ${e.collection}.${e.field}`)
    log()
  }
  const scheduled = scheduledRules(config)
  if (scheduled.length) {
    log(`Scheduled rules (${scheduled.length}) — synced by Cloud Scheduler via /schedule/<rule>, not by events:`)
    for (const r of scheduled) log(`  ${r.name}: ${r.scheduled!.cron} (${r.scheduled!.timeZone})`)
    log(`  continuation queue: ${scheduleQueueName(config.name)} (${config.serviceRegion})`)
    log()
  }
  const triggers = desiredTriggers(config)
  if (triggers.length) {
    log(`Triggers (one per collection used by event-driven rules):`)
    for (const t of triggers) log(`  ${t.name}  <-  ${eventarcPathPattern(t.collection)}`)
  } else {
    log('Triggers: none (every rule is scheduled)')
  }
}

export function validate(ctx: Context, opts: { strict?: boolean } = {}): void {
  printSummary(ctx)
  ctx.log()

  const { config, log } = ctx
  const rules: ResolvedRule[] = [...config.connections, ...config.aggregates, ...config.views]
  const costs = rules.map((r) => estimateCost(r))
  const maxTrigger = Math.max(0, ...costs.flatMap((c) => c.lines.map((l) => l.trigger.length)))

  log('Cost per event (N = targets matching the changed source, M = source documents of one target, T = targets of a scheduled rule (one run)):')
  for (const cost of costs) {
    log(`  ${cost.rule}`)
    for (const line of cost.lines) {
      log(`    ${line.trigger.padEnd(maxTrigger + 3)}reads ${line.reads}, writes ${line.writes}`)
    }
  }

  const chains = formatChains(writeTriggers(config))
  if (chains.length) {
    log()
    log("Write chains (a rule's write starts the next rule):")
    for (const chain of chains) log(`  ${chain}`)
  }

  const warnings = costs.flatMap((c) => c.warnings.map((w) => `${c.rule}: ${w}`))
  if (warnings.length) {
    log()
    log('Warnings:')
    for (const w of warnings) log(`  ${w}`)
  }

  log()
  log('Config is valid.')

  if (opts.strict && warnings.length) {
    throw new Error(`${warnings.length} warning(s); failing because of --strict`)
  }
}

export function setup(ctx: Context, opts: { runtimeServiceAccount?: string } = {}): void {
  const { config, project, runner, log } = ctx
  const email = serviceAccountEmail(config, project)
  const saId = email.split('@')[0]!
  const scheduledCount = scheduledRules(config).length
  const total = scheduledCount ? 5 : 4

  log(`# 1/${total} Enable APIs`)
  const apis = ['eventarc.googleapis.com', 'run.googleapis.com', ...(scheduledCount ? ['cloudscheduler.googleapis.com', 'cloudtasks.googleapis.com'] : [])]
  runner.mutate('gcloud', ['services', 'enable', ...apis, `--project=${project}`])

  log(`# 2/${total} Trigger service account`)
  if (exists(() => runner.read('gcloud', ['iam', 'service-accounts', 'describe', email, `--project=${project}`]))) {
    log(`  ${email} already exists, skipped`)
  } else {
    runner.mutate('gcloud', [
      'iam',
      'service-accounts',
      'create',
      saId,
      `--display-name=Eventarc triggers for ${config.name}`,
      `--project=${project}`,
    ])
  }

  log(`# 3/${total} Grant roles/eventarc.eventReceiver on the project`)
  runner.mutate('gcloud', [
    'projects',
    'add-iam-policy-binding',
    project,
    `--member=serviceAccount:${email}`,
    '--role=roles/eventarc.eventReceiver',
    '--condition=None',
    '--format=none',
  ])

  log(`# 4/${total} Grant roles/run.invoker on Cloud Run service "${config.service}"`)
  const serviceExists = exists(() =>
    runner.read('gcloud', [
      'run',
      'services',
      'describe',
      config.service,
      `--region=${config.serviceRegion}`,
      `--project=${project}`,
      '--format=value(metadata.name)',
    ]),
  )
  if (serviceExists || runner.dryRun) {
    runner.mutate('gcloud', [
      'run',
      'services',
      'add-iam-policy-binding',
      config.service,
      `--region=${config.serviceRegion}`,
      `--project=${project}`,
      `--member=serviceAccount:${email}`,
      '--role=roles/run.invoker',
      '--format=none',
    ])
  } else {
    log(`  Cloud Run service "${config.service}" does not exist yet in ${config.serviceRegion}.`)
    log(`  Deploy the function first, then run \`doc-sync setup\` again, or set`)
    log(`  \`invoker: '${email}'\` in onRequest() so firebase deploy grants it.`)
  }

  if (scheduledCount) {
    const queue = scheduleQueueName(config.name)
    log(`# 5/5 Cloud Tasks queue "${queue}" for scheduled-run continuation`)
    let current: ExistingQueue | undefined
    try {
      current = (JSON.parse(runner.read('gcloud', queueDescribeArgs(config, project, queue)) || 'null') as ExistingQueue | null) ?? undefined
    } catch (err) {
      if (!(err instanceof CommandError && NOT_FOUND.test(err.stderr))) throw err
    }
    if (!current) {
      runner.mutate('gcloud', queueCreateArgs(config, project, queue))
    } else {
      const differences = queueDifferences(current)
      if (differences.length) {
        log(`  ~ ${queue} (${differences.join(', ')})`)
        runner.mutate('gcloud', queueUpdateArgs(config, project, queue))
      } else log(`  ${queue} already exists, skipped`)
    }
    const rt = opts.runtimeServiceAccount
    if (rt) {
      runner.mutate('gcloud', [
        'tasks',
        'queues',
        'add-iam-policy-binding',
        queue,
        `--location=${config.serviceRegion}`,
        `--project=${project}`,
        `--member=serviceAccount:${rt}`,
        '--role=roles/cloudtasks.enqueuer',
        '--format=none',
      ])
      runner.mutate('gcloud', [
        'iam',
        'service-accounts',
        'add-iam-policy-binding',
        email,
        `--project=${project}`,
        `--member=serviceAccount:${rt}`,
        '--role=roles/iam.serviceAccountUser',
        '--format=none',
      ])
    } else {
      log('  The function enqueues continuation tasks with its runtime service account, which needs two grants.')
      log('  Re-run with --runtime-service-account <email> to apply them, or run:')
      log(`    gcloud tasks queues add-iam-policy-binding ${queue} --location=${config.serviceRegion} --project=${project} --member=serviceAccount:<runtime-sa> --role=roles/cloudtasks.enqueuer`)
      log(`    gcloud iam service-accounts add-iam-policy-binding ${email} --project=${project} --member=serviceAccount:<runtime-sa> --role=roles/iam.serviceAccountUser`)
      log('  (the default runtime SA is <project-number>-compute@developer.gserviceaccount.com)')
    }
  } else if (opts.runtimeServiceAccount) {
    log('  --runtime-service-account ignored: no rule has a schedule.')
  }

  log()
  log('Setup complete.')
}

export function deploy(ctx: Context, opts: { deployFunction?: string }): void {
  const { config, project, runner, log } = ctx
  printSummary(ctx)
  log()

  if (opts.deployFunction) {
    log(`# Deploy function ${opts.deployFunction}`)
    runner.mutate('firebase', ['deploy', '--only', `functions:${opts.deployFunction}`, `--project=${project}`])
    log()
  }

  log('# Eventarc triggers')
  const raw = runner.read('gcloud', triggerListArgs(config, project))
  const existing = ownedTriggers(JSON.parse(raw || '[]') as ExistingTrigger[], config.name)
  const plan = planTriggers(desiredTriggers(config), existing, { config, project })

  for (const t of plan.keep) log(`  = ${t.name} (exists)`)
  for (const t of plan.create) {
    log(`  + ${t.name}`)
    runner.mutate('gcloud', triggerCreateArgs(config, project, t))
  }
  for (const { trigger, differences } of plan.update) {
    log(`  ~ ${trigger.name} (${differences.join(', ')})`)
    runner.mutate('gcloud', triggerUpdateArgs(config, project, trigger))
  }
  for (const name of plan.remove) {
    log(`  - ${name}`)
    runner.mutate('gcloud', triggerDeleteArgs(config, project, name))
  }

  const jobs = desiredJobs(config)
  let existingJobs: ExistingJob[] = []
  let schedulerDisabled = false
  try {
    const rawJobs = runner.read('gcloud', jobListArgs(config, project))
    existingJobs = ownedJobs(JSON.parse(rawJobs || '[]') as ExistingJob[], config.name)
  } catch (err) {
    if (err instanceof CommandError && SCHEDULER_DISABLED.test(err.stderr)) schedulerDisabled = true
    else throw err
  }

  let jobPlan: JobPlan = { create: [], update: [], keep: [], remove: [] }
  if (jobs.length || existingJobs.length) {
    log()
    log('# Cloud Scheduler jobs (scheduled rules)')
  }

  if (schedulerDisabled) {
    if (jobs.length) log('  Cloud Scheduler API is not enabled; run `doc-sync setup` first.')
  } else {
    let serviceUrl: string | undefined
    if (jobs.length) {
      try {
        serviceUrl = runner.read('gcloud', serviceUrlArgs(config, project)).trim() || undefined
      } catch (err) {
        if (!(err instanceof CommandError && NOT_FOUND.test(err.stderr))) throw err
      }
      if (!serviceUrl && runner.dryRun) serviceUrl = 'https://<service-url>'
    }
    if (serviceUrl) {
      jobPlan = planJobs(jobs, existingJobs, { config, project, serviceUrl })
    } else {
      jobPlan = planJobs(jobs, existingJobs, undefined)
      if (jobs.length) {
        jobPlan = { ...jobPlan, create: [], update: [] }
        log(`  Cloud Run service "${config.service}" does not exist yet in ${config.serviceRegion}; jobs need its URL.`)
        log('  Deploy the function first, then run `doc-sync deploy` again.')
      }
    }

    for (const j of jobPlan.keep) log(`  = ${j.name} (exists)`)
    for (const j of jobPlan.create) {
      log(`  + ${j.name} (${j.cron} ${j.timeZone})`)
      runner.mutate('gcloud', jobCreateArgs(config, project, j, serviceUrl!))
    }
    for (const { job, differences } of jobPlan.update) {
      log(`  ~ ${job.name} (${differences.join(', ')})`)
      runner.mutate('gcloud', jobUpdateArgs(config, project, job, serviceUrl!))
    }
    for (const name of jobPlan.remove) {
      log(`  - ${name}`)
      runner.mutate('gcloud', jobDeleteArgs(config, project, name))
    }
  }

  log()
  log(
    `${runner.dryRun ? '[dry-run] ' : ''}created ${plan.create.length}, updated ${plan.update.length}, deleted ${plan.remove.length}, unchanged ${plan.keep.length}` +
      (jobs.length || existingJobs.length
        ? `; jobs: created ${jobPlan.create.length}, updated ${jobPlan.update.length}, deleted ${jobPlan.remove.length}, unchanged ${jobPlan.keep.length}`
        : ''),
  )
}

const NOT_FOUND = /NOT_FOUND|not found|cannot find|does not exist/i
const SCHEDULER_DISABLED = /(has not been used|is not enabled|SERVICE_DISABLED|API .* not enabled|cloudscheduler\.googleapis\.com)/i

/** Returns true when the read-only command succeeds, false when gcloud reports "not found". Any other failure (auth, permissions, ...) is rethrown. */
function exists(read: () => string): boolean {
  try {
    read()
    return true
  } catch (err) {
    if (err instanceof CommandError && NOT_FOUND.test(err.stderr)) return false
    throw err
  }
}

/** Creates a Firestore instance for the CLI (ADC in production, or the emulator when FIRESTORE_EMULATOR_HOST is set). */
async function cliFirestore(ctx: Context) {
  const { initializeApp, getApps } = await import('firebase-admin/app')
  const { getFirestore } = await import('firebase-admin/firestore')
  const app = getApps()[0] ?? initializeApp({ projectId: ctx.project })
  return ctx.config.database === '(default)' ? getFirestore(app) : getFirestore(app, ctx.config.database)
}

/** Human-readable logger for CLI commands (the handler's JSON logger is for Cloud Logging). */
export function cliLogger(log: (line?: string) => void): Logger {
  const fmt = (message: string, fields?: Record<string, unknown>) => {
    const rest = fields
      ? ' ' +
        Object.entries(fields)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${v instanceof Error ? v.message : typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
          .join(' ')
      : ''
    return `${message.replace(/^doc-sync( \w+)?: /, '')}${rest}`
  }
  return {
    info: (m, f) => log(fmt(m, f)),
    warn: (m, f) => log(`warning: ${fmt(m, f)}`),
    error: (m, f) => log(`error: ${fmt(m, f)}`),
  }
}

export async function rebuild(
  ctx: Context,
  opts: { rules?: string[]; dryRun: boolean; startAfter?: string; pageSize?: number },
): Promise<void> {
  const { log } = ctx
  const firestore = await cliFirestore(ctx)
  const emulator = process.env.FIRESTORE_EMULATOR_HOST
  log(`Rebuilding ${opts.rules?.length ? opts.rules.join(', ') : 'all rules'} in ${emulator ? `emulator ${emulator}` : `project ${ctx.project}`}${opts.dryRun ? ' (dry run)' : ''}`)
  log()
  const results = await runRebuild(ctx.config, {
    firestore,
    logger: cliLogger(log),
    rules: opts.rules,
    dryRun: opts.dryRun,
    startAfter: opts.startAfter,
    pageSize: opts.pageSize,
    onProgress: (p) => log(`  ${p.rule}: scanned ${p.scanned}, ${opts.dryRun ? 'would write' : 'written'} ${p.written}, last ${p.lastPath}`),
  })
  log()
  for (const r of results) {
    log(`${r.rule}: ${r.scanned} documents, ${r.written} ${r.dryRun ? 'would be written' : 'written'} (${r.reads} reads, ${r.queries} queries, ${r.aggregations} aggregations)`)
  }
  log()
  log(opts.dryRun ? 'Dry run complete. Re-run without --dry-run to apply.' : 'Rebuild complete.')
}

/** `cliLogger`, but drops the `doc-sync verify: mismatch` info line (the CLI prints its own line for each mismatch via `onMismatch`). */
function verifyLogger(log: (line?: string) => void): Logger {
  const base = cliLogger(log)
  return {
    ...base,
    info: (m, f) => {
      if (!m.startsWith('doc-sync verify: mismatch')) base.info(m, f)
    },
  }
}

export async function verify(
  ctx: Context,
  opts: { rules?: string[]; fix: boolean; startAfter?: string; pageSize?: number },
): Promise<boolean> {
  const { log } = ctx
  const firestore = await cliFirestore(ctx)
  const emulator = process.env.FIRESTORE_EMULATOR_HOST
  log(`Verifying ${opts.rules?.length ? opts.rules.join(', ') : 'all rules'} in ${emulator ? `emulator ${emulator}` : `project ${ctx.project}`}${opts.fix ? ' (fix)' : ''}`)
  log()
  const results = await runVerify(ctx.config, {
    firestore,
    logger: verifyLogger(log),
    rules: opts.rules,
    fix: opts.fix,
    startAfter: opts.startAfter,
    pageSize: opts.pageSize,
    onMismatch: (m) => {
      const actual = m.actual === undefined ? '(absent)' : JSON.stringify(m.actual)
      const expected = m.expected === undefined ? '(absent)' : JSON.stringify(m.expected)
      const detail = m.issue === 'value' ? `${m.document}.${m.field}  actual=${actual}  expected=${expected}` : `${m.document}  ${m.issue}`
      log(`  ${m.rule}: ${detail}${m.fixed ? '  fixed' : ''}`)
    },
    onProgress: (p) => log(`  ${p.rule}: scanned ${p.scanned}, mismatched ${p.mismatched}, fixed ${p.fixed}, last ${p.lastPath}`),
  })
  log()
  for (const r of results) {
    log(`${r.rule}: ${r.scanned} documents, ${r.mismatched} mismatched, ${r.fixed} fixed (${r.reads} reads, ${r.queries} queries, ${r.aggregations} aggregations)`)
  }
  log()
  const totalMismatched = results.reduce((n, r) => n + r.mismatched, 0)
  const totalFixed = results.reduce((n, r) => n + r.fixed, 0)
  if (totalMismatched === 0) {
    log('All derived data is up to date.')
  } else if (opts.fix) {
    log(`${totalMismatched} mismatch(es) found, ${totalFixed} fixed.`)
  } else {
    log(`${totalMismatched} mismatch(es) found. Re-run with --fix to repair.`)
  }
  return totalMismatched === totalFixed
}

export async function dev(ctx: Context, opts: { url: string; emulatorHost?: string }): Promise<void> {
  const { log } = ctx
  if (opts.emulatorHost) process.env.FIRESTORE_EMULATOR_HOST = opts.emulatorHost
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('doc-sync dev only works against the Firestore emulator: set FIRESTORE_EMULATOR_HOST or pass --emulator-host host:port')
  }
  const firestore = await cliFirestore(ctx)
  log(`Bridging Firestore emulator ${process.env.FIRESTORE_EMULATOR_HOST} (project ${ctx.project}) -> ${opts.url}`)
  log('Existing documents are cached silently; changes from now on are delivered. Ctrl+C to stop.')
  log()
  const bridge = startDevBridge(ctx.config, { firestore, url: opts.url, project: ctx.project, logger: cliLogger(log) })
  await bridge.ready
  await new Promise<void>((resolve) => {
    const stop = () => {
      bridge.stop()
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  await bridge.idle()
  log('stopped')
}
