import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { ConfigError } from '../src/config.js'
import { deploy, dev, rebuild, setup, validate, verify, type Context } from '../src/cli/commands.js'
import { createRunner } from '../src/cli/exec.js'
import { DEFAULT_CONFIG_PATH, loadConfig } from '../src/cli/load-config.js'
import { spawnSync } from 'node:child_process'

const HELP = `doc-sync — sync denormalized Firestore documents with one function and per-collection Eventarc triggers

Usage:
  doc-sync validate [--config <path>] [--strict]
  doc-sync setup    [--config <path>] [--project <id>] [--dry-run]
  doc-sync deploy   [--config <path>] [--project <id>] [--dry-run] [--deploy-function <name>]
  doc-sync rebuild  [--config <path>] [--project <id>] [--dry-run] [--rule <name>]... [--start-after <path>] [--page-size <n>]
  doc-sync verify   [--config <path>] [--project <id>] [--fix] [--rule <name>]... [--start-after <path>] [--page-size <n>]
  doc-sync dev      [--config <path>] [--project <id>] --url <handler url> [--emulator-host <host:port>]

Commands:
  validate   Check the config and list the collections and trigger names
  setup      Create the trigger service account, grant roles, enable APIs (idempotent)
  deploy     Create missing / update drifted / delete stale Eventarc triggers for this instance
  rebuild    Bring every existing target in line with its source (backfill); --dry-run only reports
  verify     Recompute every derived value and report mismatches; --fix repairs them
  dev        Forward Firestore emulator changes to the handler as CloudEvents (local development)

Options:
  --config <path>           Config file (default: ${DEFAULT_CONFIG_PATH})
  --strict                  validate: exit 1 when the cost estimate has warnings
  --project <id>            GCP project (default: $GOOGLE_CLOUD_PROJECT, then gcloud's active project)
  --dry-run                 setup/deploy: print gcloud commands; rebuild: report without writing
  --deploy-function <name>  deploy: run \`firebase deploy --only functions:<name>\` first
  --fix                     verify: repair mismatches with conditional writes
  --rule <name>             rebuild/verify: limit to this rule (repeatable)
  --start-after <path>      rebuild/verify: resume after this target document path (use with --rule)
  --page-size <n>           rebuild/verify: documents per page (default 500)
  --url <url>               dev: handler URL, e.g. http://127.0.0.1:5001/<project>/<region>/docSync
  --emulator-host <h:p>     rebuild/verify/dev: Firestore emulator (default: $FIRESTORE_EMULATOR_HOST)
  -h, --help                Show this help
  -v, --version             Show the version

rebuild, verify and dev talk to Firestore directly: through the emulator when FIRESTORE_EMULATOR_HOST is set,
otherwise with Application Default Credentials (\`gcloud auth application-default login\`).
`

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      project: { type: 'string' },
      strict: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'deploy-function': { type: 'string' },
      fix: { type: 'boolean', default: false },
      rule: { type: 'string', multiple: true },
      'start-after': { type: 'string' },
      'page-size': { type: 'string' },
      url: { type: 'string' },
      'emulator-host': { type: 'string' },
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
  if (!['validate', 'setup', 'deploy', 'rebuild', 'verify', 'dev'].includes(command)) {
    console.error(`unknown command: ${command}\n`)
    log(HELP)
    return 1
  }

  const { path, config } = await loadConfig(values.config)
  // The flag must take effect for every command that talks to Firestore, or rebuild/verify would use ADC against a real project.
  if (values['emulator-host']) process.env.FIRESTORE_EMULATOR_HOST = values['emulator-host']
  const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)
  const project =
    command === 'validate' || ((command === 'rebuild' || command === 'verify' || command === 'dev') && emulator)
      ? (values.project ?? resolveProject(false) ?? 'demo-doc-sync')
      : resolveProject(true, values.project)
  const ctx: Context = {
    config,
    configPath: path,
    project: project ?? '<project>',
    runner: createRunner({ dryRun: values['dry-run'], log }),
    log,
  }

  switch (command) {
    case 'validate':
      validate(ctx, { strict: values.strict })
      break
    case 'setup':
      setup(ctx)
      break
    case 'deploy':
      deploy(ctx, { deployFunction: values['deploy-function'] })
      break
    case 'rebuild': {
      const pageSize = values['page-size'] === undefined ? undefined : Number(values['page-size'])
      if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1)) throw new Error('--page-size must be a positive integer')
      await rebuild(ctx, { rules: values.rule, dryRun: values['dry-run'], startAfter: values['start-after'], pageSize })
      break
    }
    case 'verify': {
      const pageSize = values['page-size'] === undefined ? undefined : Number(values['page-size'])
      if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1)) throw new Error('--page-size must be a positive integer')
      const ok = await verify(ctx, { rules: values.rule, fix: values.fix, startAfter: values['start-after'], pageSize })
      return ok ? 0 : 1
    }
    case 'dev':
      if (!values.url) throw new Error('dev requires --url <handler url>')
      await dev(ctx, { url: values.url, emulatorHost: values['emulator-host'] })
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
