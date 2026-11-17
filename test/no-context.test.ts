// Simulates a runtime without AsyncLocalStorage (e.g. a browser): implicit span() calls pass
// through, explicit handles still build a full tree.
import { describe, expect, it } from 'vitest'
import { createPlatform, setPlatform } from '../src/platform'
import { span, trace } from '../src/api'
import { collector, names, sleep } from './helpers'

setPlatform(createPlatform(undefined, undefined))

describe('without AsyncLocalStorage', () => {
  it('records spans created through the explicit handle', async () => {
    const c = collector()
    await trace(
      'page-load',
      async (t) => {
        await t.span('fetchData', async (s) => {
          await sleep(1)
          await s.span('parse', () => sleep(1))
        })
        await span('implicit', () => sleep(1)) // can't be attributed without context
      },
      c.options,
    )
    expect(names(c.last())).toEqual(['page-load', 'fetchData', 'parse'])
  })

  it('still builds and prints reports', () => {
    const c = collector()
    trace('x', () => 1, c.options)
    expect(c.printed[0]).toContain('awaitfall x')
  })
})
