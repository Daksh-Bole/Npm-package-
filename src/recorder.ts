import type { ContextBackend } from './platform'
import { getPlatform } from './platform'
import type { AttrValue, InsightOptions, RenderOptions, SpanKind, TraceReport } from './types'

/** Options after defaults have been applied. */
export interface ResolvedOptions extends RenderOptions {
  print: boolean
  threshold: number
  write: (text: string) => void
  customWrite: boolean
  onEnd: ((report: TraceReport) => void) | undefined
  http: boolean
  insights: InsightOptions | false
  maxSpans: number
}

export interface TraceState {
  name: string
  /** `performance.now()` at the start. */
  t0: number
  startedAt: number
  records: SpanRecord[]
  nextId: number
  done: boolean
  dropped: number
  options: ResolvedOptions
  report: TraceReport | undefined
}

export interface SpanRecord {
  id: number
  parent: SpanRecord | null
  name: string
  kind: SpanKind
  start: number
  end: number | undefined
  failed: boolean
  error: unknown
  /** Whether the traced function returned a promise (only async work can be parallelized). */
  async: boolean
  attrs: Record<string, AttrValue>
  /** Dropped from the report (e.g. synchronous calls under `instrument()`); children get re-parented. */
  discarded: boolean
  trace: TraceState
}

export const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now()

let context: ContextBackend<SpanRecord> | undefined | null = null

function getContext(): ContextBackend<SpanRecord> | undefined {
  if (context === null) context = getPlatform().createContext<SpanRecord>()
  return context
}

/** The span that implicitly owns the currently running code, if any trace is active. */
export function currentRecord(): SpanRecord | undefined {
  const record = getContext()?.getStore()
  return record && !record.trace.done ? record : undefined
}

export function runInContext<T>(record: SpanRecord, fn: () => T): T {
  const ctx = getContext()
  return ctx ? ctx.run(record, fn) : fn()
}

export function createTraceState(name: string, options: ResolvedOptions): SpanRecord {
  const state: TraceState = {
    name,
    t0: now(),
    startedAt: Date.now(),
    records: [],
    nextId: 1,
    done: false,
    dropped: 0,
    options,
    report: undefined,
  }
  const root: SpanRecord = {
    id: 0,
    parent: null,
    name,
    kind: 'trace',
    start: state.t0,
    end: undefined,
    failed: false,
    error: undefined,
    async: false,
    attrs: {},
    discarded: false,
    trace: state,
  }
  state.records.push(root)
  return root
}

/** Starts a child span, or returns `undefined` if the trace is over or full. */
export function openSpan(parent: SpanRecord, name: string, kind: SpanKind): SpanRecord | undefined {
  const state = parent.trace
  if (state.done) return undefined
  if (state.records.length >= state.options.maxSpans) {
    state.dropped++
    return undefined
  }
  const record: SpanRecord = {
    id: state.nextId++,
    parent,
    name,
    kind,
    start: now(),
    end: undefined,
    failed: false,
    error: undefined,
    async: false,
    attrs: {},
    discarded: false,
    trace: state,
  }
  state.records.push(record)
  return record
}

export function closeSpan(record: SpanRecord, failed = false, error?: unknown): void {
  if (record.end !== undefined) return
  record.end = now()
  if (failed) {
    record.failed = true
    record.error = error
  }
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
