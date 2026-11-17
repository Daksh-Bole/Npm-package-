import type { SpanData, TraceReport } from './types'

/** One event in the Chrome Trace Event Format. */
export interface ChromeTraceEvent {
  name: string
  ph: 'X' | 'M'
  pid: number
  tid: number
  ts?: number
  dur?: number
  cat?: string
  args?: Record<string, unknown>
}

/** A JSON document you can open in https://ui.perfetto.dev, chrome://tracing or speedscope. */
export interface ChromeTrace {
  traceEvents: ChromeTraceEvent[]
  displayTimeUnit: 'ms'
}

/**
 * Converts a report to the Chrome Trace Event Format, for when the terminal isn't enough.
 *
 * Spans that overlap without nesting (concurrent work) are spread over separate lanes, because
 * trace viewers require events on one thread to nest properly.
 */
export function toChromeTrace(report: TraceReport): ChromeTrace {
  const pid = 1
  const events: ChromeTraceEvent[] = [
    { name: 'process_name', ph: 'M', pid, tid: 0, args: { name: `awaitfall: ${report.name}` } },
  ]
  const lanes: number[][] = []
  const laneOf = new Map<number, number>()
  const endOf = (s: SpanData): number => s.start + s.duration
  const startUs = report.startedAt * 1000
  const ordered = [...report.spans].sort(
    (a, b) => a.start - b.start || b.duration - a.duration || a.id - b.id,
  )

  for (const span of ordered) {
    const fits = (lane: number[]): boolean => {
      // `lane` is a stack of end times of the spans currently open on that lane.
      while (lane.length > 0 && (lane[lane.length - 1] as number) <= span.start) lane.pop()
      return lane.length === 0 || endOf(span) <= (lane[lane.length - 1] as number)
    }
    const preferred = span.parentId === null ? undefined : laneOf.get(span.parentId)
    let lane = preferred !== undefined && fits(lanes[preferred] as number[]) ? preferred : -1
    if (lane < 0) lane = lanes.findIndex(fits)
    if (lane < 0) {
      lanes.push([])
      lane = lanes.length - 1
    }
    ;(lanes[lane] as number[]).push(endOf(span))
    laneOf.set(span.id, lane)

    const args: Record<string, unknown> = { ...span.attrs, status: span.status }
    if (span.error) args.error = span.error
    if (span.status === 'running') args.note = 'still running when the trace ended'
    events.push({
      name: span.name,
      cat: span.kind,
      ph: 'X',
      pid,
      tid: lane + 1,
      ts: Math.round(startUs + span.start * 1000),
      dur: Math.max(1, Math.round(span.duration * 1000)),
      args,
    })
  }
  for (let i = 0; i < lanes.length; i++) {
    events.push({ name: 'thread_name', ph: 'M', pid, tid: i + 1, args: { name: `lane ${i + 1}` } })
  }
  return { traceEvents: events, displayTimeUnit: 'ms' }
}
