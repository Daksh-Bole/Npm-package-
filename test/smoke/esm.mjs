// Runs against the built package through its public "exports" (node condition, ESM).
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  configure,
  instrument,
  middleware,
  profile,
  render,
  span,
  toChromeTrace,
  trace,
  wrap,
} from 'awaitfall'

for (const fn of [
  configure,
  instrument,
  middleware,
  profile,
  render,
  span,
  toChromeTrace,
  trace,
  wrap,
]) {
  assert.equal(typeof fn, 'function')
}
assert.equal(typeof trace.start, 'function')

const server = http.createServer((_req, res) => setTimeout(() => res.end('ok'), 5))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const db = instrument({ query: async (n) => new Promise((r) => setTimeout(() => r(n), 2)) }, 'db')
const { result, report } = await profile('esm-smoke', async () => {
  const rows = []
  for (let i = 0; i < 6; i++) rows.push(await db.query(i))
  await span('fetch', () => fetch(base).then((r) => r.text()))
  return rows.length
})
server.close()

assert.equal(result, 6)
assert.equal(report.spans.filter((s) => s.name === 'db.query').length, 6)
assert.ok(
  report.spans.some((s) => s.kind === 'http' && s.attrs.status === 200),
  'captures fetch',
)
assert.ok(
  report.insights.some((i) => i.kind === 'repeated'),
  'detects N+1',
)
assert.match(render(report, { color: false, width: 80 }), /awaitfall esm-smoke/)
assert.ok(toChromeTrace(report).traceEvents.length > report.spans.length)
console.log('esm smoke test passed')
