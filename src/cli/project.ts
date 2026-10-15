/**
 * Resolves the GCP project for CLI commands and names where it came from, so commands
 * that change real infrastructure can refuse to run against an implicit `gcloud` default.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ProjectSource = 'flag' | 'env' | 'firebaserc' | 'gcloud' | 'emulator-default'

export interface ResolvedProject {
  project: string
  source: ProjectSource
}

const ENV_VARS = ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT'] as const

export interface ProjectInputs {
  flag?: string
  env: NodeJS.ProcessEnv
  /** Directory to search upwards for `.firebaserc` (uses `projects.default`). */
  cwd: string
  /** Reads gcloud's active project; `undefined` when unset or gcloud missing. */
  gcloudDefault: () => string | undefined
  /** Returns the `.firebaserc` default project found at or above `cwd`, or undefined (injectable for tests). */
  readFirebaserc?: (cwd: string) => string | undefined
}

/** Order: --project, GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT / CLOUDSDK_CORE_PROJECT, .firebaserc, gcloud. */
export function resolveProject(inputs: ProjectInputs): ResolvedProject | undefined {
  if (inputs.flag) return { project: inputs.flag, source: 'flag' }

  for (const name of ENV_VARS) {
    const value = inputs.env[name]
    if (value) return { project: value, source: 'env' }
  }

  const fromFirebaserc = (inputs.readFirebaserc ?? readFirebaserc)(inputs.cwd)
  if (fromFirebaserc) return { project: fromFirebaserc, source: 'firebaserc' }

  const fromGcloud = inputs.gcloudDefault()
  if (fromGcloud) return { project: fromGcloud, source: 'gcloud' }

  return undefined
}

export function describeProjectSource(source: ProjectSource): string {
  switch (source) {
    case 'flag':
      return 'from --project'
    case 'env':
      return 'from environment variable'
    case 'firebaserc':
      return 'from .firebaserc'
    case 'gcloud':
      return "from gcloud active config"
    case 'emulator-default':
      return 'emulator default'
  }
}

/** Throws unless the project was named explicitly (flag, env or .firebaserc). */
export function requireExplicitProject(resolved: ResolvedProject, command: string): void {
  if (resolved.source !== 'gcloud') return
  throw new Error(
    `\`${command}\` changes project "${resolved.project}", which only comes from gcloud's active config. Name it: --project ${resolved.project}, GOOGLE_CLOUD_PROJECT, or .firebaserc.`,
  )
}

/** Walks from `cwd` upward to the filesystem root looking for `.firebaserc`, reading `projects.default`. */
function readFirebaserc(cwd: string): string | undefined {
  let dir = cwd
  for (;;) {
    const candidate = join(dir, '.firebaserc')
    const project = readFirebasercFile(candidate)
    if (project) return project
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function readFirebasercFile(path: string): string | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as { projects?: { default?: string } }
    return parsed.projects?.default
  } catch {
    return undefined
  }
}
