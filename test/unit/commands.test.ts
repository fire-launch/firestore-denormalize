import { describe, expect, it } from 'vitest'
import { defineAggregate, defineConnection, defineView, validateConfig } from '../../src/config.js'
import { deploy, setup, validate, type Context } from '../../src/cli/commands.js'
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

function fakeRunner(reads: Record<string, string | Error>) {
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
      mutations.push(formatCommand(cmd, args))
    },
  }
  return { runner, mutations }
}

const ctx = (runner: Runner): Context => ({ config, configPath: '/x/doc-sync.config.ts', project: 'my-proj', runner, log: () => {} })
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
  it('does not treat auth/permission failures as "not found"', () => {
    const { runner, mutations } = fakeRunner({ 'gcloud iam service-accounts describe': authError })
    expect(() => setup(ctx(runner))).toThrow(/auth tokens/)
    expect(mutations.some((m) => m.includes('service-accounts create'))).toBe(false)
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

  it('creates missing, deletes stale, keeps existing, ignores foreign triggers', () => {
    const { runner, mutations } = fakeRunner({ 'gcloud eventarc triggers list': existing, 'gcloud scheduler jobs list': '[]' })
    deploy(ctx(runner), {})
    expect(mutations).toHaveLength(2)
    expect(mutations[0]).toMatch(/^gcloud eventarc triggers create doc-sync-category /)
    expect(mutations[1]).toBe('gcloud eventarc triggers delete doc-sync-legacy --project=my-proj --location=asia-northeast1 --quiet')
  })

  it('updates triggers whose settings drifted from the config', () => {
    const drifted = JSON.parse(existing) as { destination?: { cloudRun?: { service?: string } } }[]
    drifted[0]!.destination!.cloudRun!.service = 'old-service'
    const { runner, mutations } = fakeRunner({ 'gcloud eventarc triggers list': JSON.stringify(drifted), 'gcloud scheduler jobs list': '[]' })
    deploy(ctx(runner), {})
    const update = mutations.find((m) => m.includes('triggers update'))
    expect(update).toMatch(/^gcloud eventarc triggers update doc-sync-post .*--destination-run-service=docsync/)
    expect(update).not.toContain('--labels')
  })

  it('deploys the function first when asked', () => {
    const { runner, mutations } = fakeRunner({ 'gcloud eventarc triggers list': '[]', 'gcloud scheduler jobs list': '[]' })
    deploy(ctx(runner), { deployFunction: 'docSync' })
    expect(mutations[0]).toBe('firebase deploy --only functions:docSync --project=my-proj')
    expect(mutations.filter((m) => m.includes('triggers create'))).toHaveLength(2)
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
  const scheduled = validateConfig({
    name: 'doc-sync',
    region: 'asia-northeast1',
    service: 'docsync',
    serviceAccount: 'doc-sync-trigger',
    rules: [defineAggregate({ name: 'daily-likes', source: 'post/{postId}/like', target: 'post', idParam: 'postId', aggregate: 'count', targetField: 'likeCount', schedule: '0 3 * * *' })],
  })
  const sctx = (runner: Runner): Context => ({ ...ctx(runner), config: scheduled })

  it('creates the job once the service URL is known, and no trigger for a scheduled-only collection', () => {
    const { runner, mutations } = fakeRunner({
      'gcloud eventarc triggers list': '[]',
      'gcloud run services describe docsync': 'https://docsync-abc-an.a.run.app\n',
      'gcloud scheduler jobs list': '[]',
    })
    deploy(sctx(runner), {})
    expect(mutations.filter((m) => m.startsWith('gcloud eventarc'))).toEqual([])
    expect(mutations.filter((m) => m.startsWith('gcloud scheduler'))).toEqual([expect.stringMatching(/^gcloud scheduler jobs create http doc-sync-daily-likes .*--uri=https:\/\/docsync-abc-an\.a\.run\.app\/schedule\/daily-likes /)])
  })

  it('updates a job whose settings drifted from the config, even though the job already exists', () => {
    const existingJob = JSON.stringify([
      {
        name: 'projects/my-proj/locations/asia-northeast1/jobs/doc-sync-daily-likes',
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
    expect(scheduler[0]).toMatch(/^gcloud scheduler jobs update http doc-sync-daily-likes /)
  })

  it('skips job creation with a message when the service does not exist yet', () => {
    const lines: string[] = []
    const { runner, mutations } = fakeRunner({ 'gcloud eventarc triggers list': '[]', 'gcloud scheduler jobs list': '[]', 'gcloud run services describe docsync': notFound })
    deploy({ ...sctx(runner), log: (l = '') => lines.push(l) }, {})
    expect(mutations.filter((m) => m.startsWith('gcloud scheduler'))).toEqual([])
    expect(lines.join('\n')).toContain('does not exist yet')
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

  it('treats a disabled Cloud Scheduler API as no jobs and hints at `doc-sync setup`', () => {
    const lines: string[] = []
    const { runner, mutations } = fakeRunner({
      'gcloud eventarc triggers list': '[]',
      'gcloud scheduler jobs list': new CommandError('gcloud', 1, 'ERROR: (gcloud.scheduler.jobs.list) FAILED_PRECONDITION: Cloud Scheduler API has not been used in project my-proj before or it is disabled'),
    })
    deploy({ ...sctx(runner), log: (l = '') => lines.push(l) }, {})
    expect(mutations.filter((m) => m.startsWith('gcloud scheduler'))).toEqual([])
    expect(lines.join('\n')).toContain('run `doc-sync setup` first')
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
      'gcloud tasks queues describe doc-sync-schedule': 'doc-sync-schedule',
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
    expect(lines.join('\n')).toContain('--runtime-service-account ignored: no rule has a schedule.')
  })

  it('validate summary shows the continuation queue for scheduled rules', () => {
    const lines: string[] = []
    validate({ ...sctx(fakeRunner({}).runner), log: (l = '') => lines.push(l) })
    expect(lines.join('\n')).toContain('continuation queue: doc-sync-schedule (asia-northeast1)')
  })
})
