import { formatMs, formatPercent, normalizeName } from './format'
import type { Insight, InsightKind, InsightOptions, SpanData } from './types'

const EPSILON = 1e-6
const SEVERITY_RANK = { warn: 0, info: 1 } as const
const KIND_RANK: Record<InsightKind, number> = {
  unawaited: 0,
  error: 1,
  repeated: 2,
  sequential: 3,
  bottleneck: 4,
}
/** At most this many "could run in parallel" hints per trace: they are hints, not facts. */
const MAX_SEQUENTIAL = 2

const endOf = (span: SpanData): number => span.start + span.duration
const code = (name: string): string => `\`${name}\``

/**
 * Fills in `depth`, `selfTime` and `critical` on every span (in place) and returns insights.
 * `spans` must be sorted by start time with the root first.
 */
export function analyze(spans: SpanData[], options: InsightOptions | false = {}): Insight[] {
  const root = spans[0]
  if (!root) return []
  const byId = new Map<number, SpanData>()
  const children = new Map<number, SpanData[]>()
  for (const span of spans) {
    byId.set(span.id, span)
    if (span.parentId === null) continue
    const siblings = children.get(span.parentId)
    if (siblings) siblings.push(span)
    else children.set(span.parentId, [span])
  }
  const kidsOf = (span: SpanData): SpanData[] => children.get(span.id) ?? []

  for (const span of spans) {
    const parent = span.parentId === null ? undefined : byId.get(span.parentId)
    span.depth = parent ? parent.depth + 1 : 0
    span.selfTime = round(Math.max(0, span.duration - covered(span, kidsOf(span))))
    span.critical = false
  }
  markCriticalPath(root, kidsOf)

  if (options === false) return []
  const settings = {
    minRepeats: Math.max(2, options.minRepeats ?? 5),
    minSavings: options.minSavings ?? 5,
    bottleneckRatio: options.bottleneckRatio ?? 0.25,
  }
  const ignore = new Set(options.ignore ?? [])
  const total = root.duration
  const minSavings = Math.max(settings.minSavings, total * 0.05)
  const insights: Insight[] = []

  // 1. Work that outlived its parent: the classic forgotten `await`.
  const unawaited = new Set<number>()
  for (const span of spans) {
    if (span.parentId === null) continue
    const parent = byId.get(span.parentId)
    if (!parent) continue
    if (unawaited.has(parent.id)) {
      unawaited.add(span.id)
      continue
    }
    const stillRunning = span.end === null
    const finishedLate = parent.end !== null && span.end !== null && span.end > parent.end + 0.5
    if (!stillRunning && !finishedLate) continue
    unawaited.add(span.id)
    if (ignore.has('unawaited')) continue
    const what = span.kind === 'http' ? 'in flight' : 'running'
    const message = stillRunning
      ? `${code(span.name)} was still ${what} when ${code(parent.name)} finished. Is an \`await\` missing?`
      : `${code(span.name)} finished ${formatMs((span.end ?? 0) - (parent.end ?? 0))} after its parent ${code(parent.name)} returned. Is an \`await\` missing?`
    insights.push({ kind: 'unawaited', severity: 'warn', message, spanIds: [span.id] })
  }

  // 2. Errors, reported where they started (not on every ancestor they bubbled through).
  if (!ignore.has('error')) {
    for (const span of spans) {
      if (span.parentId === null || span.status !== 'error') continue
      const fromChild = kidsOf(span).some(
        (kid) => kid.status === 'error' && kid.error === span.error,
      )
      if (fromChild) continue
      const swallowed = root.status === 'ok'
      insights.push({
        kind: 'error',
        severity: swallowed ? 'warn' : 'info',
        message:
          `${code(span.name)} failed after ${formatMs(span.duration)} with ${span.error ?? 'an error'}.` +
          (swallowed ? ` It was caught before reaching ${code(root.name)}.` : ''),
        spanIds: [span.id],
      })
    }
  }

  // 3. The same operation, many times, under one parent: N+1.
  const inRepeat = new Set<number>()
  for (const [parentId, kids] of children) {
    const parent = byId.get(parentId)
    if (!parent) continue
    const groups = new Map<string, SpanData[]>()
    for (const kid of kids) {
      if (!kid.async || unawaited.has(kid.id)) continue
      const key = `${kid.kind}\u0000${normalizeName(kid.name)}`
      const group = groups.get(key)
      if (group) group.push(kid)
      else groups.set(key, [kid])
    }
    for (const members of groups.values()) {
      if (members.length < settings.minRepeats) continue
      const first = members[0] as SpanData
      const label = members.every((m) => m.name === first.name)
        ? first.name
        : normalizeName(first.name)
      const sum = members.reduce((acc, m) => acc + m.duration, 0)
      const longest = Math.max(...members.map((m) => m.duration))
      const concurrency = maxConcurrency(members)
      const ids = members.map((m) => m.id)
      if (concurrency <= 1) {
        const savings = round(sum - longest)
        if (savings < minSavings) continue
        for (const id of ids) inRepeat.add(id)
        if (ignore.has('repeated')) continue
        insights.push({
          kind: 'repeated',
          severity: 'warn',
          message:
            `${code(label)} ran ${members.length}× one after another inside ${code(parent.name)} ` +
            `(${formatMs(sum)} total). That's the N+1 pattern: batch it into one call, ` +
            `or run the calls concurrently to save up to ~${formatMs(savings)}.`,
          spanIds: ids,
          savings,
        })
      } else if (members.length >= settings.minRepeats * 2 && !ignore.has('repeated')) {
        const extent = Math.max(...members.map(endOf)) - first.start
        insights.push({
          kind: 'repeated',
          severity: 'info',
          message:
            `${code(label)} ran ${members.length}× inside ${code(parent.name)} ` +
            `(up to ${concurrency} at a time, ${formatMs(extent)}). ` +
            `A batch call would replace ${members.length} round-trips with one.`,
          spanIds: ids,
        })
      }
    }
  }

  // 4. Siblings that ran one after another although they might not need to.
  if (!ignore.has('sequential')) {
    const candidates: Insight[] = []
    for (const [parentId, kids] of children) {
      const parent = byId.get(parentId)
      if (!parent) continue
      // A run is a stretch of async siblings. Synchronous work and N+1 loops in between end it:
      // whatever comes after them most likely depends on them. Floating work is just skipped.
      const runs: SpanData[][] = [[]]
      for (const kid of kids) {
        if (unawaited.has(kid.id) || kid.end === null) continue
        if (!kid.async || inRepeat.has(kid.id)) runs.push([])
        else (runs[runs.length - 1] as SpanData[]).push(kid)
      }
      for (const run of runs) {
        const stages = toStages(run)
        if (stages.length < 2) continue
        const lengths = stages.map((s) => s.end - s.start)
        const sum = lengths.reduce((a, b) => a + b, 0)
        const savings = round(sum - Math.max(...lengths))
        if (savings < minSavings) continue
        candidates.push({
          kind: 'sequential',
          severity: 'info',
          message:
            `${describeStages(stages)} ran one after another inside ${code(parent.name)} ` +
            `(${formatMs(sum)}). If they don't depend on each other, ` +
            `Promise.all could save ~${formatMs(savings)}.`,
          spanIds: stages.flatMap((s) => s.spans.map((span) => span.id)),
          savings,
        })
      }
    }
    candidates.sort((a, b) => (b.savings ?? 0) - (a.savings ?? 0))
    insights.push(...candidates.slice(0, MAX_SEQUENTIAL))
  }

  // 5. Where the time actually went.
  if (!ignore.has('bottleneck')) {
    const bottleneck = findBottleneck(spans, root, kidsOf, settings.bottleneckRatio)
    if (bottleneck) insights.push(bottleneck)
  }

  return insights.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (b.savings ?? 0) - (a.savings ?? 0) ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind],
  )
}

function findBottleneck(
  spans: SpanData[],
  root: SpanData,
  kidsOf: (span: SpanData) => SpanData[],
  ratio: number,
): Insight | undefined {
  const total = root.duration
  if (kidsOf(root).length === 0) {
    return {
      kind: 'bottleneck',
      severity: 'info',
      message:
        `Nothing inside ${code(root.name)} was traced. Wrap steps in span(), ` +
        `or use wrap()/instrument(), to see where the ${formatMs(total)} went.`,
      spanIds: [root.id],
    }
  }
  let best: SpanData | undefined
  for (const span of spans) {
    if (span.critical && (!best || span.selfTime > best.selfTime)) best = span
  }
  if (!best || total <= 0 || best.selfTime < Math.max(ratio * total, 1)) return undefined
  const share = formatPercent(best.selfTime, total)
  const time = formatMs(best.selfTime)
  let message: string
  if (best === root) {
    message =
      `${share} of ${code(root.name)} (${time}) isn't covered by any span. ` +
      `Wrap the slow part in span() to see inside it.`
  } else if (kidsOf(best).length === 0) {
    message = `${code(best.name)} took ${time}, ${share} of the total, on the critical path. Speed this up first.`
  } else {
    message =
      `${code(best.name)} spent ${time} (${share}) in its own code, outside any traced child: ` +
      `CPU work or untraced I/O. Add spans inside it to dig deeper.`
  }
  return { kind: 'bottleneck', severity: 'info', message, spanIds: [best.id] }
}

interface Stage {
  spans: SpanData[]
  start: number
  end: number
}

/** Groups siblings into stages: spans that overlap run "together", stages run one after another. */
function toStages(spans: SpanData[]): Stage[] {
  const stages: Stage[] = []
  for (const span of spans) {
    const last = stages[stages.length - 1]
    if (last && span.start < last.end - EPSILON) {
      last.spans.push(span)
      last.end = Math.max(last.end, endOf(span))
    } else {
      stages.push({ spans: [span], start: span.start, end: endOf(span) })
    }
  }
  return stages
}

function describeStages(stages: Stage[]): string {
  const label = (stage: Stage): string =>
    stage.spans.length === 1
      ? code((stage.spans[0] as SpanData).name)
      : `(${stage.spans.map((s) => code(s.name)).join(' + ')})`
  if (stages.length <= 4) return stages.map(label).join(' → ')
  const first = stages.slice(0, 2).map(label)
  return `${first.join(' → ')} → … → ${label(stages[stages.length - 1] as Stage)} (${stages.length} steps)`
}

/** Length of the union of the children's intervals, clipped to the parent. */
function covered(parent: SpanData, kids: SpanData[]): number {
  const lo = parent.start
  const hi = endOf(parent)
  let total = 0
  let cursor = lo
  for (const kid of kids) {
    const start = Math.max(kid.start, cursor)
    const end = Math.min(endOf(kid), hi)
    if (end > start) {
      total += end - start
      cursor = end
    }
  }
  return total
}

/** The chain of spans that determined the total duration. */
function markCriticalPath(root: SpanData, kidsOf: (span: SpanData) => SpanData[]): void {
  const stack = [root]
  while (stack.length > 0) {
    const span = stack.pop() as SpanData
    span.critical = true
    const kids = kidsOf(span)
      .filter((kid) => kid.end !== null)
      .sort((a, b) => endOf(b) - endOf(a))
    let cursor = endOf(span) + EPSILON
    for (const kid of kids) {
      if (endOf(kid) <= cursor) {
        stack.push(kid)
        cursor = kid.start + EPSILON
      }
    }
  }
}

function maxConcurrency(spans: SpanData[]): number {
  const events: Array<[number, number]> = []
  for (const span of spans) events.push([span.start, 1], [endOf(span), -1])
  // Ends sort before starts at the same instant: back-to-back is not concurrent.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let current = 0
  let max = 0
  for (const [, delta] of events) {
    current += delta
    if (current > max) max = current
  }
  return max
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000
}
