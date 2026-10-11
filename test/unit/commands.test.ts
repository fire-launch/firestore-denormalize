import { describe, expect, it } from 'vitest'
import { defineConnection, defineView, validateConfig } from '../../src/config.js'
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
    const { runner, mutations } = fakeRunner({ 'gcloud eventarc triggers list': existing })
    deploy(ctx(runner), {})
    expect(mutations).toHaveLength(2)
    expect(mutations[0]).toMatch(/^gcloud eventarc triggers create doc-sync-category /)
    expect(mutations[1]).toBe('gcloud eventarc triggers delete doc-sync-legacy --project=my-proj --location=asia-northeast1 --quiet')
  })

  it('updates triggers whose settings drifted from the config', () => {
    const drifted = JSON.parse(existing) as { destination?: { cloudRun?: { service?: string } } }[]
    drifted[0]!.destination!.cloudRun!.service = 'old-service'
    const { runner, mutations } = fakeRunner({ 'gcloud eventarc triggers list': JSON.stringify(drifted) })
    deploy(ctx(runner), {})
    const update = mutations.find((m) => m.includes('triggers update'))
    expect(update).toMatch(/^gcloud eventarc triggers update doc-sync-post .*--destination-run-service=docsync/)
    expect(update).not.toContain('--labels')
  })

  it('deploys the function first when asked', () => {
    const { runner, mutations } = fakeRunner({ 'gcloud eventarc triggers list': '[]' })
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
        targetField: 'summary',
        sources: { author: { collection: 'user', refField: 'authorId' } },
        build: () => 'x',
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
    expect(output).toContain('Cost per event (N = targets matching the changed source, M = source documents of one target):')
    expect(output).toContain('Write chains')
    expect(output).toContain('area-category -> post-category')
    expect(output).toContain('source "author" (refField) fans out')
  })

  it('throws with --strict when there is a warning', () => {
    expect(() => validate(costCtx(() => {}), { strict: true })).toThrow(/1 warning\(s\); failing because of --strict/)
  })
})
