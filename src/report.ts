import { analyze } from './analyze'
import { formatError } from './format'
import type { SpanRecord, TraceState } from './recorder'
import type { SpanData, TraceReport } from './types'

const round = (ms: number): number => Math.round(ms * 1000) / 1000

/** Turns the internal records of a finished trace into a plain, JSON-safe report. */
export function buildReport(state: TraceState): TraceReport {
  const root = state.records[0] as SpanRecord
  const traceEnd = root.end ?? root.start
  const nearestKept = (record: SpanRecord): SpanRecord | null => {
    let parent = record.parent
    while (parent && parent.discarded) parent = parent.parent
    return parent
  }

  const spans: SpanData[] = []
  for (const record of state.records) {
    if (record.discarded) continue
    const running = record.end === undefined
    const end = record.end ?? traceEnd
    const span: SpanData = {
      id: record.id,
      parentId: nearestKept(record)?.id ?? null,
      name: record.name,
      kind: record.kind,
      start: round(record.start - state.t0),
      end: running ? null : round(end - state.t0),
      duration: round(Math.max(0, end - record.start)),
      selfTime: 0,
      status: running ? 'running' : record.failed ? 'error' : 'ok',
      async: record.async,
      attrs: { ...record.attrs },
      depth: 0,
      critical: false,
    }
    if (record.failed) span.error = formatError(record.error)
    spans.push(span)
  }
  spans.sort((a, b) => a.start - b.start || a.id - b.id)

  const insights = analyze(spans, state.options.insights)
  const rootSpan = spans[0] as SpanData
  return {
    name: state.name,
    startedAt: state.startedAt,
    duration: rootSpan.duration,
    status: rootSpan.status === 'error' ? 'error' : 'ok',
    spans,
    insights,
    dropped: state.dropped,
  }
}
