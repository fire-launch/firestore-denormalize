import { describe, expect, it } from 'vitest'
import { defineAggregate, defineConnection, defineView, jobName, triggerName, validateConfig } from '../../src/config.js'
import { deploy, printSummary, run, setup, validate, type Context } from '../../src/cli/commands.js'
import { CommandError, formatCommand, type Runner } from '../../src/cli/exec.js'

const config = validateConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'doc-sync-trigger',
  rules: [
    defineConnection({ name: 'a', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull' }),
  ],
})

function fakeRunner(reads: Record<string, string | Error>, mutateErrors: Record<string, Error> = {}) {
  const mutations: string[] = []
  const runner: Runner = {
    dryRun: false,
    read(cmd, args) {
      const key = formatCommand(cmd, args)
      const hit = Object.entries(reads).find(([k]) => key.startsWith(k))
      if (!hit) throw new Error(`unexpected read: ${key}`)
      if (hit[1] instanceof Error) throw hit[1]
      return hit[1]
    },
    mutate(cmd, args) {
      const key = formatCommand(cmd, args)
      const hit = Object.entries(mutateErrors).find(([k]) => key.startsWith(k))
      if (hit) throw hit[1]
      mutations.push(key)
    },
  }
  return { runner, mutations }
}

const ctx = (runner: Runner): Context => ({ config, configPath: '/x/doc-sync.config.ts', project: 'my-proj', projectSource: 'flag', runner, log: () => {} })
const notFound = new CommandError('gcloud', 1, 'ERROR: (gcloud.iam.service-accounts.describe) NOT_FOUND: Unknown service account')
const authError = new CommandError('gcloud', 1, 'ERROR: (gcloud.iam.service-accounts.describe) There was a problem refreshing your current auth tokens')

describe('setup', () => {
  it('creates the service account and grants roles when missing', () => {
    const { runner, mutations } = fakeRunner({
      'gcloud iam service-accounts describe': notFound,
      'gcloud run services describe': 'docsync',
    })
    setup(ctx(runner))
    expect(mutations).toEqual([
      'gcloud services enable eventarc.googleapis.com run.googleapis.com --project=my-proj',
      'gcloud beta services identity create --service=eventarc.googleapis.com --project=my-proj',
      "gcloud iam service-accounts create doc-sync-trigger '--display-name=Eventarc triggers for doc-sync' --project=my-proj",
      'gcloud projects add-iam-policy-binding my-proj --member=serviceAccount:doc-sync-trigger@my-proj.iam.gserviceaccount.com --role=roles/eventarc.eventReceiver --condition=None --format=none',
      'gcloud run services add-iam-policy-binding docsync --region=asia-northeast1 --project=my-proj --member=serviceAccount:doc-sync-trigger@my-proj.iam.gserviceaccount.com --role=roles/run.invoker --format=none',
    ])
  })

  it('skips SA creation and the invoker binding when the SA exists and the service does not', () => {
    const { runner, mutations } = fakeRunner({
      'gcloud iam service-accounts describe': 'email: x',
      'gcloud run services describe': notFound,
    })
    setup(ctx(runner))
    expect(mutations.some((m) => m.includes('service-accounts create'))).toBe(false)
    expect(mutations.some((m) => m.includes('run.invoker'))).toBe(false)
    expect(mutations.some((m) => m.includes('eventarc.eventReceiver'))).toBe(true)
  })
})

describe('setup errors', () => {
  it('does not create a missing service account that belongs to another project', () => {
    const foreign = { ...config, serviceAccount: 'sync@other-proj.iam.gserviceaccount.com' }
    const { runner, mutations } = fakeRunner({ 'gcloud iam service-accounts describe': notFound })
    expect(() => setup({ ...ctx(runner), config: foreign })).toThrow(
      'service account sync@other-proj.iam.gserviceaccount.com does not exist, and `setup` only creates accounts in project "my-proj". Create it in its own project first.',
    )
    expect(mutations.some((m) => m.includes('service-accounts create'))).toBe(false)
  })

  it('uses an existing service account of another project as is', () => {
    const foreign = { ...config, serviceAccount: 'sync@other-proj.iam.gserviceaccount.com' }
    const { runner, mutations } = fakeRunner({ 'gcloud iam service-accounts describe': 'email: x', 'gcloud run services describe': 'docsync' })
    setup({ ...ctx(runner), config: foreign })
    expect(mutations.some((m) => m.includes('service-accounts create'))).toBe(false)
    expect(mutations).toContain('gcloud projects add-iam-policy-binding my-proj --member=serviceAccount:sync@other-proj.iam.gserviceaccount.com --role=roles/eventarc.eventReceiver --condition=None --format=none')
  })

  it('does not treat auth/permission failures as "not found"', () => {
    const { runner, mutations } = fakeRunner({ 'gcloud iam service-accounts describe': authError })
    expect(() => setup(ctx(runner))).toThrow(/auth tokens/)
    expect(mutations.some((m) => m.includes('service-accounts create'))).toBe(false)
  })

  it('refuses to run against an implicit gcloud project', () => {
    const { runner, mutations } = fakeRunner({ 'gcloud iam service-accounts describe': notFound, 'gcloud run services describe': 'docsync' })
    expect(() => setup({ ...ctx(runner), projectSource: 'gcloud' })).toThrow(
      '`setup` changes project "my-proj", which only comes from gcloud\'s active config. Name it: --project my-proj, GOOGLE_CLOUD_PROJECT, or .firebaserc.',
    )
    expect(mutations).toEqual([])
  })
})

describe('setup with a cross-project runtime service account', () => {
  const scheduled = validateConfig({
    name: 'doc-sync',
    region: 'asia-northeast1',
    service: 'docsync',
    serviceAccount: 'doc-sync-trigger',
    rules: [defineAggregate({ name: 'daily-likes', source: 'post/{postId}/like', target: 'post', idParam: 'postId', aggregate: 'count', targetField: 'likeCount', schedule: '0 3 * * *' })],
  })

  it('logs a WARNING before the grants, and still applies them', () => {
    const lines: string[] = []
    const { runner, mutations } = fakeRunner({
      'gcloud iam service-accounts describe': '',
      'gcloud run services describe docsync': 'docsync',
      'gcloud tasks queues describe doc-sync-schedule': notFound,
    })
    setup({ ...ctx(runner), config: scheduled, log: (l = '') => lines.push(l) }, { runtimeServiceAccount: 'fn-runtime@other-proj.iam.gserviceaccount.com' })
    const warningIndex = lines.findIndex((l) => l.includes('WARNING'))
    expect(warningIndex).toBeGreaterThanOrEqual(0)
    expect(lines[warningIndex]).toBe(
      '  WARNING: fn-runtime@other-proj.iam.gserviceaccount.com belongs to project "other-proj", not "my-proj". The grants below are cross-project. Continue only if that is intended.',
    )
    const queueHeaderIndex = lines.findIndex((l) => l.startsWith('# 5/5'))
    expect(queueHeaderIndex).toBeLessThan(warningIndex)
    expect(mutations).toContain(
      'gcloud tasks queues add-iam-policy-binding doc-sync-schedule --location=asia-northeast1 --project=my-proj --member=serviceAccount:fn-runtime@other-proj.iam.gserviceaccount.com --role=roles/cloudtasks.enqueuer --format=none',
    )
    expect(mutations).toContain(
      'gcloud iam service-accounts add-iam-policy-binding doc-sync-trigger@my-proj.iam.gserviceaccount.com --project=my-proj --member=serviceAccount:fn-runtime@other-proj.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser --format=none',
    )
  })
})

describe('setup: Eventarc service agent', () => {
  it('records the identity create mutation and survives its failure', () => {
    const lines: string[] = []
    const { runner, mutations } = fakeRunner(
      { 'gcloud iam service-accounts describe': notFound, 'gcloud run services describe': 'docsync' },
      { 'gcloud beta services identity create': new Error('boom') },
    )
    setup({ ...ctx(runner), log: (l = '') => lines.push(l) })
    expect(mutations.some((m) => m.startsWith('gcloud beta services identity create'))).toBe(false)
    const text = lines.join('\n')
    expect(text).toContain('could not create the Eventarc service agent (run: gcloud beta services identity create --service=eventarc.googleapis.com --project=my-proj)')
    expect(text).toContain("Eventarc's service agent can take a few minutes to become usable on a new project; if deploy is refused, wait and rerun.")
    // setup continues past the failure
    expect(mutations.some((m) => m.includes('service-accounts create'))).toBe(true)
  })
})

describe('run', () => {
  const scheduled = validateConfig({
    name: 'doc-sync',
    region: 'asia-northeast1',
    service: 'docsync',
    serviceAccount: 'doc-sync-trigger',
    rules: [defineAggregate({ name: 'daily-likes', source: 'post/{postId}/like', target: 'post', idParam: 'postId', aggregate: 'count', targetField: 'likeCount', schedule: '0 3 * * *' })],
  })
  const rctx = (runner: Runner): Context => ({ ...ctx(runner), config: scheduled })

  it('posts to /schedule/<rule> with an impersonated ID token', async () => {
    const { runner } = fakeRunner({
      'gcloud run services describe': 'https://docsync-abc-an.a.run.app\n',
      'gcloud auth print-identity-token': 'fake-token\n',
    })
    const lines: string[] = []
    const calls: { url: string; init: unknown }[] = []
    const fetchImpl = async (url: string, init: unknown) => {
      calls.push({ url, init })
      return { ok: true, status: 200, text: async () => JSON.stringify({ rule: 'daily-likes', written: 1 }) }
    }
    await run({ ...rctx(runner), log: (l = '') => lines.push(l) }, { rule: 'daily-likes', fetchImpl })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://docsync-abc-an.a.run.app/schedule/daily-likes')
    expect(calls[0]!.init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer fake-token', 'Content-Type': 'application/json' }, body: '{}' })
    expect(lines.join('\n')).toContain('POST https://docsync-abc-an.a.run.app/schedule/daily-likes → 200')
  })

  it('refuses a rule that is not scheduled', async () => {
    const { runner } = fakeRunner({})
    await expect(run(rctx(runner), { rule: 'not-a-rule' })).rejects.toThrow('rule "not-a-rule" is not scheduled; deferred rules are flushed by their tasks')
  })

  it('requires an explicit project', async () => {
    const { runner } = fakeRunner({})
    await expect(run({ ...rctx(runner), projectSource: 'gcloud' }, { rule: 'daily-likes' })).rejects.toThrow(/`run` changes project/)
  })

  it('reports the service as missing when the URL is empty', async () => {
    const { runner } = fakeRunner({ 'gcloud run services describe': '' })
    await expect(run(rctx(runner), { rule: 'daily-likes' })).rejects.toThrow('service docsync not found in asia-northeast1; deploy the function first')
  })

  it('mentions the impersonation role on a token error', async () => {
    const tokenError = new CommandError('gcloud', 1, 'ERROR: (gcloud.auth.print-identity-token) PERMISSION_DENIED')
    const { runner } = fakeRunner({
      'gcloud run services describe': 'https://docsync-abc-an.a.run.app\n',
      'gcloud auth print-identity-token': tokenError,
    })
    await expect(run(rctx(runner), { rule: 'daily-likes' })).rejects.toThrow(/roles\/iam\.serviceAccountTokenCreator on doc-sync-trigger@my-proj\.iam\.gserviceaccount\.com/)
  })

  it('throws on a non-2xx response', async () => {
    const { runner } = fakeRunner({
      'gcloud run services describe': 'https://docsync-abc-an.a.run.app\n',
      'gcloud auth print-identity-token': 'fake-token',
    })
    const fetchImpl = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: 'nope' }) })
    await expect(run(rctx(runner), { rule: 'daily-likes', fetchImpl })).rejects.toThrow(/403/)
  })

  it('does not support --dry-run', async () => {
    const { runner } = fakeRunner({})
    await expect(run({ ...rctx(runner), runner: { ...runner, dryRun: true } }, { rule: 'daily-likes' })).rejects.toThrow('run does not support --dry-run')
  })

  it('reports the service as missing when gcloud answers NOT_FOUND', async () => {
    const notFoundService = new CommandError('gcloud', 1, 'ERROR: (gcloud.run.services.describe) NOT_FOUND: Service not found')
    const { runner } = fakeRunner({ 'gcloud run services describe': notFoundService })
    await expect(run(rctx(runner), { rule: 'daily-likes' })).rejects.toThrow('service docsync not found in asia-northeast1; deploy the function first')
  })

  it('reports a fetch failure as continuing on the server', async () => {
    const { runner } = fakeRunner({
      'gcloud run services describe': 'https://docsync-abc-an.a.run.app\n',
      'gcloud auth print-identity-token': 'fake-token',
    })
    const fetchImpl = async () => {
      throw new Error('socket hang up')
    }
    await expect(run(rctx(runner), { rule: 'daily-likes', fetchImpl })).rejects.toThrow(
      'request ended before the run finished (socket hang up); the run continues on the server, see its logs',
    )
  })
})

describe('deploy', () => {
  const existing = JSON.stringify([
    {
      name: 'projects/my-proj/locations/asia-northeast1/triggers/doc-sync-post',
      labels: { 'doc-sync-instance': 'doc-sync' },
      destination: { cloudRun: { service: 'docsync', region: 'asia-northeast1' } },
      serviceAccount: 'doc-sync-trigger@my-proj.iam.gserviceaccount.com',
      eventFilters: [
        { attribute: 'type', value: 'google.cloud.firestore.document.v1.written' },
        { attribute: 'database', value: '(default)' },
        { attribute: 'document', value: 'post/{docId}', operator: 'match-path-pattern' },
      ],
    },
    { name: 'projects/my-proj/locations/asia-northeast1/triggers/doc-sync-legacy', labels: { 'doc-sync-instance': 'doc-sync' } },
    { name: 'projects/my-proj/locations/asia-northeast1/triggers/someone-elses', labels: { 'doc-sync-instance': 'other' } },
  ])

  it('creates missing, deletes stale, ignores foreign triggers', () => {
    const { runner, mutations } = fakeRunner({ 'gcloud eventarc triggers list': existing, 'gcloud scheduler jobs list': '[]' })
    deploy(ctx(runner), {})
    expect(mutations).toHaveLength(4)
    expect(mutations[0]).toMatch(new RegExp(`^gcloud eventarc triggers create ${triggerName('doc-sync', 'category')} `))
    expect(mutations[1]).toMatch(new RegExp(`^gcloud eventarc triggers create ${triggerName('doc-sync', 'post')} `))
    expect(mutations[2]).toBe('gcloud eventarc triggers delete doc-sync-legacy --project=my-proj --location=asia-northeast1 --quiet')
    expect(mutations[3]).toBe('gcloud eventarc triggers delete doc-sync-post --project=my-proj --location=asia-northeast1 --quiet')
  })

  it('updates triggers whose settings drifted from the config', () => {
    const drifted = JSON.parse(existing) as { name: string; destination?: { cloudRun?: { service?: string } } }[]
    drifted[0]!.name = `projects/my-proj/locations/asia-northeast1/triggers/${triggerName('doc-sync', 'post')}`
    drifted[0]!.destination!.cloudRun!.service = 'old-service'
    const { runner, mutations } = fakeRunner({ 'gcloud eventarc triggers list': JSON.stringify(drifted), 'gcloud scheduler jobs list': '[]' })
    deploy(ctx(runner), {})
    const update = mutations.find((m) => m.includes('triggers update'))
    expect(update).toMatch(new RegExp(`^gcloud eventarc triggers update ${triggerName('doc-sync', 'post')} .*--destination-run-service=docsync`))
    expect(update).not.toContain('--labels')
  })

  it('deploys the function first when asked', () => {
    const { runner, mutations } = fakeRunner({ 'gcloud eventarc triggers list': '[]', 'gcloud scheduler jobs list': '[]' })
    deploy(ctx(runner), { deployFunction: 'docSync' })
    expect(mutations[0]).toBe('firebase deploy --only functions:docSync --project=my-proj')
    expect(mutations.filter((m) => m.includes('triggers create'))).toHaveLength(2)
  })
})

describe('printSummary', () => {
  it('shows the project source', () => {
    const lines: string[] = []
    printSummary({ ...ctx(fakeRunner({}).runner), projectSource: 'firebaserc', log: (l = '') => lines.push(l) })
    expect(lines.join('\n')).toContain('Project:         my-proj (from .firebaserc)')
  })
})

describe('validate', () => {
  const costConfig = validateConfig({
    name: 'doc-sync',
    region: 'asia-northeast1',
    service: 'docsync',
    serviceAccount: 'doc-sync-trigger',
    rules: [
      defineConnection({ name: 'area-category', source: 'area', target: 'category', idField: 'areaId', fields: ['name'], targetField: 'parent', onSourceDelete: 'setNull' }),
      defineConnection({ name: 'post-category', source: 'category', target: 'post', idField: 'categoryId', fields: ['name', 'parent'], targetField: 'category', onSourceDelete: 'setNull' }),
      defineView({
        name: 'post-summary',
        target: 'post',
        targetFields: ['summary'],
        sources: { author: { collection: 'user', refField: 'authorId' } },
        build: () => ({ summary: 'x' }),
      }),
    ],
  })
  const costCtx = (log: (line?: string) => void): Context => ({
    config: costConfig,
    configPath: '/x/doc-sync.config.ts',
    project: 'my-proj',
    projectSource: 'flag',
    runner: fakeRunner({}).runner,
    log,
  })

  it('prints a cost section, a write chain and a warning', () => {
    const lines: string[] = []
    validate(costCtx((l = '') => lines.push(l)))
    const output = lines.join('\n')
    expect(output).toContain('Cost per event (N = targets matching the changed source, M = source documents of one target, T = targets of a scheduled rule (one run)):')
    expect(output).toContain('Write chains')
    expect(output).toContain('area-category -> post-category')
    expect(output).toContain('source "author" (refField) fans out')
  })

  it('throws with --strict when there is a warning', () => {
    expect(() => validate(costCtx(() => {}), { strict: true })).toThrow(/1 warning\(s\); failing because of --strict/)
  })
})

describe('deploy with scheduled rules', () => {
  const dailyLikes = defineAggregate({ name: 'daily-likes', source: 'post/{postId}/like', target: 'post', idParam: 'postId', aggregate: 'count', targetField: 'likeCount', schedule: '0 3 * * *' })
  const scheduled = validateConfig({
    name: 'doc-sync',
    region: 'asia-northeast1',
    service: 'docsync',
    serviceAccount: 'doc-sync-trigger',
    rules: [dailyLikes],
  })
  const sctx = (runner: Runner): Context => ({ ...ctx(runner), config: scheduled })
  // an event-driven rule next to the scheduled one, so a deploy would also create a trigger
  const mixed = validateConfig({
    name: 'doc-sync',
    region: 'asia-northeast1',
    service: 'docsync',
    serviceAccount: 'doc-sync-trigger',
    rules: [
      defineConnection({ name: 'a', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull' }),
      dailyLikes,
    ],
  })
  const mctx = (runner: Runner): Context => ({ ...ctx(runner), config: mixed })

  it('creates the job once the service URL is known, and no trigger for a scheduled-only collection', () => {
    const { runner, mutations } = fakeRunner({
      'gcloud eventarc triggers list': '[]',
      'gcloud run services describe docsync': 'https://docsync-abc-an.a.run.app\n',
      'gcloud scheduler jobs list': '[]',
    })
    deploy(sctx(runner), {})
    expect(mutations.filter((m) => m.startsWith('gcloud eventarc'))).toEqual([])
    expect(mutations.filter((m) => m.startsWith('gcloud scheduler'))).toEqual([
      expect.stringMatching(new RegExp(`^gcloud scheduler jobs create http ${jobName('doc-sync', 'daily-likes')} .*--uri=https://docsync-abc-an\\.a\\.run\\.app/schedule/daily-likes `)),
    ])
  })

  it('updates a job whose settings drifted from the config, even though the job already exists', () => {
    const existingJob = JSON.stringify([
      {
        name: `projects/my-proj/locations/asia-northeast1/jobs/${jobName('doc-sync', 'daily-likes')}`,
        description: 'doc-sync-instance=doc-sync',
        schedule: '0 4 * * *',
        timeZone: 'Etc/UTC',
        httpTarget: {
          uri: 'https://docsync-abc-an.a.run.app/schedule/daily-likes',
          httpMethod: 'POST',
          oidcToken: { serviceAccountEmail: 'doc-sync-trigger@my-proj.iam.gserviceaccount.com', audience: 'https://docsync-abc-an.a.run.app' },
        },
        retryConfig: { retryCount: 3, minBackoffDuration: '60s' },
      },
    ])
    const { runner, mutations } = fakeRunner({
      'gcloud eventarc triggers list': '[]',
      'gcloud scheduler jobs list': existingJob,
      'gcloud run services describe docsync': 'https://docsync-abc-an.a.run.app\n',
    })
    deploy(sctx(runner), {})
    const scheduler = mutations.filter((m) => m.startsWith('gcloud scheduler'))
    expect(scheduler).toHaveLength(1)
    expect(scheduler[0]).toMatch(new RegExp(`^gcloud scheduler jobs update http ${jobName('doc-sync', 'daily-likes')} `))
  })

  it('skips job creation with a message when the service does not exist yet', () => {
    const lines: string[] = []
    const { runner, mutations } = fakeRunner({ 'gcloud eventarc triggers list': '[]', 'gcloud scheduler jobs list': '[]', 'gcloud run services describe docsync': notFound })
    deploy({ ...sctx(runner), log: (l = '') => lines.push(l) }, {})
    expect(mutations.filter((m) => m.startsWith('gcloud scheduler'))).toEqual([])
    expect(lines.join('\n')).toContain('does not exist yet')
  })

  it('does not delete existing jobs when the service does not exist yet', () => {
    const lines: string[] = []
    const existingJob = JSON.stringify([
      { name: 'projects/my-proj/locations/asia-northeast1/jobs/doc-sync-daily-likes', description: 'doc-sync-instance=doc-sync' },
    ])
    const { runner, mutations } = fakeRunner({
      'gcloud eventarc triggers list': '[]',
      'gcloud scheduler jobs list': existingJob,
      'gcloud run services describe docsync': notFound,
    })
    deploy({ ...sctx(runner), log: (l = '') => lines.push(l) }, {})
    expect(mutations.filter((m) => m.startsWith('gcloud scheduler'))).toEqual([])
    expect(lines.join('\n')).toContain('does not exist yet')
  })

  it('migrates an old-style job: creates the hashed name before deleting the old one', () => {
    const existingJob = JSON.stringify([
      { name: 'projects/my-proj/locations/asia-northeast1/jobs/doc-sync-daily-likes', description: 'doc-sync-instance=doc-sync' },
    ])
    const { runner, mutations } = fakeRunner({
      'gcloud eventarc triggers list': '[]',
      'gcloud scheduler jobs list': existingJob,
      'gcloud run services describe docsync': 'https://docsync-abc-an.a.run.app\n',
    })
    deploy(sctx(runner), {})
    const scheduler = mutations.filter((m) => m.startsWith('gcloud scheduler'))
    expect(scheduler).toHaveLength(2)
    expect(scheduler[0]).toMatch(new RegExp(`^gcloud scheduler jobs create http ${jobName('doc-sync', 'daily-likes')} `))
    expect(scheduler[1]).toBe('gcloud scheduler jobs delete doc-sync-daily-likes --project=my-proj --location=asia-northeast1 --quiet')
  })

  it('deletes a stale job even when no rule is scheduled any more, without reading the service URL', () => {
    const { runner, mutations } = fakeRunner({
      'gcloud eventarc triggers list': '[]',
      'gcloud scheduler jobs list': JSON.stringify([{ name: 'projects/my-proj/locations/asia-northeast1/jobs/doc-sync-old', description: 'doc-sync-instance=doc-sync' }]),
    })
    deploy(ctx(runner), {})
    expect(mutations.filter((m) => m.startsWith('gcloud scheduler'))).toEqual([
      'gcloud scheduler jobs delete doc-sync-old --project=my-proj --location=asia-northeast1 --quiet',
    ])
  })

  it('fails when a rule is scheduled and the Cloud Scheduler API is disabled', () => {
    const disabled = new CommandError('gcloud', 1, 'ERROR: (gcloud.scheduler.jobs.list) FAILED_PRECONDITION: Cloud Scheduler API has not been used in project my-proj before or it is disabled')
    const { runner, mutations } = fakeRunner({ 'gcloud eventarc triggers list': '[]', 'gcloud scheduler jobs list': disabled })
    expect(() => deploy(mctx(runner), {})).toThrow('Cloud Scheduler API is not enabled; run `doc-sync setup` first')
    expect(mutations).toEqual([]) // fails before any trigger is changed
    // without scheduled rules there are no jobs to keep, so a disabled API is fine
    const plain = fakeRunner({ 'gcloud eventarc triggers list': '[]', 'gcloud scheduler jobs list': disabled })
    expect(() => deploy(ctx(plain.runner), {})).not.toThrow()
  })

  it('does not mistake a permission error naming the Cloud Scheduler API for a disabled API', () => {
    const denied = new CommandError(
      'gcloud',
      1,
      "ERROR: (gcloud.scheduler.jobs.list) PERMISSION_DENIED: The caller does not have permission. This command is authenticated as me@example.com\n- '@type': type.googleapis.com/google.rpc.ErrorInfo\n  domain: cloudscheduler.googleapis.com\n  reason: IAM_PERMISSION_DENIED",
    )
    const { runner, mutations } = fakeRunner({ 'gcloud eventarc triggers list': '[]', 'gcloud scheduler jobs list': denied })
    expect(() => deploy(mctx(runner), {})).toThrow(/PERMISSION_DENIED/)
    expect(mutations).toEqual([])
    // without scheduled rules the list only serves cleanup, so the deploy goes on and says what it skipped
    const lines: string[] = []
    const plain = fakeRunner({ 'gcloud eventarc triggers list': '[]', 'gcloud scheduler jobs list': denied })
    deploy({ ...ctx(plain.runner), log: (l = '') => lines.push(l) }, {})
    expect(plain.mutations.some((m) => m.startsWith('gcloud eventarc triggers create'))).toBe(true)
    expect(lines.join('\n')).toContain('Could not list Cloud Scheduler jobs, so jobs of removed scheduled rules were not checked: ERROR: (gcloud.scheduler.jobs.list) PERMISSION_DENIED')
  })

  it('enables the Cloud Scheduler API in setup only when a rule is scheduled', () => {
    const plain = fakeRunner({ 'gcloud iam service-accounts describe': '', 'gcloud run services describe docsync': 'docsync' })
    setup(ctx(plain.runner))
    expect(plain.mutations[0]).toBe('gcloud services enable eventarc.googleapis.com run.googleapis.com --project=my-proj')
    const withJobs = fakeRunner({
      'gcloud iam service-accounts describe': '',
      'gcloud run services describe docsync': 'docsync',
      'gcloud tasks queues describe doc-sync-schedule': notFound,
    })
    setup(sctx(withJobs.runner))
    expect(withJobs.mutations[0]).toBe('gcloud services enable eventarc.googleapis.com run.googleapis.com cloudscheduler.googleapis.com cloudtasks.googleapis.com --project=my-proj')
  })

  it('setup enables the Tasks API, creates the continuation queue when missing, and prints the runtime grants as hints', () => {
    const lines: string[] = []
    const { runner, mutations } = fakeRunner({
      'gcloud iam service-accounts describe': '',
      'gcloud run services describe docsync': 'docsync',
      'gcloud tasks queues describe doc-sync-schedule': notFound,
    })
    setup({ ...sctx(runner), log: (l = '') => lines.push(l) })
    expect(mutations[0]).toBe('gcloud services enable eventarc.googleapis.com run.googleapis.com cloudscheduler.googleapis.com cloudtasks.googleapis.com --project=my-proj')
    expect(mutations).toContain('gcloud tasks queues create doc-sync-schedule --location=asia-northeast1 --project=my-proj --max-attempts=5 --min-backoff=60s')
    expect(mutations.some((m) => m.includes('roles/cloudtasks.enqueuer'))).toBe(false)
    const text = lines.join('\n')
    expect(text).toContain('--runtime-service-account')
    expect(text).toContain('roles/cloudtasks.enqueuer')
    expect(text).toContain('roles/iam.serviceAccountUser')
  })

  it('setup grants the runtime service account when given, and skips an existing queue', () => {
    const { runner, mutations } = fakeRunner({
      'gcloud iam service-accounts describe': '',
      'gcloud run services describe docsync': 'docsync',
      'gcloud tasks queues describe doc-sync-schedule': JSON.stringify({ name: 'projects/my-proj/locations/asia-northeast1/queues/doc-sync-schedule' }),
    })
    setup(sctx(runner), { runtimeServiceAccount: 'fn-runtime@my-proj.iam.gserviceaccount.com' })
    expect(mutations.some((m) => m.startsWith('gcloud tasks queues create'))).toBe(false)
    expect(mutations).toContain(
      'gcloud tasks queues add-iam-policy-binding doc-sync-schedule --location=asia-northeast1 --project=my-proj --member=serviceAccount:fn-runtime@my-proj.iam.gserviceaccount.com --role=roles/cloudtasks.enqueuer --format=none',
    )
    expect(mutations).toContain(
      'gcloud iam service-accounts add-iam-policy-binding doc-sync-trigger@my-proj.iam.gserviceaccount.com --project=my-proj --member=serviceAccount:fn-runtime@my-proj.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser --format=none',
    )
  })

  it('setup updates an existing queue whose retry policy drifted, and leaves a matching one alone', () => {
    const drifted = fakeRunner({
      'gcloud iam service-accounts describe': '',
      'gcloud run services describe docsync': 'docsync',
      'gcloud tasks queues describe doc-sync-schedule': JSON.stringify({ name: 'projects/my-proj/locations/asia-northeast1/queues/doc-sync-schedule', retryConfig: { maxAttempts: 100, minBackoff: '0.100s' } }),
    })
    setup(sctx(drifted.runner))
    expect(drifted.mutations.filter((m) => m.startsWith('gcloud tasks queues'))).toEqual(['gcloud tasks queues update doc-sync-schedule --location=asia-northeast1 --project=my-proj --max-attempts=5 --min-backoff=60s'])

    const matching = fakeRunner({
      'gcloud iam service-accounts describe': '',
      'gcloud run services describe docsync': 'docsync',
      'gcloud tasks queues describe doc-sync-schedule': JSON.stringify({ name: 'projects/my-proj/locations/asia-northeast1/queues/doc-sync-schedule', retryConfig: { maxAttempts: 5, minBackoff: '60s' } }),
    })
    setup(sctx(matching.runner))
    expect(matching.mutations.some((m) => m.startsWith('gcloud tasks queues'))).toBe(false)
  })

  it('setup without scheduled rules touches neither the Tasks API nor a queue', () => {
    const { runner, mutations } = fakeRunner({ 'gcloud iam service-accounts describe': '', 'gcloud run services describe docsync': 'docsync' })
    setup(ctx(runner))
    expect(mutations[0]).toBe('gcloud services enable eventarc.googleapis.com run.googleapis.com --project=my-proj')
    expect(mutations.some((m) => m.includes('tasks'))).toBe(false)
  })

  it('notes that --runtime-service-account is ignored when no rule has a schedule', () => {
    const lines: string[] = []
    const { runner } = fakeRunner({ 'gcloud iam service-accounts describe': '', 'gcloud run services describe docsync': 'docsync' })
    setup({ ...ctx(runner), log: (l = '') => lines.push(l) }, { runtimeServiceAccount: 'fn-runtime@my-proj.iam.gserviceaccount.com' })
    expect(lines.join('\n')).toContain('--runtime-service-account ignored: no rule has a schedule or defer.')
  })

  it('validate summary shows the continuation queue for scheduled rules', () => {
    const lines: string[] = []
    validate({ ...sctx(fakeRunner({}).runner), log: (l = '') => lines.push(l) })
    expect(lines.join('\n')).toContain('continuation queue: doc-sync-schedule (asia-northeast1)')
  })
})

describe('deferred rules', () => {
  const deferred = validateConfig({
    name: 'doc-sync',
    region: 'asia-northeast1',
    service: 'docsync',
    serviceAccount: 'doc-sync-trigger',
    rules: [
      defineConnection({ name: 'post-category', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull', defer: '10m' }),
    ],
  })
  const dctx = (runner: Runner): Context => ({ ...ctx(runner), config: deferred })

  it('setup enables the Tasks API (not Scheduler) and creates the queue for a deferred rule', () => {
    const { runner, mutations } = fakeRunner({
      'gcloud iam service-accounts describe': '',
      'gcloud run services describe docsync': 'docsync',
      'gcloud tasks queues describe doc-sync-schedule': notFound,
    })
    setup(dctx(runner))
    expect(mutations[0]).toBe('gcloud services enable eventarc.googleapis.com run.googleapis.com cloudtasks.googleapis.com --project=my-proj')
    expect(mutations).toContain('gcloud tasks queues create doc-sync-schedule --location=asia-northeast1 --project=my-proj --max-attempts=5 --min-backoff=60s')
  })

  it('validate summary lists deferred rules with their interval', () => {
    const lines: string[] = []
    validate({ ...dctx(fakeRunner({}).runner), log: (l = '') => lines.push(l) })
    const output = lines.join('\n')
    expect(output).toContain('Deferred rules (1) — events mark, a task recomputes once per interval:')
    expect(output).toContain('post-category: every 10m')
  })
})
