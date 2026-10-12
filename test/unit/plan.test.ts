import { describe, expect, it } from 'vitest'
import { defineAggregate, defineConnection, triggerName, validateConfig } from '../../src/config.js'
import {
  desiredJobs,
  desiredTriggers,
  jobCreateArgs,
  jobDifferences,
  jobName,
  ownedJobs,
  ownedTriggers,
  planJobs,
  planTriggers,
  queueDifferences,
  queueUpdateArgs,
  serviceAccountEmail,
  triggerCreateArgs,
  triggerDifferences,
} from '../../src/cli/plan.js'
import { formatCommand } from '../../src/cli/exec.js'
import { parseCollectionPattern } from '../../src/paths.js'

const spec = (raw: string, name: string) => ({ name, collection: parseCollectionPattern(raw) })

const config = validateConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'doc-sync-trigger',
  rules: [
    defineConnection({ name: 'a', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull' }),
    defineConnection({ name: 'b', source: 'post', target: 'user_room', idField: 'postId', fields: ['title'], targetField: 'post', onSourceDelete: 'nothing' }),
  ],
})

const scheduledConfig = validateConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'doc-sync-trigger',
  rules: [
    defineConnection({ name: 'a', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull' }),
    defineAggregate({ name: 'daily-likes', source: 'post/{postId}/like', target: 'post', idParam: 'postId', aggregate: 'count', targetField: 'likeCount', schedule: '0 3 * * *', timeZone: 'Asia/Tokyo' }),
  ],
})

describe('plan', () => {
  it('derives triggers from event-driven rules only and one job per scheduled rule', () => {
    expect(desiredTriggers(scheduledConfig).map((t) => t.name).sort()).toEqual([triggerName('doc-sync', 'category'), triggerName('doc-sync', 'post')])
    expect(desiredJobs(scheduledConfig)).toEqual([{ name: jobName('doc-sync', 'daily-likes'), rule: 'daily-likes', cron: '0 3 * * *', timeZone: 'Asia/Tokyo' }])
  })

  it('builds the scheduler job command and diffs existing jobs', () => {
    const [job] = desiredJobs(scheduledConfig)
    const url = 'https://docsync-abc-an.a.run.app'
    expect(formatCommand('gcloud', jobCreateArgs(scheduledConfig, 'my-proj', job!, url))).toBe(
      `gcloud scheduler jobs create http ${jobName('doc-sync', 'daily-likes')} --project=my-proj --location=asia-northeast1 '--schedule=0 3 * * *' --time-zone=Asia/Tokyo --uri=https://docsync-abc-an.a.run.app/schedule/daily-likes --http-method=POST --oidc-service-account-email=doc-sync-trigger@my-proj.iam.gserviceaccount.com --oidc-token-audience=https://docsync-abc-an.a.run.app --attempt-deadline=1800s --max-retry-attempts=3 --min-backoff=60s --description=doc-sync-instance=doc-sync`,
    )
    const current = { name: `projects/my-proj/locations/asia-northeast1/jobs/${jobName('doc-sync', 'daily-likes')}`, description: 'doc-sync-instance=doc-sync', schedule: '0 4 * * *', timeZone: 'Etc/UTC', httpTarget: { uri: `${url}/schedule/daily-likes`, httpMethod: 'POST', oidcToken: { serviceAccountEmail: 'doc-sync-trigger@my-proj.iam.gserviceaccount.com', audience: url } } }
    expect(jobDifferences(scheduledConfig, 'my-proj', job!, current, url)).toEqual(['schedule: 0 4 * * * -> 0 3 * * *', 'time zone: Etc/UTC -> Asia/Tokyo'])
    const plan = planJobs(desiredJobs(scheduledConfig), ownedJobs([current, { name: 'projects/my-proj/locations/asia-northeast1/jobs/doc-sync-old', description: 'doc-sync-instance=doc-sync' }, { name: 'projects/my-proj/locations/asia-northeast1/jobs/other', description: 'something else' }], 'doc-sync'), { config: scheduledConfig, project: 'my-proj', serviceUrl: url })
    expect(plan.update.map((u) => u.job.name)).toEqual([jobName('doc-sync', 'daily-likes')])
    expect(plan.remove).toEqual(['doc-sync-old'])
    expect(plan.create).toEqual([])
  })

  it('reports a queue whose retry policy drifted and accepts matching or missing fields', () => {
    expect(queueDifferences({ name: 'q', retryConfig: { maxAttempts: 100, minBackoff: '0.100s' } })).toEqual(['max attempts: 100 -> 5', 'min backoff: 0.100s -> 60s'])
    expect(queueDifferences({ name: 'q', retryConfig: { maxAttempts: 5, minBackoff: '60s' } })).toEqual([])
    expect(queueDifferences({ name: 'q', retryConfig: { maxAttempts: 5, minBackoff: '60.000s' } })).toEqual([])
    expect(queueDifferences({ name: 'q' })).toEqual([])
    expect(formatCommand('gcloud', queueUpdateArgs(scheduledConfig, 'my-proj', 'doc-sync-schedule'))).toBe('gcloud tasks queues update doc-sync-schedule --location=asia-northeast1 --project=my-proj --max-attempts=5 --min-backoff=60s')
  })

  it('expands a bare service account id', () => {
    expect(serviceAccountEmail(config, 'my-proj')).toBe('doc-sync-trigger@my-proj.iam.gserviceaccount.com')
    expect(serviceAccountEmail({ serviceAccount: 'x@y.iam.gserviceaccount.com' }, 'p')).toBe('x@y.iam.gserviceaccount.com')
  })

  it('derives one trigger per collection', () => {
    expect(desiredTriggers(config).map((t) => t.name)).toEqual([triggerName('doc-sync', 'category'), triggerName('doc-sync', 'post'), triggerName('doc-sync', 'user_room')])
  })

  it('only touches triggers labelled with the instance', () => {
    const owned = ownedTriggers(
      [
        { name: 'projects/p/locations/l/triggers/doc-sync-post', labels: { 'doc-sync-instance': 'doc-sync' } },
        { name: 'projects/p/locations/l/triggers/other-post', labels: { 'doc-sync-instance': 'other' } },
        { name: 'projects/p/locations/l/triggers/manual' },
      ],
      'doc-sync',
    )
    expect(owned.map((t) => t.name)).toEqual(['doc-sync-post'])
  })

  it('diffs desired against existing', () => {
    const plan = planTriggers(desiredTriggers(config), [{ name: triggerName('doc-sync', 'post') }, { name: 'doc-sync-old' }])
    expect(plan.create.map((t) => t.name)).toEqual([triggerName('doc-sync', 'category'), triggerName('doc-sync', 'user_room')])
    expect(plan.keep.map((t) => t.name)).toEqual([triggerName('doc-sync', 'post')])
    expect(plan.remove).toEqual(['doc-sync-old'])
  })

  it('lists every drifted setting and ignores fields gcloud did not return', () => {
    const t = spec('post', 'doc-sync-post')
    expect(triggerDifferences(config, 'my-proj', t, { name: t.name })).toEqual([])
    expect(
      triggerDifferences(config, 'my-proj', t, {
        name: t.name,
        destination: { cloudRun: { service: 'docsync', region: 'us-central1' } },
        serviceAccount: 'other@my-proj.iam.gserviceaccount.com',
        eventFilters: [{ attribute: 'database', value: 'other-db' }],
      }),
    ).toEqual([
      'service region: us-central1 -> asia-northeast1',
      'database: other-db -> (default)',
      'service account: other@my-proj.iam.gserviceaccount.com -> doc-sync-trigger@my-proj.iam.gserviceaccount.com',
    ])
  })

  it('uses the subcollection path pattern and treats placeholder renames as unchanged', () => {
    const t = spec('users/{uid}/payments', 'doc-sync-users-payments')
    expect(triggerCreateArgs(config, 'p', t)).toContain('--event-filters-path-pattern=document=users/{uid}/payments/{docId}')
    expect(
      triggerDifferences(config, 'p', t, { name: t.name, eventFilters: [{ attribute: 'document', value: 'users/{userId}/payments/{id}' }] }),
    ).toEqual([])
  })

  it('builds the create command from the spec', () => {
    const args = triggerCreateArgs(config, 'my-proj', spec('post', 'doc-sync-post'))
    expect(formatCommand('gcloud', args)).toBe(
      [
        'gcloud eventarc triggers create doc-sync-post',
        '--project=my-proj',
        '--location=asia-northeast1',
        '--destination-run-service=docsync',
        '--destination-run-region=asia-northeast1',
        '--event-filters=type=google.cloud.firestore.document.v1.written',
        "'--event-filters=database=(default)'",
        "'--event-filters-path-pattern=document=post/{docId}'",
        '--event-data-content-type=application/protobuf',
        '--service-account=doc-sync-trigger@my-proj.iam.gserviceaccount.com',
        '--labels=doc-sync-instance=doc-sync',
      ].join(' '),
    )
  })
})
