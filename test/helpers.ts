import { vi } from 'vitest'
import { analyze } from '../src/analyze'
import type { SpanData, SpanKind, SpanStatus, TraceReport } from '../src/types'

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Runs `fn` with fake timers (including performance.now) so durations are exact. */
export async function withFakeTime<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'performance', 'Date'],
  })
  try {
    const pending = fn()
    // Drive timers until the work settles.
    let settled = false
    pending.then(
      () => (settled = true),
      () => (settled = true),
    )
    for (let i = 0; i < 10_000 && !settled; i++) await vi.advanceTimersByTimeAsync(1)
    return await pending
  } finally {
    vi.useRealTimers()
  }
}

export interface Spec {
  name: string
  start: number
  /** `null` = still running when the trace ended. */
  end: number | null
  kind?: SpanKind
  async?: boolean
  status?: SpanStatus
  error?: string
  attrs?: SpanData['attrs']
  children?: Spec[]
}

/** Builds analyzed spans from a compact tree description (times in ms). */
export function spansFrom(spec: Spec, options: Parameters<typeof analyze>[1] = {}) {
  const spans: SpanData[] = []
  const traceEnd = spec.end ?? 0
  let nextId = 0
  const visit = (node: Spec, parentId: number | null): void => {
    const id = nextId++
    const end = node.end
    spans.push({
      id,
      parentId,
      name: node.name,
      kind: node.kind ?? (parentId === null ? 'trace' : 'span'),
      start: node.start,
      end,
      duration: (end ?? traceEnd) - node.start,
      selfTime: 0,
      status: node.status ?? (end === null ? 'running' : 'ok'),
      async: node.async ?? true,
      ...(node.error ? { error: node.error } : {}),
      attrs: node.attrs ?? {},
      depth: 0,
      critical: false,
    })
    for (const child of node.children ?? []) visit(child, id)
  }
  visit(spec, null)
  spans.sort((a, b) => a.start - b.start || a.id - b.id)
  const insights = analyze(spans, options)
  return {
    spans,
    insights,
    byName: (name: string) => spans.find((s) => s.name === name) as SpanData,
  }
}

export function reportFrom(spec: Spec, options: Parameters<typeof analyze>[1] = {}): TraceReport {
  const { spans, insights } = spansFrom(spec, options)
  const root = spans[0] as SpanData
  return {
    name: root.name,
    startedAt: 1_700_000_000_000,
    duration: root.duration,
    status: root.status === 'error' ? 'error' : 'ok',
    spans,
    insights,
    dropped: 0,
  }
}

/** Collects reports instead of printing them. */
export function collector() {
  const reports: TraceReport[] = []
  const printed: string[] = []
  return {
    reports,
    printed,
    options: {
      onEnd: (report: TraceReport) => reports.push(report),
      write: (text: string) => printed.push(text),
    },
    last: (): TraceReport => {
      const report = reports[reports.length - 1]
      if (!report) throw new Error('no report collected')
      return report
    },
  }
}

export const names = (report: TraceReport): string[] => report.spans.map((s) => s.name)
export const parentOf = (report: TraceReport, name: string): string | undefined => {
  const span = report.spans.find((s) => s.name === name)
  return report.spans.find((s) => s.id === span?.parentId)?.name
}
