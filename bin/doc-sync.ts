import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { ConfigError } from '../src/config.js'
import { deploy, setup, validate, type Context } from '../src/cli/commands.js'
import { createRunner } from '../src/cli/exec.js'
import { DEFAULT_CONFIG_PATH, loadConfig } from '../src/cli/load-config.js'
import { spawnSync } from 'node:child_process'

const HELP = `doc-sync — sync denormalized Firestore documents with one function and per-collection Eventarc triggers

Usage:
  doc-sync validate [--config <path>]
  doc-sync setup    [--config <path>] [--project <id>] [--dry-run]
  doc-sync deploy   [--config <path>] [--project <id>] [--dry-run] [--deploy-function <name>]

Commands:
  validate   Check the config and list the collections and trigger names
  setup      Create the trigger service account, grant roles, enable APIs (idempotent)
  deploy     Create missing / delete stale Eventarc triggers for this instance

Options:
  --config <path>           Config file (default: ${DEFAULT_CONFIG_PATH})
  --project <id>            GCP project (default: $GOOGLE_CLOUD_PROJECT, then gcloud's active project)
  --dry-run                 Print the gcloud commands instead of running them
  --deploy-function <name>  Also run \`firebase deploy --only functions:<name>\` before touching triggers
  -h, --help                Show this help
  -v, --version             Show the version
`

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      project: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'deploy-function': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  })
  const log = (line = '') => console.log(line)

  if (values.version) {
    const pkg = createRequire(import.meta.url)('../package.json') as { version: string }
    log(pkg.version)
    return 0
  }
  const command = positionals[0]
  if (values.help || !command) {
    log(HELP)
    return values.help ? 0 : 1
  }
  if (!['validate', 'setup', 'deploy'].includes(command)) {
    console.error(`unknown command: ${command}\n`)
    log(HELP)
    return 1
  }

  const { path, config } = await loadConfig(values.config)
  const project = command === 'validate' ? (values.project ?? resolveProject(false)) : resolveProject(true, values.project)
  const ctx: Context = {
    config,
    configPath: path,
    project: project ?? '<project>',
    runner: createRunner({ dryRun: values['dry-run'], log }),
    log,
  }

  switch (command) {
    case 'validate':
      validate(ctx)
      break
    case 'setup':
      setup(ctx)
      break
    case 'deploy':
      deploy(ctx, { deployFunction: values['deploy-function'] })
      break
  }
  return 0
}

function resolveProject(required: true, flag?: string): string
function resolveProject(required: false, flag?: string): string | undefined
function resolveProject(required: boolean, flag?: string): string | undefined {
  const fromEnv = flag ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? process.env.CLOUDSDK_CORE_PROJECT
  if (fromEnv) return fromEnv
  const r = spawnSync('gcloud', ['config', 'get-value', 'project'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
  })
  const fromGcloud = r.status === 0 ? r.stdout.trim() : ''
  if (fromGcloud && fromGcloud !== '(unset)') return fromGcloud
  if (required) throw new Error('no project: pass --project <id> or set GOOGLE_CLOUD_PROJECT')
  return undefined
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ConfigError) console.error(err.message)
    else console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)
