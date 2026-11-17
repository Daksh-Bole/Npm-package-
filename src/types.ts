/** A value that can be attached to a span with `span.set(key, value)`. */
export type AttrValue = string | number | boolean

/** `trace` is the root, `span` is anything you instrumented, `http` is captured automatically. */
export type SpanKind = 'trace' | 'span' | 'http'

/** `running` means the span had not finished when its trace ended (often a missing `await`). */
export type SpanStatus = 'ok' | 'error' | 'running'

/** One timed operation inside a finished trace. All times are milliseconds. */
export interface SpanData {
  id: number
  /** `null` for the root span. */
  parentId: number | null
  name: string
  kind: SpanKind
  /** Start time, relative to the start of the trace. */
  start: number
  /** End time, relative to the start of the trace. `null` if still running when the trace ended. */
  end: number | null
  /** Wall-clock duration. For running spans: time from start until the trace ended. */
  duration: number
  /** Time not covered by any child span: the span's own code, or work nobody traced. */
  selfTime: number
  status: SpanStatus
  /** Whether the operation was asynchronous (returned a promise). Only async work can be parallelized. */
  async: boolean
  /** `Name: message` of the thrown error, when `status` is `error`. */
  error?: string
  attrs: Record<string, AttrValue>
  /** 0 for the root. */
  depth: number
  /** Whether this span is on the critical path, the chain of work that determined the total time. */
  critical: boolean
}

/**
 * - `sequential`: independent-looking siblings ran one after another (missed `Promise.all`?).
 * - `repeated`: the same operation ran many times under one parent (N+1 / loop of awaits).
 * - `unawaited`: work was still running after its parent finished (missing `await`?).
 * - `bottleneck`: the single biggest contributor on the critical path.
 * - `error`: a span threw.
 */
export type InsightKind = 'sequential' | 'repeated' | 'unawaited' | 'bottleneck' | 'error'

/** A finding about a trace, with the spans it refers to. */
export interface Insight {
  kind: InsightKind
  severity: 'warn' | 'info'
  /** Human-readable explanation. Span names are wrapped in backticks. */
  message: string
  /** Spans this insight is about, in start order. */
  spanIds: number[]
  /** Estimated milliseconds that could be saved, when it can be estimated. */
  savings?: number
}

/** Everything awaitfall knows about one finished trace. Plain data: safe to `JSON.stringify`. */
export interface TraceReport {
  name: string
  /** `Date.now()` when the trace started. */
  startedAt: number
  /** Total wall-clock duration in milliseconds. */
  duration: number
  status: 'ok' | 'error'
  /** All spans in start order. `spans[0]` is the root. */
  spans: SpanData[]
  insights: Insight[]
  /** Spans that were not recorded because `maxSpans` was reached. */
  dropped: number
}

/** Tuning for the automatic insights. */
export interface InsightOptions {
  /** How many times the same operation must repeat sequentially to be reported as N+1. Default `5`. */
  minRepeats?: number
  /** Minimum estimated savings (ms) before a parallelization hint is shown. Default `5`. */
  minSavings?: number
  /** Share of the total time a span's self time must reach to be called a bottleneck. Default `0.25`. */
  bottleneckRatio?: number
  /** Insight kinds to turn off. */
  ignore?: InsightKind[]
}

/** Options for how a report is rendered as text. */
export interface RenderOptions {
  /** Use ANSI colors. Default: auto-detected from the output stream, `NO_COLOR` and `FORCE_COLOR`. */
  color?: boolean
  /** Total width in columns. Default: terminal width (min 60, max 200), or 100. */
  width?: number
  /** Maximum number of span rows to print. Default `100`. */
  maxRows?: number
  /** Maximum number of insights to print. Default `5`. */
  maxInsights?: number
  /** Collapse runs of more than this many identical sibling spans into one row. Default `3`. */
  fold?: number
}

/** Options accepted by `trace()`, `trace.start()`, `profile()`, `middleware()` and `configure()`. */
export interface TraceOptions extends RenderOptions {
  /** Print the waterfall when the trace ends. Default `true` (`false` for `profile()`). */
  print?: boolean
  /** Only print traces that took at least this many milliseconds. Default `0`. */
  threshold?: number
  /** Where printed output goes. Default: `process.stderr` in Node.js, `console.log` elsewhere. */
  write?: (text: string) => void
  /** Called with the report of every finished trace, whether or not it is printed. */
  onEnd?: (report: TraceReport) => void
  /** Record outgoing HTTP requests (fetch, undici, node:http, and libraries built on them). Node.js only. Default `true`. */
  http?: boolean
  /** `false` turns insights off; an object tunes them. Default `true`. */
  insights?: boolean | InsightOptions
  /** Stop recording new spans after this many, to bound memory. Default `10000`. */
  maxSpans?: number
}

/** A handle to a running span. Passed to every function you trace. */
export interface Span {
  /** The span's name. */
  readonly name: string
  /**
   * Run `fn` as a child of this span. Unlike the global `span()`, this works in every runtime,
   * including browsers, because the parent is explicit.
   */
  span<T>(name: string, fn: (span: Span) => T): T
  /** Attach a key/value pair to this span. It appears in `report.spans[i].attrs` and in exports. */
  set(key: string, value: AttrValue): this
}

/** A trace started with `trace.start()`: you decide when it ends. */
export interface ActiveTrace extends Span {
  /** Run `fn` inside this trace, so `span()` calls and HTTP requests made by it are recorded. */
  run<T>(fn: () => T): T
  /**
   * Finish the trace, print it (unless disabled) and return its report. Safe to call more than once.
   * Returns `undefined` when tracing is disabled or this trace was nested inside another one.
   */
  end(error?: unknown): TraceReport | undefined
}
