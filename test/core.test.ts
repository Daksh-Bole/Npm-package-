import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { configure, profile, span, trace } from '../src/node'
import type { ActiveTrace, Span, TraceReport } from '../src/node'
import { collector, names, parentOf, sleep, withFakeTime } from './helpers'

afterEach(() => {
  configure({})
  vi.unstubAllEnvs()
})

describe('trace()', () => {
  it('returns the value of a sync function synchronously', () => {
    const c = collector()
    const value = trace('sync', () => 42, c.options)
    expect(value).toBe(42)
    expect(c.reports).toHaveLength(1)
    expect(c.last().name).toBe('sync')
    expect(c.last().status).toBe('ok')
  })

  it('returns a promise for async functions and resolves to the same value', async () => {
    const c = collector()
    const pending = trace('async', async () => 'done', c.options)
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).resolves.toBe('done')
    expect(c.last().spans[0]?.async).toBe(true)
  })

  it('rethrows the exact error from sync and async functions', async () => {
    const c = collector()
    const boom = new Error('boom')
    expect(() =>
      trace(
        'sync-fail',
        () => {
          throw boom
        },
        c.options,
      ),
    ).toThrow(boom)
    expect(c.last().status).toBe('error')

    await expect(
      trace(
        'async-fail',
        async () => {
          throw boom
        },
        c.options,
      ),
    ).rejects.toBe(boom)
    expect(c.last().status).toBe('error')
    expect(c.last().spans[0]?.error).toBe('Error: boom')
  })

  it('builds a tree through awaits and Promise.all using AsyncLocalStorage', async () => {
    const c = collector()
    await trace(
      'root',
      async () => {
        await span('a', async () => {
          await sleep(1)
          await span('a.1', () => sleep(1))
        })
        await Promise.all([
          span('b', async () => {
            await sleep(2)
            await span('b.1', () => sleep(1))
          }),
          span('c', async () => {
            await sleep(1)
            await span('c.1', () => sleep(2))
          }),
        ])
      },
      c.options,
    )
    const report = c.last()
    expect(names(report).sort()).toEqual(['a', 'a.1', 'b', 'b.1', 'c', 'c.1', 'root'])
    expect(parentOf(report, 'a.1')).toBe('a')
    expect(parentOf(report, 'b.1')).toBe('b')
    expect(parentOf(report, 'c.1')).toBe('c')
    expect(parentOf(report, 'b')).toBe('root')
    expect(report.spans[0]?.name).toBe('root')
    expect(report.spans.map((s) => s.depth)).toContain(2)
  })

  it('measures durations exactly (fake clock)', async () => {
    const c = collector()
    await withFakeTime(() =>
      trace(
        'timed',
        async () => {
          await span('first', () => sleep(100))
          await Promise.all([span('p1', () => sleep(50)), span('p2', () => sleep(30))])
        },
        c.options,
      ),
    )
    const report = c.last()
    const get = (name: string) => report.spans.find((s) => s.name === name)
    expect(report.duration).toBe(150)
    expect(get('first')).toMatchObject({ start: 0, end: 100, duration: 100, critical: true })
    expect(get('p1')).toMatchObject({ start: 100, end: 150, critical: true })
    expect(get('p2')).toMatchObject({ start: 100, end: 130, critical: false })
  })

  it('passes a handle with the span name, explicit children and attributes', () => {
    const c = collector()
    trace(
      'root',
      (t) => {
        expect(t.name).toBe('root')
        t.set('user', 'ada').set('items', 3)
        t.span('explicit', (child) => {
          expect(child.name).toBe('explicit')
          child.set('ok', true)
        })
      },
      c.options,
    )
    const report = c.last()
    expect(report.spans[0]?.attrs).toEqual({ user: 'ada', items: 3 })
    expect(report.spans[1]).toMatchObject({ name: 'explicit', attrs: { ok: true }, async: false })
  })

  it('accepts a function only and uses its name', () => {
    const c = collector()
    function loadEverything() {
      return 1
    }
    expect(trace(loadEverything, c.options)).toBe(1)
    expect(c.last().name).toBe('loadEverything')
    expect(trace(() => 2, c.options)).toBe(2)
    expect(c.last().name).toBe('trace')
  })

  it('behaves like span() when nested inside another trace', async () => {
    const c = collector()
    await trace(
      'outer',
      async () => {
        await trace('inner', () => sleep(1), { print: true, write: () => {} })
      },
      c.options,
    )
    expect(c.reports).toHaveLength(1)
    expect(c.printed).toHaveLength(1)
    expect(parentOf(c.last(), 'inner')).toBe('outer')
  })

  it('prints the waterfall through `write`, honoring `threshold` and `print`', () => {
    const c = collector()
    trace('printed', () => {}, c.options)
    expect(c.printed).toHaveLength(1)
    expect(c.printed[0]).toContain('printed')
    expect(c.printed[0]).not.toContain('\u001b[') // custom writers default to no color

    trace('quiet', () => {}, { ...c.options, print: false })
    trace('fast', () => {}, { ...c.options, threshold: 10_000 })
    expect(c.printed).toHaveLength(1)
    expect(c.reports.map((r) => r.name)).toEqual(['printed', 'quiet', 'fast'])
  })

  it('writes to stderr by default', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      trace('to-stderr', () => {})
      expect(write).toHaveBeenCalledTimes(1)
      expect(String(write.mock.calls[0]?.[0])).toContain('to-stderr')
    } finally {
      write.mockRestore()
    }
  })

  it('never lets a failing onEnd or write break the traced code', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const value = trace('resilient', () => 'still works', {
        onEnd: () => {
          throw new Error('onEnd exploded')
        },
        write: () => {
          throw new Error('write exploded')
        },
      })
      expect(value).toBe('still works')
      const warnings = write.mock.calls.map((call) => String(call[0]))
      expect(warnings.some((w) => w.includes('onEnd threw: onEnd exploded'))).toBe(true)
      expect(warnings.some((w) => w.includes('could not print the trace: write exploded'))).toBe(
        true,
      )
    } finally {
      write.mockRestore()
    }
  })

  it('marks spans still running at the end, and ignores spans started after it', async () => {
    const c = collector()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    await trace(
      'root',
      () => {
        void span('floating', () => gate.then(() => span('late', () => 'too late')))
      },
      c.options,
    )
    const report = c.last()
    expect(report.spans.find((s) => s.name === 'floating')).toMatchObject({
      status: 'running',
      end: null,
    })
    release()
    await sleep(5)
    expect(names(report)).not.toContain('late')
    expect(report.insights.some((i) => i.kind === 'unawaited')).toBe(true)
  })

  it('stops recording at maxSpans and counts the rest as dropped', () => {
    const c = collector()
    trace(
      'big',
      () => {
        for (let i = 0; i < 20; i++) span(`s${i}`, () => i)
      },
      { ...c.options, maxSpans: 5 },
    )
    expect(c.last().spans).toHaveLength(5)
    expect(c.last().dropped).toBe(16)
    expect(c.printed[0]).toContain('16 spans were not recorded')
  })

  it('produces a JSON-serializable report', async () => {
    const c = collector()
    await trace('json', async () => span('x', () => sleep(1)), c.options)
    const copy = JSON.parse(JSON.stringify(c.last())) as TraceReport
    expect(copy).toEqual(c.last())
  })
})

describe('span()', () => {
  it('just calls through outside a trace', async () => {
    expect(span('alone', () => 7)).toBe(7)
    await expect(span('alone-async', async () => 8)).resolves.toBe(8)
    expect(span('handle', (s) => s.name)).toBe('handle')
    expect(span('nested', (s) => s.span('inner', (i) => i.set('k', 1).name))).toBe('inner')
  })

  it('keeps sync spans sync and records errors', () => {
    const c = collector()
    trace(
      'root',
      () => {
        expect(span('sync', () => 'x')).toBe('x')
        expect(() =>
          span('throws', () => {
            throw new TypeError('bad')
          }),
        ).toThrow(TypeError)
      },
      c.options,
    )
    const failed = c.last().spans.find((s) => s.name === 'throws')
    expect(failed).toMatchObject({ status: 'error', error: 'TypeError: bad', async: false })
    expect(c.last().status).toBe('ok')
    expect(c.last().insights.find((i) => i.kind === 'error')?.severity).toBe('warn')
  })

  it('works with thenables that are not native promises', async () => {
    const c = collector()
    const thenable = {
      then(resolve: (v: number) => void) {
        setTimeout(() => resolve(5), 1)
      },
    }
    const value = await trace('root', () => span('thenable', () => thenable), c.options)
    expect(value).toBe(5)
    expect(c.last().spans[1]).toMatchObject({ name: 'thenable', status: 'ok', async: true })
  })

  it('gives helpful errors for wrong arguments', () => {
    expect(() => span('x', undefined as never)).toThrow(
      "[awaitfall] span(name, fn) expects a function as the second argument, got undefined. Did you mean span('x', () => yourCall())?",
    )
    expect(() => span(42 as never, () => 1)).toThrow('expects a string name, got number 42')
    expect(() => trace('x', () => 1, 'nope' as never)).toThrow('options must be an object')
    expect(() => span('x', null as never)).toThrow('got null')
    // The classic mistake: passing the call's result instead of a function.
    const pending = Promise.resolve(1)
    expect(() => span('load', pending as never)).toThrow(
      "[awaitfall] span(name, fn) expects a function as the second argument, got a promise. Did you mean span('load', () => yourCall())?",
    )
    expect(() => span('x', {} as never)).toThrow('got an object')
    expect(() => trace('x', () => 1, [] as never)).toThrow(
      'options must be an object, got an array',
    )
  })

  it('uses a placeholder name for empty strings and anonymous functions', () => {
    const c = collector()
    trace(
      '',
      () => {
        span('', () => 1)
        span(() => 2)
      },
      c.options,
    )
    expect(names(c.last())).toEqual(['anonymous', 'anonymous', 'anonymous'])
  })
})

describe('trace.start()', () => {
  it('lets hook-based frameworks begin and end a trace separately', async () => {
    const c = collector()
    const active = trace.start('GET /x', c.options)
    await active.run(() => span('handler', () => sleep(1)))
    active.set('status', 200)
    const report = active.end()
    expect(report?.name).toBe('GET /x')
    expect(report?.spans[0]?.attrs).toEqual({ status: 200 })
    expect(parentOf(report as TraceReport, 'handler')).toBe('GET /x')
    expect(active.end()).toBe(report) // idempotent
    expect(c.reports).toHaveLength(1)
  })

  it('records an error passed to end()', () => {
    const c = collector()
    const report = trace.start('fails', c.options).end(new RangeError('nope'))
    expect(report).toMatchObject({ status: 'error' })
    expect(report?.spans[0]?.error).toBe('RangeError: nope')
  })

  it('validates its arguments', () => {
    expect(() => trace.start(undefined as never)).toThrow('expects a string name')
    expect(() => trace.start('x').run(undefined as never)).toThrow('run() expects a function')
  })
})

describe('profile()', () => {
  it('returns result and report without printing', async () => {
    const write = vi.fn()
    const { result, report } = await profile(
      'job',
      async () => {
        await span('step', () => sleep(1))
        return 'ok'
      },
      { write },
    )
    expect(result).toBe('ok')
    expect(report.name).toBe('job')
    expect(names(report)).toEqual(['job', 'step'])
    expect(write).not.toHaveBeenCalled()
  })

  it('works synchronously and records even when tracing is disabled', () => {
    configure({ enabled: false })
    const { result, report } = profile('sync-job', () => span('inner', () => 3))
    expect(result).toBe(3)
    expect(names(report)).toEqual(['sync-job', 'inner'])
  })

  it('is isolated from an outer trace', async () => {
    const c = collector()
    await trace(
      'outer',
      async () => {
        const { report } = await profile('isolated', () => span('mine', () => sleep(1)))
        expect(names(report)).toEqual(['isolated', 'mine'])
      },
      c.options,
    )
    expect(names(c.last())).toEqual(['outer'])
  })

  it('rejects with the original error', async () => {
    const boom = new Error('x')
    await expect(
      profile('bad', async () => {
        throw boom
      }),
    ).rejects.toBe(boom)
  })
})

describe('configure() and the AWAITFALL switch', () => {
  it('disables tracing globally with enabled: false', () => {
    const onEnd = vi.fn()
    configure({ enabled: false, onEnd })
    expect(trace('off', (t) => t.span('child', () => 'passthrough'))).toBe('passthrough')
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('disables tracing with AWAITFALL=0/false/off', () => {
    for (const value of ['0', 'false', 'OFF']) {
      vi.stubEnv('AWAITFALL', value)
      const onEnd = vi.fn()
      trace('off', () => 1, { onEnd })
      expect(onEnd).not.toHaveBeenCalled()
    }
    vi.stubEnv('AWAITFALL', '1')
    const onEnd = vi.fn()
    trace('on', () => 1, { onEnd, print: false })
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('applies defaults and lets per-call options win', () => {
    const c = collector()
    configure({ ...c.options, print: false })
    trace('a', () => {})
    trace('b', () => {}, { print: true })
    expect(c.reports.map((r) => r.name)).toEqual(['a', 'b'])
    expect(c.printed).toHaveLength(1)
  })

  it('rejects non-object configuration', () => {
    expect(() => configure('x' as never)).toThrow('configure() expects an options object')
  })
})

describe('types', () => {
  it('infers return types', () => {
    expectTypeOf(() => trace('x', () => 1)).returns.toEqualTypeOf<number>()
    expectTypeOf(() => trace('x', async () => 'a')).returns.toEqualTypeOf<Promise<string>>()
    expectTypeOf(() => span('x', () => true)).returns.toEqualTypeOf<boolean>()
    expectTypeOf(() => trace.start('x')).returns.toEqualTypeOf<ActiveTrace>()
    expectTypeOf(() => profile('x', async () => 1)).returns.resolves.toEqualTypeOf<{
      result: number
      report: TraceReport
    }>()
    expectTypeOf(() => profile('x', () => 1)).returns.toEqualTypeOf<{
      result: number
      report: TraceReport
    }>()
    span('x', (handle) => expectTypeOf(handle).toEqualTypeOf<Span>())
    expectTypeOf<ReturnType<ActiveTrace['end']>>().toEqualTypeOf<TraceReport | undefined>()
  })
})
