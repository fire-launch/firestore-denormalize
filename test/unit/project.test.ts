import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeProjectSource, requireExplicitProject, resolveProject, type ProjectInputs } from '../../src/cli/project.js'

function inputs(overrides: Partial<ProjectInputs> = {}): ProjectInputs {
  return { env: {}, cwd: '/x', gcloudDefault: () => undefined, ...overrides }
}

describe('resolveProject precedence', () => {
  it('prefers --project over everything else', () => {
    const resolved = resolveProject(
      inputs({
        flag: 'flag-proj',
        env: { GOOGLE_CLOUD_PROJECT: 'env-proj' },
        readFirebaserc: () => 'rc-proj',
        gcloudDefault: () => 'gcloud-proj',
      }),
    )
    expect(resolved).toEqual({ project: 'flag-proj', source: 'flag' })
  })

  it('prefers env over .firebaserc and gcloud', () => {
    const resolved = resolveProject(
      inputs({
        env: { GOOGLE_CLOUD_PROJECT: 'env-proj' },
        readFirebaserc: () => 'rc-proj',
        gcloudDefault: () => 'gcloud-proj',
      }),
    )
    expect(resolved).toEqual({ project: 'env-proj', source: 'env' })
  })

  it('prefers .firebaserc over gcloud', () => {
    const resolved = resolveProject(inputs({ readFirebaserc: () => 'rc-proj', gcloudDefault: () => 'gcloud-proj' }))
    expect(resolved).toEqual({ project: 'rc-proj', source: 'firebaserc' })
  })

  it('falls back to gcloud when nothing else resolves', () => {
    const resolved = resolveProject(inputs({ readFirebaserc: () => undefined, gcloudDefault: () => 'gcloud-proj' }))
    expect(resolved).toEqual({ project: 'gcloud-proj', source: 'gcloud' })
  })

  it('returns undefined when nothing resolves', () => {
    const resolved = resolveProject(inputs({ readFirebaserc: () => undefined, gcloudDefault: () => undefined }))
    expect(resolved).toBeUndefined()
  })

  it('checks GOOGLE_CLOUD_PROJECT, then GCLOUD_PROJECT, then CLOUDSDK_CORE_PROJECT', () => {
    expect(resolveProject(inputs({ env: { GCLOUD_PROJECT: 'gp' } }))).toEqual({ project: 'gp', source: 'env' })
    expect(resolveProject(inputs({ env: { CLOUDSDK_CORE_PROJECT: 'cp' } }))).toEqual({ project: 'cp', source: 'env' })
    expect(resolveProject(inputs({ env: { GOOGLE_CLOUD_PROJECT: 'gcp', GCLOUD_PROJECT: 'gp' } }))).toEqual({ project: 'gcp', source: 'env' })
  })
})

describe('.firebaserc lookup', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('finds .firebaserc at or above cwd, from a nested directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'doc-sync-rc-'))
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'rc-proj' } }))
    const nested = join(dir, 'a', 'b')
    mkdirSync(nested, { recursive: true })

    const resolved = resolveProject(inputs({ cwd: nested, gcloudDefault: () => 'gcloud-proj' }))
    expect(resolved).toEqual({ project: 'rc-proj', source: 'firebaserc' })
  })

  it('tolerates a missing .firebaserc', () => {
    dir = mkdtempSync(join(tmpdir(), 'doc-sync-rc-'))
    const resolved = resolveProject(inputs({ cwd: dir, gcloudDefault: () => 'gcloud-proj' }))
    expect(resolved).toEqual({ project: 'gcloud-proj', source: 'gcloud' })
  })

  it('tolerates an invalid .firebaserc', () => {
    dir = mkdtempSync(join(tmpdir(), 'doc-sync-rc-'))
    writeFileSync(join(dir, '.firebaserc'), 'not json')
    const resolved = resolveProject(inputs({ cwd: dir, gcloudDefault: () => 'gcloud-proj' }))
    expect(resolved).toEqual({ project: 'gcloud-proj', source: 'gcloud' })
  })
})

describe('describeProjectSource', () => {
  it('names each source', () => {
    expect(describeProjectSource('flag')).toBe('from --project')
    expect(describeProjectSource('env')).toBe('from $GOOGLE_CLOUD_PROJECT')
    expect(describeProjectSource('firebaserc')).toBe('from .firebaserc')
    expect(describeProjectSource('gcloud')).toBe("from gcloud active config")
    expect(describeProjectSource('emulator-default')).toBe('emulator default')
  })
})

describe('requireExplicitProject', () => {
  it('throws only when the source is gcloud', () => {
    expect(() => requireExplicitProject({ project: 'my-proj', source: 'gcloud' }, 'setup')).toThrow(
      '`setup` changes project "my-proj", which only comes from gcloud\'s active config. Name it: --project my-proj, GOOGLE_CLOUD_PROJECT, or .firebaserc.',
    )
    for (const source of ['flag', 'env', 'firebaserc', 'emulator-default'] as const) {
      expect(() => requireExplicitProject({ project: 'my-proj', source }, 'setup')).not.toThrow()
    }
  })
})
