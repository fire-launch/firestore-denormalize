/**
 * Static cost estimate for `doc-sync validate`: per rule, the Firestore reads and writes one
 * event causes at most, as formulas over N (targets matching the changed source) and M
 * (source documents belonging to one target). Reads inside a view's `build` / `patch` are
 * user code and cannot be counted here; see the runtime counters in `RuleResult` for those.
 */
import type { ResolvedAggregate, ResolvedConnection, ResolvedRule, ResolvedView, WriteTrigger } from './config.js'

export interface CostLine {
  /** What happened, e.g. `category/{id} changed` or `post/{id} created or categoryId changed`. */
  trigger: string
  /** Billable document reads (aggregations listed separately), as a formula. */
  reads: string
  /** Document writes, as a formula. */
  writes: string
}

export interface RuleCost {
  rule: string
  kind: ResolvedRule['kind']
  lines: CostLine[]
  /** Shapes that are expensive by construction. */
  warnings: string[]
}

export function estimateCost(rule: ResolvedRule): RuleCost {
  if (rule.kind === 'connection') return estimateConnectionCost(rule)
  if (rule.kind === 'aggregate') return estimateAggregateCost(rule)
  return estimateViewCost(rule)
}

function estimateConnectionCost(rule: ResolvedConnection): RuleCost {
  return {
    rule: rule.name,
    kind: 'connection',
    lines: [
      { trigger: `${rule.source}/{id} changed`, reads: 'N + 1', writes: '≤ N' },
      { trigger: `${rule.target}/{id} created or ${rule.idField} changed`, reads: '2', writes: '≤ 1' },
    ],
    warnings: [],
  }
}

function estimateAggregateCost(rule: ResolvedAggregate): RuleCost {
  const sourceLine: CostLine =
    rule.idParam !== undefined
      ? { trigger: `${rule.source}/{id} changed`, reads: '1 + 1 aggregation', writes: '≤ 1' }
      : { trigger: `${rule.source}/{id} changed`, reads: '≤ 2 × (1 + 1 aggregation)', writes: '≤ 2' }
  return {
    rule: rule.name,
    kind: 'aggregate',
    lines: [sourceLine, { trigger: `${rule.target}/{id} created`, reads: '1 + 1 aggregation', writes: '≤ 1' }],
    warnings: [],
  }
}

function estimateViewCost(rule: ResolvedView): RuleCost {
  const segments = rule.sources.map((s) => {
    if (s.refField !== undefined) return ` + 1 ${s.key}`
    if (s.limit !== undefined) return ` + ≤ ${s.limit} ${s.key}`
    return ` + M ${s.key}`
  })
  const perTarget = `1 target${segments.join('')} (+ reads inside build)`

  const lines: CostLine[] = []
  const warnings: string[] = []
  const refFieldNames: string[] = []

  for (const s of rule.sources) {
    const trigger = `${s.collection}/{id} changed`
    if (s.refField !== undefined) {
      refFieldNames.push(s.refField)
      const reads = rule.patch
        ? `N + N × 2 (+ reads inside patch); if patch returns undefined: N + N × (${perTarget})`
        : `N + N × (${perTarget})`
      lines.push({ trigger, reads, writes: '≤ N' })
      warnings.push(
        `source "${s.key}" (refField) fans out: one change of a ${s.collection} document rebuilds every ${rule.target} that points at it`,
      )
      continue
    }

    const isIdField = s.idField !== undefined
    const reads = isIdField
      ? rule.patch
        ? `≤ 2 × 2 (+ reads inside patch); if patch returns undefined: ≤ 2 × (${perTarget})`
        : `≤ 2 × (${perTarget})`
      : rule.patch
        ? `2 (+ reads inside patch); if patch returns undefined: ${perTarget}`
        : perTarget
    lines.push({ trigger, reads, writes: isIdField ? '≤ 2' : '≤ 1' })
    if (s.limit === undefined && !rule.patch) {
      warnings.push(`source "${s.key}" has no limit and the view has no patch, so every event reads all ${s.collection} documents of the target`)
    }
  }

  const suffix = refFieldNames.length ? ` or ${refFieldNames.join('/')} changed` : ''
  lines.push({ trigger: `${rule.target}/{id} created${suffix}`, reads: perTarget, writes: '≤ 1' })

  return { rule: rule.name, kind: 'view', lines, warnings }
}

/** Maximal chains `a -> b -> c` through the write-trigger edges (acyclic: validated configs have no loops). */
export function formatChains(edges: WriteTrigger[]): string[] {
  const outgoing = new Map<string, string[]>()
  const incoming = new Set<string>()
  const nodeOrder: string[] = []
  const seenNodes = new Set<string>()
  const addNode = (n: string) => {
    if (!seenNodes.has(n)) {
      seenNodes.add(n)
      nodeOrder.push(n)
    }
  }
  for (const e of edges) {
    addNode(e.from)
    addNode(e.to)
    if (!outgoing.has(e.from)) outgoing.set(e.from, [])
    outgoing.get(e.from)!.push(e.to)
    incoming.add(e.to)
  }

  const roots = nodeOrder.filter((n) => !incoming.has(n))
  const chains: string[] = []

  const visit = (node: string, path: string[]) => {
    const next = outgoing.get(node)
    if (!next || next.length === 0) {
      if (path.length > 1) chains.push(path.join(' -> '))
      return
    }
    for (const to of next) {
      if (path.includes(to)) continue // guard against cycles; validated configs are acyclic
      visit(to, [...path, to])
    }
  }

  for (const root of roots) visit(root, [root])

  return chains
}
