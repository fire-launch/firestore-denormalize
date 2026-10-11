/**
 * Thin wrapper around `gcloud` / `firebase` CLIs.
 * Read-only commands always run. Mutating commands are printed only when `dryRun` is set.
 */
import { spawnSync } from 'node:child_process'

export interface Runner {
  /** Runs a read-only command and returns stdout. Throws on non-zero exit. */
  read(cmd: string, args: string[]): string
  /** Runs a command that changes state. In dry-run mode it is only printed. */
  mutate(cmd: string, args: string[]): void
  readonly dryRun: boolean
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`${command} exited with ${exitCode}${stderr ? `\n${stderr.trim()}` : ''}`)
    this.name = 'CommandError'
  }
}

export function formatCommand(cmd: string, args: string[]): string {
  const quote = (a: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
  return [cmd, ...args.map(quote)].join(' ')
}

/** `.cmd` shims on Windows need a shell to be found. */
const SHELL = process.platform === 'win32'

function spawnError(cmd: string, err: NodeJS.ErrnoException): Error {
  if (err.code === 'ENOENT') return new Error(`\`${cmd}\` was not found on PATH. Install it and make sure it is on your PATH.`)
  return err
}

/** With a shell, Node joins the arguments unquoted; quote the ones that need it so spaces and metacharacters survive. */
function shellArgs(args: string[]): string[] {
  if (!SHELL) return args
  return args.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["%])/g, '^$1')}"`))
}

export function createRunner(opts: { dryRun: boolean; log: (line: string) => void }): Runner {
  return {
    dryRun: opts.dryRun,
    read(cmd, args) {
      const r = spawnSync(cmd, shellArgs(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: SHELL })
      if (r.error) throw spawnError(cmd, r.error)
      if (r.status !== 0) throw new CommandError(formatCommand(cmd, args), r.status, r.stderr)
      return r.stdout
    },
    mutate(cmd, args) {
      opts.log(`${opts.dryRun ? '[dry-run] ' : '$ '}${formatCommand(cmd, args)}`)
      if (opts.dryRun) return
      const r = spawnSync(cmd, shellArgs(args), { stdio: 'inherit', shell: SHELL })
      if (r.error) throw spawnError(cmd, r.error)
      if (r.status !== 0) throw new CommandError(formatCommand(cmd, args), r.status, '')
    },
  }
}
