import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import { type DocSyncConfig, type ResolvedConfig, validateConfig } from '../config.js'

export const DEFAULT_CONFIG_PATH = './doc-sync.config.ts'

/** Loads `doc-sync.config.ts` (TypeScript or JavaScript, ESM or CJS) and validates it. */
export async function loadConfig(path: string = DEFAULT_CONFIG_PATH): Promise<{ path: string; config: ResolvedConfig }> {
  const abs = resolve(process.cwd(), path)
  if (!existsSync(abs)) throw new Error(`config file not found: ${abs}`)
  const jiti = createJiti(pathToFileURL(abs).href, { interopDefault: true })
  const loaded = (await jiti.import(abs, { default: true })) as DocSyncConfig | undefined
  if (!loaded) throw new Error(`${path} must \`export default defineConfig({...})\``)
  return { path: abs, config: validateConfig(loaded) }
}
