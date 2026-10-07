import { needsCollectionGroupQuery, type ResolvedConfig } from '../config.js'
import { startDevBridge } from '../dev.js'
import { rebuild as runRebuild } from '../rebuild.js'
import type { Logger } from '../logger.js'
import { eventarcPathPattern } from '../paths.js'
import { CommandError, type Runner } from './exec.js'
import {
  desiredTriggers,
  type ExistingTrigger,
  ownedTriggers,
  planTriggers,
  serviceAccountEmail,
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
  const groupRules = [...config.connections, ...config.aggregates].filter(needsCollectionGroupQuery)
  if (groupRules.length) {
    log('Collection-group queries (need a collection-group index on the field, Firestore prints the link on first use):')
    for (const r of groupRules) {
      const field = r.kind === 'connection' ? `${r.target}.${r.idField}` : `${r.source}.${r.idField}`
      log(`  ${r.name}: ${field}`)
    }
    log()
  }
  const triggers = desiredTriggers(config)
  log(`Triggers (${triggers.length}, one per collection):`)
  for (const t of triggers) log(`  ${t.name}  <-  ${eventarcPathPattern(t.collection)}`)
}

export function validate(ctx: Context): void {
  printSummary(ctx)
  ctx.log()
  ctx.log('Config is valid.')
}

export function setup(ctx: Context): void {
  const { config, project, runner, log } = ctx
  const email = serviceAccountEmail(config, project)
  const saId = email.split('@')[0]!

  log('# 1/4 Enable APIs')
  runner.mutate('gcloud', ['services', 'enable', 'eventarc.googleapis.com', 'run.googleapis.com', `--project=${project}`])

  log('# 2/4 Trigger service account')
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

  log('# 3/4 Grant roles/eventarc.eventReceiver on the project')
  runner.mutate('gcloud', [
    'projects',
    'add-iam-policy-binding',
    project,
    `--member=serviceAccount:${email}`,
    '--role=roles/eventarc.eventReceiver',
    '--condition=None',
    '--format=none',
  ])

  log(`# 4/4 Grant roles/run.invoker on Cloud Run service "${config.service}"`)
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
  log()
  log(
    `${runner.dryRun ? '[dry-run] ' : ''}created ${plan.create.length}, updated ${plan.update.length}, deleted ${plan.remove.length}, unchanged ${plan.keep.length}`,
  )
}

const NOT_FOUND = /NOT_FOUND|not found|cannot find|does not exist/i

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
    log(`${r.rule}: ${r.scanned} targets, ${r.written} ${r.dryRun ? 'would be written' : 'written'}`)
  }
  log()
  log(opts.dryRun ? 'Dry run complete. Re-run without --dry-run to apply.' : 'Rebuild complete.')
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
