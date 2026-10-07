/**
 * Minimal logger interface. `console` and `firebase-functions/logger` both satisfy it.
 * The default logger writes one JSON object per line, which Cloud Logging parses
 * into structured entries (`severity`, `message`, and the extra fields).
 */
export interface Logger {
  debug?(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export const jsonLogger: Logger = {
  debug: (message, fields) => write('DEBUG', message, fields),
  info: (message, fields) => write('INFO', message, fields),
  warn: (message, fields) => write('WARNING', message, fields),
  error: (message, fields) => write('ERROR', message, fields),
}

function write(severity: string, message: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ severity, message, ...fields }, replacer)
  if (severity === 'ERROR' || severity === 'WARNING') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
  return value
}
