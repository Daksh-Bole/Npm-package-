import type { DiagnosticsChannelLike } from './platform'
import { closeSpan, currentRecord, openSpan } from './recorder'
import type { SpanRecord } from './recorder'

/**
 * Records outgoing HTTP requests as spans by listening to Node's built-in diagnostics channels.
 * Nothing is monkey-patched: `fetch`/undici and `node:http(s)` publish these events themselves, so
 * libraries built on them (axios, got, node-fetch, ky, ...) are captured too. Requests made outside
 * an active trace are ignored at the cost of one AsyncLocalStorage lookup.
 */
let installed = false

export function installHttpCapture(dc: DiagnosticsChannelLike | undefined): void {
  if (installed || !dc) return
  installed = true
  const inFlight = new WeakMap<object, SpanRecord>()

  const subscribe = (name: string, handler: (message: any) => void): void => {
    const safe = (message: unknown): void => {
      try {
        handler(message)
      } catch {
        // Never let instrumentation break the request it observes.
      }
    }
    try {
      if (typeof dc.subscribe === 'function') dc.subscribe(name, safe)
      else dc.channel(name).subscribe(safe)
    } catch {
      // Channel not supported by this runtime.
    }
  }

  const begin = (request: object, method: unknown, target: string): void => {
    const parent = currentRecord()
    if (!parent || !parent.trace.options.http) return
    const record = openSpan(parent, `${String(method ?? 'GET').toUpperCase()} ${target}`, 'http')
    if (!record) return
    record.async = true
    inFlight.set(request, record)
  }
  const setStatus = (request: object, status: unknown): void => {
    const record = inFlight.get(request)
    if (record && typeof status === 'number') record.attrs.status = status
  }
  const finish = (request: object, failed: boolean, error?: unknown): void => {
    const record = inFlight.get(request)
    if (!record) return
    inFlight.delete(request)
    closeSpan(record, failed, error)
  }

  // fetch() and undici
  subscribe('undici:request:create', ({ request }) => {
    begin(request, request.method, joinTarget(originHost(request.origin), request.path))
  })
  subscribe('undici:request:headers', ({ request, response }) => {
    setStatus(request, response?.statusCode)
  })
  subscribe('undici:request:trailers', ({ request }) => finish(request, false))
  subscribe('undici:request:error', ({ request, error }) => finish(request, true, error))

  // node:http and node:https clients
  subscribe('http.client.request.start', ({ request }) => {
    const hostHeader =
      typeof request.getHeader === 'function' ? request.getHeader('host') : undefined
    const host = typeof hostHeader === 'string' ? hostHeader : String(request.host ?? '')
    begin(request, request.method, joinTarget(host, request.path))
  })
  subscribe('http.client.response.finish', ({ request, response }) => {
    setStatus(request, response?.statusCode)
    if (!inFlight.has(request) || typeof response?.once !== 'function') {
      finish(request, false)
      return
    }
    // This event fires when headers arrive; the span ends when the body has been received.
    // Only 'end'/'close' are observed: adding an 'error' listener would change crash behavior.
    const done = (): void => finish(request, false)
    response.once('end', done)
    response.once('close', done)
  })
  subscribe('http.client.request.error', ({ request, error }) => finish(request, true, error))
}

function originHost(origin: unknown): string {
  const text = String(origin ?? '')
  try {
    return new URL(text).host
  } catch {
    return text.replace(/^[a-z]+:\/\//i, '')
  }
}

/** `host` + path without the query string (which often carries tokens). */
function joinTarget(host: string, path: unknown): string {
  const raw = typeof path === 'string' ? path : '/'
  const cut = raw.search(/[?#]/)
  const clean = cut >= 0 ? raw.slice(0, cut) : raw
  return `${host}${clean.startsWith('/') ? clean : `/${clean}`}`
}
