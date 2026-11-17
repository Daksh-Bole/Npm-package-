import { describe, expect, it } from 'vitest'
import { instrument, span, trace, wrap } from '../src/node'
import { collector, names, sleep } from './helpers'

describe('wrap()', () => {
  it('records every call and preserves this, arguments, name and length', async () => {
    const c = collector()
    const counter = {
      base: 10,
      async add(a: number, b: number) {
        await sleep(1)
        return this.base + a + b
      },
    }
    counter.add = wrap('counter.add', counter.add)
    expect(counter.add.name).toBe('add')
    expect(counter.add.length).toBe(2)
    const sum = await trace('root', () => counter.add(1, 2), c.options)
    expect(sum).toBe(13)
    expect(names(c.last())).toEqual(['root', 'counter.add'])
  })

  it('names spans after the function when no name is given, and passes errors through', () => {
    const c = collector()
    function parseConfig(input: string) {
      if (!input) throw new SyntaxError('empty')
      return input.length
    }
    const parse = wrap(parseConfig)
    trace(
      'root',
      () => {
        expect(parse('abc')).toBe(3)
        expect(() => parse('')).toThrow(SyntaxError)
      },
      c.options,
    )
    expect(c.last().spans.map((s) => [s.name, s.status])).toEqual([
      ['root', 'ok'],
      ['parseConfig', 'ok'],
      ['parseConfig', 'error'],
    ])
  })

  it('is a plain passthrough outside traces', () => {
    expect(wrap((x: number) => x * 2)(4)).toBe(8)
  })

  it('validates arguments', () => {
    expect(() => wrap('x', undefined as never)).toThrow(
      'wrap() expects a function as the second argument',
    )
    expect(() => wrap(undefined as never)).toThrow('wrap() expects a function, got undefined')
    expect(() => wrap(5 as never, () => 1)).toThrow('expects a string name')
  })
})

describe('instrument()', () => {
  class Repository {
    #rows = [1, 2, 3]
    label = 'repo'
    get size() {
      return this.#rows.length
    }
    async findAll() {
      await sleep(1)
      return [...this.#rows]
    }
    count() {
      return this.#rows.length
    }
    async fail() {
      throw new Error('db down')
    }
  }

  it('records async methods as <name>.<method>, keeping private fields and getters working', async () => {
    const c = collector()
    const repo = instrument(new Repository(), 'repo')
    const result = await trace(
      'root',
      async () => {
        const rows = await repo.findAll()
        return { rows, count: repo.count(), size: repo.size, label: repo.label }
      },
      c.options,
    )
    expect(result).toEqual({ rows: [1, 2, 3], count: 3, size: 3, label: 'repo' })
    // Synchronous calls are skipped by default so they don't flood the waterfall.
    expect(names(c.last())).toEqual(['root', 'repo.findAll'])
  })

  it('records sync calls with { sync: true } and defaults the name to the class name', () => {
    const c = collector()
    const repo = instrument(new Repository(), { sync: true })
    trace('root', () => repo.count(), c.options)
    expect(names(c.last())).toEqual(['root', 'Repository.count'])
  })

  it('records rejections and keeps method identity stable', async () => {
    const c = collector()
    const repo = instrument(new Repository())
    expect(repo.findAll).toBe(repo.findAll)
    await trace('root', () => repo.fail().catch(() => 'handled'), c.options)
    expect(c.last().spans[1]).toMatchObject({ name: 'Repository.fail', status: 'error' })
  })

  it('works on plain objects and functions, and leaves then/constructor alone', async () => {
    const c = collector()
    const api = instrument({
      async ping() {
        return 'pong'
      },
      then: undefined as unknown,
    })
    expect(await trace('root', () => api.ping(), c.options)).toBe('pong')
    expect(names(c.last())).toEqual(['root', 'object.ping'])
    const fnTarget = instrument(
      Object.assign(function client() {}, {
        async go() {
          return 1
        },
      }),
    )
    await trace('root', () => fnTarget.go(), c.options)
    expect(names(c.last())).toEqual(['root', 'client.go'])
  })

  it('re-parents spans created inside discarded sync calls', () => {
    const c = collector()
    const svc = instrument(
      {
        run(cb: () => number) {
          return cb()
        },
      },
      'svc',
    )
    // `inner` is opened implicitly under the `svc.run` span, which is then discarded (sync call).
    trace('root', () => svc.run(() => span('inner', () => 1)), c.options)
    const report = c.last()
    expect(names(report)).toEqual(['root', 'inner'])
    expect(report.spans[1]?.parentId).toBe(report.spans[0]?.id)
  })

  it('validates its target', () => {
    expect(() => instrument(null as never)).toThrow('instrument() expects an object, got null')
    expect(() => instrument(3 as never)).toThrow('got number')
  })
})
