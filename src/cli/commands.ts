import { type ResolvedConfig } from '../config.js'
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
  log(`Connections (${config.connections.length}):`)
  for (const c of config.connections) {
    log(`  ${c.name}: ${c.source}.{${c.fields.join(',')}} -> ${c.target}.${c.targetField} (by ${c.idField}, onDelete=${c.onSourceDelete})`)
  }
  log()
  const triggers = desiredTriggers(config)
  log(`Triggers (${triggers.length}, one per collection):`)
  for (const t of triggers) log(`  ${t.name}  <-  ${t.collection}/{docId}`)
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
