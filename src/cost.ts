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
    const runsPerDay = cronRunsPerDay(rule.scheduled.cron)
    const runsPerDayText = runsPerDay === undefined ? 'runs/day unknown' : runsPerDay === 1 ? '1 run/day' : `${formatRunsPerDay(runsPerDay)} runs/day`
    const warnings = [...perEvent.warnings]
    if (runsPerDay !== undefined && runsPerDay > 24) {
      const r = formatRunsPerDay(runsPerDay)
      warnings.push(
        `schedule "${rule.scheduled.cron}" runs ${r} times a day: every target is read ${r} times a day. Use a less frequent cron, or \`defer\` for event-driven batching.`,
      )
    }
    return {
      ...perEvent,
      warnings,
      lines: [
        {
          trigger: `schedule ${rule.scheduled.cron} (${rule.scheduled.timeZone}): every ${rule.target}`,
          reads: `T × (${perTarget}) per run, ${runsPerDayText}`,
          writes: '≤ T per run',
        },
      ],
    }
  }
  if (rule.deferred) return deferCost(rule, perEvent, rule.deferred.everyMs)
  return perEvent
}

/** `1440` / `48` as-is; `0.14` for non-integer values below 1 (and any other non-integer). */
function formatRunsPerDay(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/**
 * Average runs per day of a 5-field unix-cron over a full year; `undefined` for syntax this
 * evaluator does not know (names, `?`, `L`, `W`, `#`). Walks the 365 days of 2025 (a non-leap
 * year, so every calendar date and weekday occurs its usual number of times) and, for each day
 * whose month and day-of-month/day-of-week match, adds the number of minute/hour combinations
 * that run that day; divides the total by 365. The time zone does not matter for a yearly average.
 */
export function cronRunsPerDay(cron: string): number | undefined {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const [minuteSpec, hourSpec, domSpec, monthSpec, dowSpec] = fields as [string, string, string, string, string]
  const minuteSet = parseCronField(minuteSpec, 0, 59)
  const hourSet = parseCronField(hourSpec, 0, 23)
  const domSet = parseCronField(domSpec, 1, 31)
  const monthSet = parseCronField(monthSpec, 1, 12)
  const dowSetRaw = parseCronField(dowSpec, 0, 7)
  if (!minuteSet || !hourSet || !domSet || !monthSet || !dowSetRaw) return undefined
  const dowSet = new Set(Array.from(dowSetRaw, (d) => (d === 7 ? 0 : d)))
  const domRestricted = domSpec !== '*'
  const dowRestricted = dowSpec !== '*'

  const start = Date.UTC(2025, 0, 1, 0, 0)
  const runsPerMatchingDay = minuteSet.size * hourSet.size
  let total = 0
  for (let day = 0; day < 365; day++) {
    const t = new Date(start + day * 86400000)
    if (!monthSet.has(t.getUTCMonth() + 1)) continue
    const domMatch = domSet.has(t.getUTCDate())
    const dowMatch = dowSet.has(t.getUTCDay())
    const dayMatches = domRestricted && dowRestricted ? domMatch || dowMatch : domRestricted ? domMatch : dowRestricted ? dowMatch : true
    if (dayMatches) total += runsPerMatchingDay
  }
  return total / 365
}

/** One cron field (a star, a number, a range, a stepped star or range, comma lists); `null` for anything else. */
function parseCronField(spec: string, min: number, max: number): Set<number> | null {
  const result = new Set<number>()
  for (const part of spec.split(',')) {
    const star = /^\*(?:\/(\d+))?$/.exec(part)
    if (star) {
      const step = star[1] ? Number(star[1]) : 1
      if (step <= 0) return null
      for (let v = min; v <= max; v += step) result.add(v)
      continue
    }
    const range = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part)
    if (range) {
      const a = Number(range[1])
      const b = Number(range[2])
      const step = range[3] ? Number(range[3]) : 1
      if (step <= 0 || a > b || a < min || b > max) return null
      for (let v = a; v <= b; v += step) result.add(v)
      continue
    }
    const single = /^(\d+)$/.exec(part)
    if (single) {
      const v = Number(single[1])
      if (v < min || v > max) return null
      result.add(v)
      continue
    }
    return null
  }
  return result
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
  const warnings: string[] = []
  if (typeof rule.aggregate === 'object' && rule.idField !== undefined) {
    warnings.push(
      `sum("${rule.aggregate.sum}") filtered by ${rule.idField} needs a composite index on ${rule.source} (${rule.idField}, ${rule.aggregate.sum}); rebuild stops with FAILED_PRECONDITION until it exists`,
    )
  }
  return {
    rule: rule.name,
    kind: 'aggregate',
    lines: [sourceLine, { trigger: `${rule.target}/{id} created`, reads: '1 + 1 aggregation', writes: '≤ 1' }],
    warnings,
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
