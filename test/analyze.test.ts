import { describe, expect, it } from 'vitest'
import { spansFrom } from './helpers'
import type { Spec } from './helpers'

const kinds = (spec: Spec, options = {}) => spansFrom(spec, options).insights.map((i) => i.kind)

describe('derived span fields', () => {
  it('computes depth, self time and the critical path', () => {
    const { byName } = spansFrom({
      name: 'root',
      start: 0,
      end: 100,
      children: [
        { name: 'a', start: 0, end: 30, children: [{ name: 'a1', start: 5, end: 25 }] },
        { name: 'b', start: 30, end: 100 },
        { name: 'c', start: 30, end: 60 }, // overlaps b, finishes earlier: not critical
      ],
    })
    expect(byName('a1').depth).toBe(2)
    expect(byName('a').selfTime).toBe(10)
    expect(byName('root').selfTime).toBe(0)
    expect(['root', 'a', 'a1', 'b'].map((n) => byName(n).critical)).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect(byName('c').critical).toBe(false)
  })

  it('handles an empty span list', async () => {
    const { analyze } = await import('../src/analyze')
    expect(analyze([])).toEqual([])
  })
})

describe('insight: repeated (N+1)', () => {
  const loop = (count: number, each: number, gap = 0, async = true): Spec[] =>
    Array.from({ length: count }, (_, i) => ({
      name: `db.query user ${i + 1}`,
      start: i * (each + gap),
      end: i * (each + gap) + each,
      async,
    }))

  it('flags the same operation awaited in a loop, matching names that only differ by ids', () => {
    const { insights } = spansFrom({ name: 'root', start: 0, end: 100, children: loop(10, 10) })
    const n1 = insights.find((i) => i.kind === 'repeated')
    expect(n1).toMatchObject({ severity: 'warn', savings: 90 })
    expect(n1?.spanIds).toHaveLength(10)
    expect(n1?.message).toContain('`db.query user *` ran 10× one after another inside `root`')
  })

  it('respects minRepeats and minSavings', () => {
    const spec: Spec = { name: 'root', start: 0, end: 100, children: loop(4, 25) }
    expect(kinds(spec)).not.toContain('repeated')
    expect(kinds(spec, { minRepeats: 3 })).toContain('repeated')
    const cheap: Spec = { name: 'root', start: 0, end: 1000, children: loop(10, 0.5) }
    expect(kinds(cheap)).not.toContain('repeated')
  })

  it('ignores synchronous repeats (they cannot be parallelized)', () => {
    expect(
      kinds({ name: 'root', start: 0, end: 100, children: loop(10, 10, 0, false) }),
    ).not.toContain('repeated')
  })

  it('reports concurrent repeats as info, only for larger groups', () => {
    const fanOut = (count: number): Spec[] =>
      Array.from({ length: count }, (_, i) => ({
        name: `GET /items/${i}`,
        kind: 'http',
        start: 0,
        end: 50,
      }))
    const big = spansFrom({ name: 'root', start: 0, end: 50, children: fanOut(12) }).insights
    expect(big.find((i) => i.kind === 'repeated')).toMatchObject({ severity: 'info' })
    expect(big.find((i) => i.kind === 'repeated')?.message).toContain('up to 12 at a time')
    expect(kinds({ name: 'root', start: 0, end: 50, children: fanOut(6) })).not.toContain(
      'repeated',
    )
  })
})

describe('insight: sequential', () => {
  it('suggests Promise.all for independent-looking steps', () => {
    const { insights } = spansFrom({
      name: 'root',
      start: 0,
      end: 300,
      children: [
        { name: 'loadUser', start: 0, end: 100 },
        { name: 'loadCart', start: 100, end: 180 },
        { name: 'loadPrefs', start: 180, end: 300 },
      ],
    })
    const hint = insights.find((i) => i.kind === 'sequential')
    expect(hint).toMatchObject({ severity: 'info', savings: 180 })
    expect(hint?.message).toBe(
      '`loadUser` → `loadCart` → `loadPrefs` ran one after another inside `root` (300ms). ' +
        "If they don't depend on each other, Promise.all could save ~180ms.",
    )
  })

  it('treats overlapping siblings as one stage', () => {
    const { insights } = spansFrom({
      name: 'root',
      start: 0,
      end: 200,
      children: [
        { name: 'a', start: 0, end: 100 },
        { name: 'b', start: 0, end: 80 },
        { name: 'c', start: 100, end: 200 },
      ],
    })
    const hint = insights.find((i) => i.kind === 'sequential')
    expect(hint?.message).toContain('(`a` + `b`) → `c`')
    expect(hint?.savings).toBe(100)
  })

  it('stays quiet when the steps already run in parallel or savings are tiny', () => {
    expect(
      kinds({
        name: 'root',
        start: 0,
        end: 100,
        children: [
          { name: 'a', start: 0, end: 100 },
          { name: 'b', start: 1, end: 90 },
        ],
      }),
    ).not.toContain('sequential')
    expect(
      kinds({
        name: 'root',
        start: 0,
        end: 1000,
        children: [
          { name: 'a', start: 0, end: 2 },
          { name: 'b', start: 2, end: 4 },
        ],
      }),
    ).not.toContain('sequential')
  })

  it('abbreviates long chains and reports at most two', () => {
    const chain = (prefix: string, offset: number): Spec => ({
      name: prefix,
      start: offset,
      end: offset + 600,
      children: Array.from({ length: 6 }, (_, i) => ({
        name: `${prefix}${i}`,
        start: offset + i * 100,
        end: offset + (i + 1) * 100,
      })),
    })
    const { insights } = spansFrom({
      name: 'root',
      start: 0,
      end: 1800,
      children: [chain('x', 0), chain('y', 600), chain('z', 1200)],
    })
    const hints = insights.filter((i) => i.kind === 'sequential')
    expect(hints.length).toBeLessThanOrEqual(2)
    expect(hints.some((h) => h.message.includes('→ … →') && h.message.includes('(6 steps)'))).toBe(
      true,
    )
  })
})

describe('insight: unawaited', () => {
  it('flags work still running when the trace ended, but not its children', () => {
    const { insights } = spansFrom({
      name: 'root',
      start: 0,
      end: 100,
      children: [
        { name: 'work', start: 0, end: 100 },
        {
          name: 'sendEmail',
          start: 90,
          end: null,
          children: [{ name: 'POST /email', kind: 'http', start: 91, end: null }],
        },
      ],
    })
    const flagged = insights.filter((i) => i.kind === 'unawaited')
    expect(flagged).toHaveLength(1)
    expect(flagged[0]?.message).toBe(
      '`sendEmail` was still running when `root` finished. Is an `await` missing?',
    )
  })

  it('flags children that finished after their parent returned', () => {
    const { insights } = spansFrom({
      name: 'root',
      start: 0,
      end: 200,
      children: [
        { name: 'parent', start: 0, end: 50, children: [{ name: 'child', start: 10, end: 120 }] },
        { name: 'other', start: 50, end: 200 },
      ],
    })
    expect(insights.find((i) => i.kind === 'unawaited')?.message).toBe(
      '`child` finished 70ms after its parent `parent` returned. Is an `await` missing?',
    )
  })

  it('uses "in flight" wording for HTTP requests', () => {
    const { insights } = spansFrom({
      name: 'root',
      start: 0,
      end: 10,
      children: [{ name: 'GET api/x', kind: 'http', start: 5, end: null }],
    })
    expect(insights[0]?.message).toContain('was still in flight')
  })
})

describe('insight: error', () => {
  it('reports where an error started, as a warning when it was swallowed', () => {
    const { insights } = spansFrom({
      name: 'root',
      start: 0,
      end: 10,
      children: [
        {
          name: 'outer',
          start: 0,
          end: 10,
          status: 'error',
          error: 'Error: x',
          children: [{ name: 'inner', start: 1, end: 5, status: 'error', error: 'Error: x' }],
        },
      ],
    })
    const errors = insights.filter((i) => i.kind === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ severity: 'warn' })
    expect(errors[0]?.message).toBe(
      '`inner` failed after 4.0ms with Error: x. It was caught before reaching `root`.',
    )
  })

  it('is informational when the whole trace failed', () => {
    const { insights } = spansFrom({
      name: 'root',
      start: 0,
      end: 10,
      status: 'error',
      error: 'Error: x',
      children: [{ name: 'inner', start: 1, end: 5, status: 'error', error: 'Error: x' }],
    })
    expect(insights.find((i) => i.kind === 'error')?.severity).toBe('info')
  })
})

describe('insight: bottleneck', () => {
  it('names the slowest leaf on the critical path', () => {
    const { insights } = spansFrom({
      name: 'root',
      start: 0,
      end: 100,
      children: [
        { name: 'fast', start: 0, end: 10 },
        { name: 'GET tax/rates', kind: 'http', start: 10, end: 100 },
      ],
    })
    expect(insights.find((i) => i.kind === 'bottleneck')?.message).toBe(
      '`GET tax/rates` took 90ms, 90% of the total, on the critical path. Speed this up first.',
    )
  })

  it('points at untraced time in the root or inside a span', () => {
    const root = spansFrom({
      name: 'root',
      start: 0,
      end: 100,
      children: [{ name: 'tiny', start: 0, end: 10 }],
    }).insights
    expect(root.find((i) => i.kind === 'bottleneck')?.message).toContain(
      "90% of `root` (90ms) isn't covered by any span",
    )
    const inner = spansFrom({
      name: 'root',
      start: 0,
      end: 100,
      children: [
        { name: 'compute', start: 0, end: 100, children: [{ name: 'io', start: 0, end: 10 }] },
      ],
    }).insights
    expect(inner.find((i) => i.kind === 'bottleneck')?.message).toContain(
      '`compute` spent 90ms (90%) in its own code',
    )
  })

  it('nudges first-time users when nothing inside the trace was traced', () => {
    const { insights } = spansFrom({ name: 'main', start: 0, end: 50 })
    expect(insights).toHaveLength(1)
    expect(insights[0]?.message).toContain('Nothing inside `main` was traced')
  })

  it('stays quiet when work is spread out', () => {
    const children: Spec[] = Array.from({ length: 5 }, (_, i) => ({
      name: `step${i}`,
      start: i * 20,
      end: i * 20 + 20,
      async: false,
    }))
    expect(kinds({ name: 'root', start: 0, end: 100, children })).toEqual([])
  })
})

describe('options', () => {
  it('can ignore kinds or disable insights entirely', () => {
    const spec: Spec = {
      name: 'root',
      start: 0,
      end: 100,
      children: [
        { name: 'a', start: 0, end: 50 },
        { name: 'b', start: 50, end: 100 },
        { name: 'c', start: 60, end: null },
      ],
    }
    expect(kinds(spec)).toEqual(expect.arrayContaining(['unawaited', 'sequential']))
    expect(kinds(spec, { ignore: ['unawaited', 'sequential', 'bottleneck'] })).toEqual([])
    expect(spansFrom(spec, false).insights).toEqual([])
    // Derived fields are still computed when insights are off.
    expect(spansFrom(spec, false).byName('a').critical).toBe(true)
  })

  it('sorts warnings before infos', () => {
    const { insights } = spansFrom({
      name: 'root',
      start: 0,
      end: 100,
      children: [
        { name: 'a', start: 0, end: 50 },
        { name: 'b', start: 50, end: 100 },
        { name: 'late', start: 90, end: null },
      ],
    })
    expect(insights.map((i) => `${i.severity}:${i.kind}`)).toEqual([
      'warn:unawaited',
      'info:sequential',
      'info:bottleneck',
    ])
  })
})

describe('insight: sequential runs', () => {
  it('ends a run at synchronous work and at N+1 loops', () => {
    const loop: Spec[] = Array.from({ length: 6 }, (_, i) => ({
      name: 'db.getProduct',
      start: 100 + i * 20,
      end: 120 + i * 20,
    }))
    const { insights } = spansFrom({
      name: 'root',
      start: 0,
      end: 400,
      children: [
        { name: 'getUser', start: 0, end: 50 },
        { name: 'getCart', start: 50, end: 100 },
        ...loop,
        { name: 'pricing', start: 220, end: 300 },
        { name: 'render', start: 300, end: 320, async: false },
        { name: 'save', start: 320, end: 400 },
      ],
    })
    const hints = insights.filter((i) => i.kind === 'sequential')
    expect(hints).toHaveLength(1)
    expect(hints[0]?.message).toContain('`getUser` → `getCart` ran one after another')
  })
})
