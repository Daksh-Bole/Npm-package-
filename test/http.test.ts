import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { span, trace } from '../src/node'
import { collector, parentOf, sleep } from './helpers'

let server: http.Server
let base: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/destroy')) return req.socket.destroy()
    const delay = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('delay') ?? 0)
    setTimeout(() => {
      res.statusCode = req.url?.startsWith('/missing') ? 404 : 200
      res.end('ok')
    }, delay)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

const host = () => base.replace('http://', '')

describe('automatic HTTP capture', () => {
  it('records fetch() requests with method, host, path and status under the current span', async () => {
    const c = collector()
    await trace(
      'root',
      async () => {
        await span('load', async () => {
          const res = await fetch(`${base}/users/42?token=secret&delay=5`)
          await res.text()
        })
      },
      c.options,
    )
    const request = c.last().spans.find((s) => s.kind === 'http')
    expect(request).toMatchObject({
      name: `GET ${host()}/users/42`,
      status: 'ok',
      async: true,
      attrs: { status: 200 },
    })
    expect(request?.duration).toBeGreaterThanOrEqual(4)
    expect(parentOf(c.last(), request?.name as string)).toBe('load')
    expect(JSON.stringify(c.last())).not.toContain('secret')
  })

  it('records node:http requests until the body has been received', async () => {
    const c = collector()
    await trace(
      'root',
      () =>
        new Promise<void>((resolve, reject) => {
          const req = http.request(`${base}/missing?delay=5`, { method: 'POST' }, (res) => {
            res.resume()
            res.on('end', resolve)
          })
          req.on('error', reject)
          req.end()
        }),
      c.options,
    )
    expect(c.last().spans.find((s) => s.kind === 'http')).toMatchObject({
      name: `POST ${host()}/missing`,
      status: 'ok',
      attrs: { status: 404 },
    })
  })

  it('marks failed requests as errors', async () => {
    const c = collector()
    await trace(
      'root',
      async () => {
        await fetch(`${base}/destroy`).catch(() => undefined)
        await new Promise<void>((resolve) => {
          http.get(`${base}/destroy`).on('error', () => resolve())
        })
      },
      c.options,
    )
    const requests = c.last().spans.filter((s) => s.kind === 'http')
    expect(requests).toHaveLength(2)
    for (const request of requests) expect(request.status).toBe('error')
    expect(c.last().status).toBe('ok')
  })

  it('flags requests that were never awaited', async () => {
    const c = collector()
    await trace(
      'root',
      () => {
        void fetch(`${base}/slow?delay=50`).then((r) => r.text())
      },
      c.options,
    )
    await sleep(80)
    expect(c.last().insights.find((i) => i.kind === 'unawaited')?.message).toContain(
      'was still in flight',
    )
  })

  it('can be turned off and ignores requests outside traces', async () => {
    const c = collector()
    await trace('off', () => fetch(`${base}/x`).then((r) => r.text()), {
      ...c.options,
      http: false,
    })
    expect(c.last().spans).toHaveLength(1)
    await fetch(`${base}/outside`).then((r) => r.text()) // must not throw or record anything
    expect(c.reports).toHaveLength(1)
  })
})
