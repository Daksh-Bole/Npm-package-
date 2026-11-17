// The non-Node entry (browsers, edge runtimes) must work without static node:* imports.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { profile, span } from '../../dist/index.js'

const source = readFileSync(new URL('../../dist/index.js', import.meta.url), 'utf8')
assert.ok(!/from ['"]node:/.test(source), 'default entry must not import node: modules')

const { report } = await profile('default-entry', async (t) => {
  await t.span('explicit', () => new Promise((r) => setTimeout(r, 1)))
  await span('implicit', () => new Promise((r) => setTimeout(r, 1)))
})
const names = report.spans.map((s) => s.name)
assert.ok(names.includes('explicit'))
// Implicit context needs AsyncLocalStorage, found at runtime via process.getBuiltinModule.
assert.equal(names.includes('implicit'), typeof process.getBuiltinModule === 'function')
console.log(`default entry smoke test passed (implicit context: ${names.includes('implicit')})`)
