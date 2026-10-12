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
  const perEvent = rule.kind === 'connection' ? estimateConnectionCost(rule) : rule.kind === 'aggregate' ? estimateAggregateCost(rule) : estimateViewCost(rule)
  if (rule.scheduled) {
    // A scheduled rule runs `rebuild`: every target once per run. The per-target reads are the target-side line's reads.
    const perTarget = perEvent.lines[perEvent.lines.length - 1]!.reads
    return {
      ...perEvent,
      lines: [{ trigger: `schedule ${rule.scheduled.cron} (${rule.scheduled.timeZone}): every ${rule.target}`, reads: `T × (${perTarget})`, writes: '≤ T' }],
    }
  }
  if (rule.deferred) return deferCost(rule, perEvent, rule.deferred.everyMs)
  return perEvent
}

/**
 * Lines of a deferred rule. An event that only marks costs a task; a flush line carries what the
 * recompute costs, at most once per interval per marked document. Lifecycle events (a target's
 * first value, a base created or deleted) keep their immediate cost.
 */
function deferCost(rule: ResolvedRule, perEvent: RuleCost, everyMs: number): RuleCost {
  const every = formatDuration(everyMs)
  const marks = (tasks = '1'): Pick<CostLine, 'reads' | 'writes'> => ({ reads: `0 (+ ${tasks} task${tasks === '1' ? '' : 's'})`, writes: '0' })
  const flush = (doc: string, reads: string, writes: string): CostLine => ({ trigger: `flush ${doc} (≤ 1 per ${every})`, reads, writes })
  const lines: CostLine[] = []
  if (rule.kind === 'connection') {
    const [source, target] = perEvent.lines as [CostLine, CostLine]
    lines.push({ trigger: source.trigger, ...marks() }, flush(`${rule.source}/{id}`, source.reads, source.writes))
    lines.push({ trigger: `${rule.target}/{id} created`, reads: target.reads, writes: target.writes })
    lines.push({ trigger: `${rule.target}/{id} ${rule.idField} changed`, ...marks() }, flush(`${rule.target}/{id}`, target.reads, target.writes))
  } else if (rule.kind === 'aggregate') {
    const [source, target] = perEvent.lines as [CostLine, CostLine]
    lines.push({ trigger: source.trigger, ...marks(rule.idParam !== undefined ? '1' : '≤ 2') })
    lines.push(target) // a target's first value is written immediately
    lines.push(flush(`${rule.target}/{id}`, target.reads, target.writes))
  } else {
    const target = perEvent.lines[perEvent.lines.length - 1]!
    const perTarget = target.reads
    let i = 0
    if (rule.base) {
      i++
      lines.push({ trigger: `${rule.base}/{id} created or deleted`, reads: perTarget, writes: '≤ 1 (create / remove the target)' })
      lines.push({ trigger: `${rule.base}/{id} updated`, ...marks() })
    }
    const refFieldNames: string[] = []
    for (const s of rule.sources) {
      const line = perEvent.lines[i++]!
      if (s.refField !== undefined) {
        refFieldNames.push(s.refField)
        lines.push({ trigger: line.trigger, ...marks() }, flush(`${s.collection}/{id}`, line.reads, line.writes))
      } else {
        lines.push({ trigger: line.trigger, ...marks(s.idField !== undefined ? '≤ 2' : '1') })
      }
    }
    lines.push({ trigger: `${rule.target}/{id} ${rule.base ? 'created or deleted' : 'created'}`, reads: perTarget, writes: '≤ 1' })
    if (refFieldNames.length) lines.push({ trigger: `${rule.target}/{id} ${refFieldNames.join('/')} changed`, ...marks() })
    lines.push(flush(`${rule.target}/{id}`, perTarget, '≤ 1'))
  }
  return { ...perEvent, lines }
}

/** Inverse of `parseDuration`: milliseconds back to `'90s'`, `'10m'`, `'1h'`, `'1h30m'`. */
export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000
  if (totalSeconds % 60 !== 0) return `${totalSeconds}s`
  const totalMinutes = totalSeconds / 60
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours ? `${hours}h` : ''}${minutes ? `${minutes}m` : ''}` || '0m'
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
  const baseRead = rule.base ? ' + 1 base' : ''
  const perTarget = `1 target${baseRead}${segments.join('')} (+ reads inside build)`
  /** Reads of a patch attempt: the target, the base (if any) and the changed document. */
  const direct = rule.base ? 3 : 2

  const lines: CostLine[] = []
  const warnings: string[] = []
  const refFieldNames: string[] = []

  if (rule.base) lines.push({ trigger: `${rule.base}/{id} changed`, reads: perTarget, writes: '≤ 1 (create / update / remove the target)' })

  for (const s of rule.sources) {
    const trigger = `${s.collection}/{id} changed`
    if (s.refField !== undefined) {
      refFieldNames.push(s.refField)
      const reads = rule.patch
        ? `N + N × ${direct} (+ reads inside patch); if patch returns undefined: N + N × (${perTarget})`
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
        ? `≤ 2 × ${direct} (+ reads inside patch); if patch returns undefined: ≤ 2 × (${perTarget})`
        : `≤ 2 × (${perTarget})`
      : rule.patch
        ? `${direct} (+ reads inside patch); if patch returns undefined: ${perTarget}`
        : perTarget
    lines.push({ trigger, reads, writes: isIdField ? '≤ 2' : '≤ 1' })
    if (s.limit === undefined && !rule.patch) {
      warnings.push(`source "${s.key}" has no limit and the view has no patch, so every event reads all ${s.collection} documents of the target`)
    }
  }

  const suffix = refFieldNames.length ? ` or ${refFieldNames.join('/')} changed` : ''
  const targetEvents = rule.base ? 'created or deleted' : 'created'
  lines.push({ trigger: `${rule.target}/{id} ${targetEvents}${suffix}`, reads: perTarget, writes: '≤ 1' })

  return { rule: rule.name, kind: rule.kind, lines, warnings }
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
