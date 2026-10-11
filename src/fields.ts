/**
 * Dotted field paths (`address.city`) on plain decoded data. The Admin SDK handles
 * dotted paths in `snapshot.get()` / `update()`; these helpers do the same for
 * objects decoded from event payloads and for building nested copies.
 */
import type { DocumentData } from 'firebase-admin/firestore'

export function splitFieldPath(path: string): string[] {
  return path.split('.')
}

/** Reads a dotted path. Returns undefined when any intermediate value is not a map. */
export function getField(data: DocumentData | undefined, path: string): unknown {
  let cur: unknown = data
  for (const key of splitFieldPath(path)) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[key]
    if (cur === undefined) return undefined
  }
  return cur
}

/** Writes a dotted path, creating intermediate maps. */
export function setField(out: DocumentData, path: string, value: unknown): void {
  const keys = splitFieldPath(path)
  let cur: Record<string, unknown> = out
  for (const key of keys.slice(0, -1)) {
    const next = cur[key]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cur[key] = {}
    cur = cur[key] as Record<string, unknown>
  }
  cur[keys[keys.length - 1]!] = value
}

/** True when `a` equals `b` or one is a prefix path of the other (`a` / `a.b`). */
export function fieldPathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}

/** Field path segments may not be empty, contain Firestore's reserved characters, or be of the reserved form `__name__`. */
export function isValidFieldPath(path: string): boolean {
  return splitFieldPath(path).every((s) => s.length > 0 && !/[~*/[\]]/.test(s) && !/^__.*__$/.test(s))
}
