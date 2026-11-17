import { trace } from './core'
import type { TraceOptions } from './types'

/** The parts of a Node/Express request the middleware reads. */
export interface RequestLike {
  method?: string
  url?: string
  originalUrl?: string
}

/** The parts of a Node/Express response the middleware reads. */
export interface ResponseLike {
  statusCode: number
  once(event: 'finish' | 'close', listener: () => void): unknown
}

export interface MiddlewareOptions extends TraceOptions {
  /** Name of each trace. Default: `METHOD /path` (query string removed). */
  name?: (req: RequestLike) => string
}

/**
 * Connect/Express middleware: traces every request and prints its waterfall when the response
 * finishes. Combine with `threshold` to only see slow requests.
 *
 * @example
 * app.use(middleware({ threshold: 200 }))
 */
export function middleware(options: MiddlewareOptions = {}) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('[awaitfall] middleware(options) expects an options object')
  }
  const { name: nameOf, ...traceOptions } = options
  return function awaitfall(
    req: RequestLike,
    res: ResponseLike,
    next: (error?: unknown) => void,
  ): void {
    const url = (req.originalUrl ?? req.url ?? '/').split('?')[0] as string
    const active = trace.start(nameOf ? nameOf(req) : `${req.method ?? 'GET'} ${url}`, traceOptions)
    let ended = false
    const end = (): void => {
      if (ended) return
      ended = true
      active.set('status', res.statusCode)
      active.end(res.statusCode >= 500 ? new Error(`HTTP ${res.statusCode}`) : undefined)
    }
    res.once('finish', end)
    res.once('close', end)
    active.run(() => next())
  }
}
