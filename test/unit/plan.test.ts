import { describe, expect, it } from 'vitest'
import { validateConfig } from '../../src/config.js'
import {
  desiredTriggers,
  ownedTriggers,
  planTriggers,
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
  connections: [
    { name: 'a', source: 'category', target: 'post', idField: 'categoryId', fields: ['name'], targetField: 'category', onSourceDelete: 'setNull' },
    { name: 'b', source: 'post', target: 'user_room', idField: 'postId', fields: ['title'], targetField: 'post', onSourceDelete: 'nothing' },
  ],
})

describe('plan', () => {
  it('expands a bare service account id', () => {
    expect(serviceAccountEmail(config, 'my-proj')).toBe('doc-sync-trigger@my-proj.iam.gserviceaccount.com')
    expect(serviceAccountEmail({ serviceAccount: 'x@y.iam.gserviceaccount.com' }, 'p')).toBe('x@y.iam.gserviceaccount.com')
  })

  it('derives one trigger per collection', () => {
    expect(desiredTriggers(config).map((t) => t.name)).toEqual(['doc-sync-category', 'doc-sync-post', 'doc-sync-user-room'])
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
    const plan = planTriggers(desiredTriggers(config), [{ name: 'doc-sync-post' }, { name: 'doc-sync-old' }])
    expect(plan.create.map((t) => t.name)).toEqual(['doc-sync-category', 'doc-sync-user-room'])
    expect(plan.keep.map((t) => t.name)).toEqual(['doc-sync-post'])
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
