import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { middleware, span } from '../src/node'
import type { TraceReport } from '../src/node'
import { names, sleep } from './helpers'

const servers: http.Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    server.close()
  }
})

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function waitForReports(reports: TraceReport[], count: number): Promise<void> {
  return (async () => {
    for (let i = 0; i < 200 && reports.length < count; i++) await sleep(5)
  })()
}

describe('middleware()', () => {
  it('traces Express requests, including spans and outgoing HTTP made by handlers', async () => {
    const reports: TraceReport[] = []
    const upstream = await listen((_req, res) => setTimeout(() => res.end('{}'), 5))
    const app = express()
    app.use(middleware({ print: false, onEnd: (r) => reports.push(r) }))
    app.get('/users/:id', async (_req, res) => {
      const user = await span('db.findUser', async () => {
        await sleep(5)
        return { id: 1 }
      })
      await fetch(`${upstream}/profile`).then((r) => r.text())
      res.json(user)
    })
    app.get('/boom', () => {
      throw new Error('handler failed')
    })
    const base = await listen(app)

    const res = await fetch(`${base}/users/1?debug=true`)
    expect(await res.json()).toEqual({ id: 1 })
    await fetch(`${base}/boom`).then((r) => r.text())
    await waitForReports(reports, 2)

    const [ok, failed] = reports
    expect(ok?.name).toBe('GET /users/1')
    expect(names(ok as TraceReport)).toEqual(
      expect.arrayContaining(['GET /users/1', 'db.findUser', `GET ${upstream.slice(7)}/profile`]),
    )
    expect(ok?.spans[0]?.attrs).toEqual({ status: 200 })
    expect(ok?.status).toBe('ok')
    expect(failed).toMatchObject({ name: 'GET /boom', status: 'error' })
    expect(failed?.spans[0]?.attrs).toEqual({ status: 500 })
  })

  it('works with a plain node:http handler, custom names and thresholds', async () => {
    const reports: TraceReport[] = []
    const printed: string[] = []
    const trace = middleware({
      name: (req) => `custom ${req.method}`,
      threshold: 1_000,
      write: (text) => printed.push(text),
      onEnd: (r) => reports.push(r),
    })
    const base = await listen((req, res) =>
      trace(req, res, () => {
        void span('work', () => sleep(2)).then(() => res.end('done'))
      }),
    )
    await fetch(`${base}/x`, { method: 'DELETE' }).then((r) => r.text())
    await waitForReports(reports, 1)
    expect(reports[0]?.name).toBe('custom DELETE')
    expect(names(reports[0] as TraceReport)).toContain('work')
    expect(printed).toEqual([]) // faster than the threshold
  })

  it('validates options', () => {
    expect(() => middleware(null as never)).toThrow('middleware(options) expects an options object')
  })
})
