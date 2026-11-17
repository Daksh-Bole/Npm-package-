// Runs against the built package through its public "exports" (node condition, CommonJS).
const assert = require('node:assert/strict')
const { profile, span, trace } = require('awaitfall')

assert.equal(typeof trace.start, 'function')
profile('cjs-smoke', async () => {
  await span('a', () => new Promise((r) => setTimeout(r, 2)))
  await span('b', () => new Promise((r) => setTimeout(r, 2)))
}).then(({ report }) => {
  assert.deepEqual(
    report.spans.map((s) => s.name),
    ['cjs-smoke', 'a', 'b'],
  )
  assert.equal(report.spans[1].parentId, 0)
  console.log('cjs smoke test passed')
})
