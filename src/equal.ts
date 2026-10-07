/**
 * Deep equality for Firestore values.
 *
 * Maps and arrays are compared structurally. Firestore value classes
 * (`Timestamp`, `GeoPoint`, `DocumentReference`, `FieldValue`, ...) are compared
 * with their own `isEqual`. Bytes (`Buffer` / `Uint8Array`) are compared byte-wise.
 */
export function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false

  const ta = typeof a
  if (ta !== typeof b) return false
  if (ta === 'number') return Number.isNaN(a as number) && Number.isNaN(b as number)
  if (ta !== 'object') return false

  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!(Array.isArray(a) && Array.isArray(b)) || a.length !== b.length) return false
    return a.every((v, i) => isEqual(v, b[i]))
  }

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }

  const ea = a as { isEqual?: unknown; constructor?: unknown }
  const eb = b as { isEqual?: unknown; constructor?: unknown }
  if (typeof ea.isEqual === 'function' || typeof eb.isEqual === 'function') {
    if (typeof ea.isEqual !== 'function' || ea.constructor !== eb.constructor) return false
    return Boolean((ea.isEqual as (o: unknown) => boolean).call(a, b))
  }

  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!isEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}
