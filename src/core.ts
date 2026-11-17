import { installHttpCapture } from './http'
import { getPlatform } from './platform'
import {
  closeSpan,
  createTraceState,
  currentRecord,
  isPromiseLike,
  openSpan,
  runInContext,
} from './recorder'
import type { ResolvedOptions, SpanRecord } from './recorder'
import { render } from './render'
import { buildReport } from './report'
import type { ActiveTrace, AttrValue, Span, TraceOptions, TraceReport } from './types'

/** Global defaults set with `configure()`. */
export interface Config extends TraceOptions {
  /**
   * Turn tracing on or off globally. When off, `trace()`, `span()` and `middleware()` just call
   * through. Default: on, unless the `AWAITFALL` environment variable is `0`, `false` or `off`.
   */
  enabled?: boolean
}

let config: Config = {}

/**
 * Sets global defaults for every trace (for example in a test setup file or at app startup).
 * Replaces any previous configuration; per-call options still win.
 */
export function configure(options: Config = {}): void {
  if (options === null || typeof options !== 'object') {
    throw new TypeError(
      `[awaitfall] configure() expects an options object, got ${describe(options)}`,
    )
  }
  config = { ...options }
}

function isEnabled(): boolean {
  if (config.enabled !== undefined) return config.enabled
  const flag = getPlatform().env('AWAITFALL')?.trim().toLowerCase()
  return !(flag === '0' || flag === 'false' || flag === 'off')
}

function resolveOptions(options: TraceOptions | undefined, profiling: boolean): ResolvedOptions {
  const merged: TraceOptions = { ...config, ...options }
  const platform = getPlatform()
  const customWrite = typeof merged.write === 'function'
  return {
    ...merged,
    print: merged.print ?? !profiling,
    threshold: Math.max(0, merged.threshold ?? 0),
    write: customWrite ? (merged.write as (text: string) => void) : (text) => platform.write(text),
    customWrite,
    onEnd: merged.onEnd,
    http: merged.http ?? true,
    insights:
      merged.insights === false ? false : merged.insights === true ? {} : (merged.insights ?? {}),
    maxSpans: Math.max(1, Math.floor(merged.maxSpans ?? 10_000)),
  }
}

// ---------------------------------------------------------------------------------------------
// Span handles

class SpanHandle implements Span {
  constructor(readonly record: SpanRecord) {}

  get name(): string {
    return this.record.name
  }

  span<T>(name: string, fn: (span: Span) => T): T {
    const [label, body] = parseSpanArgs<T>('span.span', name, fn)
    return runChild(this.record, label, body)
  }

  set(key: string, value: AttrValue): this {
    this.record.attrs[String(key)] = value
    return this
  }
}

/** Stand-in handle used when nothing is being recorded: calls straight through. */
function noopSpan(name: string): Span {
  return {
    name,
    span<T>(childName: string, fn: (span: Span) => T): T {
      const [label, body] = parseSpanArgs<T>('span.span', childName, fn)
      return body(noopSpan(label))
    },
    set() {
      return this
    },
  }
}

function runChild<T>(parent: SpanRecord, name: string, fn: (span: Span) => T): T {
  const record = openSpan(parent, name, 'span')
  if (!record) return fn(noopSpan(name))
  return execute(record, fn)
}

/** Runs `fn` as `record`, ending the span when `fn` returns, throws, settles or rejects. */
export function execute<T>(
  record: SpanRecord,
  fn: (span: Span) => T,
  options: { discardSync?: boolean } = {},
): T {
  let result: T
  try {
    result = runInContext(record, () => fn(new SpanHandle(record)))
  } catch (error) {
    closeSpan(record, true, error)
    throw error
  }
  if (isPromiseLike(result)) {
    record.async = true
    return settle(result, (failed, error) => closeSpan(record, failed, error)) as T
  }
  if (options.discardSync) record.discarded = true
  closeSpan(record)
  return result
}

function settle<V>(
  thenable: PromiseLike<V>,
  done: (failed: boolean, error?: unknown) => void,
): Promise<V> {
  return new Promise<V>((resolve, reject) => {
    thenable.then(
      (value) => {
        done(false)
        resolve(value)
      },
      (error: unknown) => {
        done(true, error)
        reject(error)
      },
    )
  })
}

/**
 * Times `fn` as a step of the current trace. Outside a trace it simply calls `fn`, so it is safe
 * to leave in production code. Returns whatever `fn` returns.
 *
 * @example
 * const user = await span('loadUser', () => db.users.find(id))
 */
export function span<T>(name: string, fn: (span: Span) => T): T
export function span<T>(fn: (span: Span) => T): T
export function span<T>(nameOrFn: string | ((span: Span) => T), maybeFn?: (span: Span) => T): T {
  const [name, fn] = parseSpanArgs<T>('span', nameOrFn, maybeFn)
  const parent = currentRecord()
  return parent ? runChild(parent, name, fn) : fn(noopSpan(name))
}

// ---------------------------------------------------------------------------------------------
// Traces

class RootTrace extends SpanHandle implements ActiveTrace {
  run<R>(fn: () => R): R {
    if (typeof fn !== 'function') {
      throw new TypeError(`[awaitfall] run() expects a function, got ${describe(fn)}`)
    }
    return runInContext(this.record, fn)
  }

  end(error?: unknown): TraceReport | undefined {
    return this.finish(error !== undefined, error)
  }

  finish(failed: boolean, error?: unknown): TraceReport {
    const state = this.record.trace
    if (state.done && state.report) return state.report
    closeSpan(this.record, failed, error)
    state.done = true
    const report = buildReport(state)
    state.report = report
    deliver(report, state.options)
    return report
  }
}

/** `trace()` called inside another trace: just a child span of the outer one. */
class NestedTrace extends SpanHandle implements ActiveTrace {
  run<R>(fn: () => R): R {
    return runInContext(this.record, fn)
  }

  end(error?: unknown): undefined {
    this.finish(error !== undefined, error)
    return undefined
  }

  finish(failed: boolean, error?: unknown): undefined {
    closeSpan(this.record, failed, error)
    return undefined
  }
}

function noopTrace(name: string): Finishable {
  return {
    name,
    span: <T>(childName: string, fn: (span: Span) => T): T => noopSpan(name).span(childName, fn),
    set() {
      return this
    },
    run: (fn) => fn(),
    end: () => undefined,
    finish: () => undefined,
  }
}

type Finishable = ActiveTrace & {
  finish(failed: boolean, error?: unknown): TraceReport | undefined
}

function startTrace(
  name: string,
  options: TraceOptions | undefined,
  profiling: boolean,
): Finishable {
  if (!profiling) {
    const parent = currentRecord()
    if (parent) {
      const record = openSpan(parent, name, 'span')
      return record ? new NestedTrace(record) : noopTrace(name)
    }
    if (!isEnabled()) return noopTrace(name)
  }
  const resolved = resolveOptions(options, profiling)
  if (resolved.http) installHttpCapture(getPlatform().diagnostics)
  return new RootTrace(createTraceState(name, resolved))
}

function deliver(report: TraceReport, options: ResolvedOptions): void {
  if (options.onEnd) {
    try {
      options.onEnd(report)
    } catch (error) {
      warn('onEnd threw', error)
    }
  }
  if (!options.print || report.duration < options.threshold) return
  try {
    const color = options.color ?? (options.customWrite ? false : getPlatform().color())
    options.write(render(report, { ...options, color }))
  } catch (error) {
    warn('could not print the trace', error)
  }
}

function warn(what: string, error: unknown): void {
  try {
    getPlatform().write(
      `[awaitfall] ${what}: ${error instanceof Error ? error.message : String(error)}`,
    )
  } catch {
    // Nothing else we can do.
  }
}

/** Runs `fn` inside `active`, then ends it however `fn` finishes. */
function runTrace<T>(active: Finishable, fn: (span: Span) => T): T {
  let result: T
  try {
    result = active.run(() => fn(active))
  } catch (error) {
    active.finish(true, error)
    throw error
  }
  if (isPromiseLike(result)) {
    if (active instanceof SpanHandle) active.record.async = true
    return settle(result, (failed, error) => active.finish(failed, error)) as T
  }
  active.finish(false)
  return result
}

export interface TraceFunction {
  /**
   * Records everything `fn` does (spans, HTTP requests) and prints a waterfall with insights when
   * it finishes. Returns whatever `fn` returns, and rethrows whatever it throws. Inside another
   * trace it behaves like `span()`.
   *
   * @example
   * await trace('checkout', async () => {
   *   const user = await span('loadUser', () => getUser(id))
   *   await span('charge', () => charge(user))
   * })
   */
  <T>(name: string, fn: (span: Span) => T, options?: TraceOptions): T
  <T>(fn: (span: Span) => T, options?: TraceOptions): T
  /**
   * Starts a trace you end yourself, for hook-based frameworks where one callback can't wrap the
   * whole operation. Use `run()` to execute code inside it and `end()` to finish and print it.
   */
  start(name: string, options?: TraceOptions): ActiveTrace
}

function traceImpl<T>(
  nameOrFn: string | ((span: Span) => T),
  fnOrOptions?: ((span: Span) => T) | TraceOptions,
  maybeOptions?: TraceOptions,
): T {
  const { name, fn, options } = parseTraceArgs<T>('trace', nameOrFn, fnOrOptions, maybeOptions)
  return runTrace(startTrace(name, options, false), fn)
}

export const trace: TraceFunction = Object.assign(traceImpl, {
  start(name: string, options?: TraceOptions): ActiveTrace {
    if (typeof name !== 'string') {
      throw new TypeError(
        `[awaitfall] trace.start(name) expects a string name, got ${describe(name)}`,
      )
    }
    checkOptions('trace.start', options)
    return startTrace(name || 'trace', options, false)
  },
})

/** What `profile()` returns. */
export interface Profile<T> {
  result: T
  report: TraceReport
}

/**
 * Like `trace()`, but returns the report instead of printing it, and always records (even when
 * tracing is disabled or another trace is active). Made for tests and scripts.
 *
 * @example
 * const { report } = await profile('GET /cart', () => handler(req))
 * expect(report.insights.filter((i) => i.kind === 'repeated')).toEqual([])
 */
export function profile<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: TraceOptions,
): Promise<Profile<T>>
export function profile<T>(name: string, fn: (span: Span) => T, options?: TraceOptions): Profile<T>
export function profile<T>(
  fn: (span: Span) => Promise<T>,
  options?: TraceOptions,
): Promise<Profile<T>>
export function profile<T>(fn: (span: Span) => T, options?: TraceOptions): Profile<T>
export function profile<T>(
  nameOrFn: string | ((span: Span) => T),
  fnOrOptions?: ((span: Span) => T) | TraceOptions,
  maybeOptions?: TraceOptions,
): Profile<unknown> | Promise<Profile<unknown>> {
  const { name, fn, options } = parseTraceArgs<T>('profile', nameOrFn, fnOrOptions, maybeOptions)
  const active = startTrace(name, options, true) as RootTrace
  const result: unknown = runTrace(active, fn)
  const reportOf = (): TraceReport => active.record.trace.report as TraceReport
  if (isPromiseLike(result)) {
    return Promise.resolve(result).then((value) => ({ result: value, report: reportOf() }))
  }
  return { result, report: reportOf() }
}

// ---------------------------------------------------------------------------------------------
// Argument parsing with helpful errors

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'an array'
  if (isPromiseLike(value)) return 'a promise'
  if (typeof value === 'object') return 'an object'
  if (typeof value === 'function') return 'a function'
  return `${typeof value} ${JSON.stringify(value)}`
}

function parseSpanArgs<T>(
  api: string,
  nameOrFn: unknown,
  maybeFn: unknown,
): [string, (span: Span) => T] {
  if (typeof nameOrFn === 'function') {
    return [nameOrFn.name || 'anonymous', nameOrFn as (span: Span) => T]
  }
  if (typeof nameOrFn !== 'string') {
    throw new TypeError(
      `[awaitfall] ${api}(name, fn) expects a string name, got ${describe(nameOrFn)}`,
    )
  }
  if (typeof maybeFn !== 'function') {
    throw new TypeError(
      `[awaitfall] ${api}(name, fn) expects a function as the second argument, got ${describe(maybeFn)}. ` +
        `Did you mean ${api}('${nameOrFn}', () => yourCall())?`,
    )
  }
  return [nameOrFn || 'anonymous', maybeFn as (span: Span) => T]
}

function checkOptions(api: string, options: unknown): void {
  if (
    options !== undefined &&
    (options === null || typeof options !== 'object' || Array.isArray(options))
  ) {
    throw new TypeError(`[awaitfall] ${api}() options must be an object, got ${describe(options)}`)
  }
}

function parseTraceArgs<T>(
  api: string,
  nameOrFn: unknown,
  fnOrOptions: unknown,
  maybeOptions: unknown,
): { name: string; fn: (span: Span) => T; options: TraceOptions | undefined } {
  if (typeof nameOrFn === 'function') {
    checkOptions(api, fnOrOptions)
    return {
      name: nameOrFn.name || api,
      fn: nameOrFn as (span: Span) => T,
      options: fnOrOptions as TraceOptions | undefined,
    }
  }
  const [name, fn] = parseSpanArgs<T>(api, nameOrFn, fnOrOptions)
  checkOptions(api, maybeOptions)
  return { name, fn, options: maybeOptions as TraceOptions | undefined }
}
