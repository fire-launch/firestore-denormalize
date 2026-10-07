/**
 * Collection path patterns such as `post` or `users/{uid}/payments`.
 *
 * A pattern alternates collection IDs (literals) and document IDs (a literal or a
 * `{param}` placeholder). The same pattern is used for Eventarc path patterns, for
 * matching incoming document paths, and for resolving the concrete collection to query.
 */

export type Segment = { kind: 'collection'; id: string } | { kind: 'literal'; id: string } | { kind: 'param'; name: string }

export interface CollectionPattern {
  /** As written in the config. */
  raw: string
  /** `raw` with every `{param}` replaced by `{}`; identifies the collection regardless of param names. */
  key: string
  segments: Segment[]
  /** Param names in order of appearance. */
  params: string[]
  /** Last segment: the collection ID used for collection-group queries. */
  collectionId: string
}

const SEGMENT = /^[^/]+$/
const PARAM = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/** Parses a pattern. Throws with a readable message when the shape is wrong. */
export function parseCollectionPattern(raw: string): CollectionPattern {
  const parts = raw.split('/')
  if (parts.length % 2 === 0) {
    throw new Error(`"${raw}" is not a collection path (it must have an odd number of segments, e.g. "users/{uid}/payments")`)
  }
  const segments: Segment[] = []
  const params: string[] = []
  parts.forEach((part, i) => {
    if (!SEGMENT.test(part)) throw new Error(`"${raw}" contains an empty segment`)
    if (i % 2 === 0) {
      if (PARAM.test(part)) throw new Error(`"${raw}": collection ID "${part}" cannot be a placeholder`)
      segments.push({ kind: 'collection', id: part })
      return
    }
    const m = PARAM.exec(part)
    if (m) {
      const name = m[1]!
      if (params.includes(name)) throw new Error(`"${raw}": placeholder {${name}} appears twice`)
      params.push(name)
      segments.push({ kind: 'param', name })
    } else if (part.includes('{') || part.includes('}')) {
      throw new Error(`"${raw}": "${part}" is not a valid placeholder (use {name})`)
    } else {
      segments.push({ kind: 'literal', id: part })
    }
  })
  return {
    raw,
    key: parts.map((p, i) => (i % 2 === 1 && PARAM.test(p) ? '{}' : p)).join('/'),
    segments,
    params,
    collectionId: parts[parts.length - 1]!,
  }
}

export interface DocumentMatch {
  /** Document ID (last path segment). */
  id: string
  /** Values bound to the pattern's placeholders. */
  params: Record<string, string>
  /** Full document path. */
  path: string
}

/** Matches `coll/doc[/coll/doc...]` against the pattern. */
export function matchDocumentPath(pattern: CollectionPattern, docPath: string): DocumentMatch | undefined {
  const parts = docPath.split('/')
  if (parts.length !== pattern.segments.length + 1 || parts.some((p) => p === '')) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < pattern.segments.length; i++) {
    const seg = pattern.segments[i]!
    const part = parts[i]!
    if (seg.kind === 'param') params[seg.name] = part
    else if (seg.id !== part) return undefined
  }
  return { id: parts[parts.length - 1]!, params, path: docPath }
}

/** Concrete collection path with params substituted, or undefined if any placeholder is unbound. */
export function resolveCollectionPath(pattern: CollectionPattern, params: Record<string, string>): string | undefined {
  const out: string[] = []
  for (const seg of pattern.segments) {
    if (seg.kind === 'param') {
      const v = params[seg.name]
      if (v === undefined) return undefined
      out.push(v)
    } else out.push(seg.id)
  }
  return out.join('/')
}

/** True when every placeholder of `pattern` is bound by `params`. */
export function isResolvable(pattern: CollectionPattern, params: Record<string, string> | string[]): boolean {
  const names = Array.isArray(params) ? params : Object.keys(params)
  return pattern.params.every((p) => names.includes(p))
}

/** Eventarc path pattern for documents of this collection, e.g. `users/{uid}/payments/{docId}`. */
export function eventarcPathPattern(pattern: CollectionPattern): string {
  const docName = pattern.params.includes('docId') ? 'doc' : 'docId'
  const parts = pattern.segments.map((s) => (s.kind === 'param' ? `{${s.name}}` : s.id))
  return `${parts.join('/')}/{${docName}}`
}

/** Short identifier for trigger names: literal segments joined by `-`, `_` replaced by `-`. */
export function patternSlug(pattern: CollectionPattern): string {
  return pattern.segments
    .filter((s) => s.kind !== 'param')
    .map((s) => (s as { id: string }).id)
    .join('-')
    .replace(/_/g, '-')
}

/** Normalizes an Eventarc path pattern for comparison: placeholder names are irrelevant. */
export function normalizePathPattern(p: string): string {
  return p.replace(/\{[^}]*\}/g, '{}')
}
