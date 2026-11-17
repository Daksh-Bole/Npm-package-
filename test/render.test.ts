import { describe, expect, it } from 'vitest'
import { render } from '../src/node'
import { stringWidth } from '../src/format'
import { reportFrom } from './helpers'
import type { Spec } from './helpers'

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g
const plain = (text: string) => text.replace(ANSI, '')

const checkout: Spec = {
  name: 'checkout',
  start: 0,
  end: 400,
  children: [
    { name: 'db.getUser', start: 0, end: 45 },
    { name: 'db.getCart', start: 45, end: 85 },
    ...Array.from({ length: 6 }, (_, i) => ({
      name: 'db.getProduct',
      start: 85 + i * 16,
      end: 85 + i * 16 + 16,
    })),
    {
      name: 'pricing',
      start: 181,
      end: 340,
      children: [
        { name: 'GET tax.dev/rates', kind: 'http', start: 182, end: 330, attrs: { status: 200 } },
      ],
    },
    { name: 'sendReceipt', start: 340, end: null },
  ],
}

describe('render()', () => {
  it('draws a waterfall with a tree, durations, an axis, markers and insights', () => {
    const output = render(reportFrom(checkout), { color: false, width: 100 })
    expect(output).toMatchInlineSnapshot(`
      "awaitfall checkout  400ms  11 spans · 1 HTTP
                                         0              100ms           200ms          300ms
      checkout                    400ms  █████████████████████████████████████████████████████████████
      ├─ db.getUser                45ms  ██████▉                                                       [3]
      ├─ db.getCart                40ms        ▕██████
      ├─ db.getProduct             16ms              ▕██▍                                              [1]
      ├─ db.getProduct             16ms                 ▐█▉
      ├─ +4 more db.getProduct     64ms                   ▕█████████▋
      ├─ pricing                  159ms                             ▕███████████████████████▉
      │  └─ GET tax.dev/rates 200 148ms                             ▕██████████████████████▍           [4]
      └─ sendReceipt              60ms+                                                     ░░░░░░░░░░ [2]

      [1] N+1         \`db.getProduct\` ran 6× one after another inside \`checkout\` (96ms total). That's the
                      N+1 pattern: batch it into one call, or run the calls concurrently to save up to
                      ~80ms.
      [2] Unawaited   \`sendReceipt\` was still running when \`checkout\` finished. Is an \`await\` missing?
      [3] Sequential  \`db.getUser\` → \`db.getCart\` ran one after another inside \`checkout\` (85ms). If they
                      don't depend on each other, Promise.all could save ~40ms.
      [4] Bottleneck  \`GET tax.dev/rates\` took 148ms, 37% of the total, on the critical path. Speed this
                      up first."
    `)
  })

  it('never exceeds the requested width', () => {
    const report = reportFrom({
      ...checkout,
      children: [
        ...(checkout.children ?? []),
        {
          name: 'a very long span name that goes on and on and on and on and on and on',
          start: 10,
          end: 20,
          children: [{ name: '深い入れ子のスパン名前日本語テキスト', start: 11, end: 19 }],
        },
      ],
    })
    for (const width of [40, 60, 80, 120, 200]) {
      for (const color of [false, true]) {
        for (const line of render(report, { width, color }).split('\n')) {
          expect(stringWidth(plain(line)), `width ${width}: ${plain(line)}`).toBeLessThanOrEqual(
            width,
          )
        }
      }
    }
  })

  it('uses ANSI colors only when asked, turning `code` into bold text', () => {
    const report = reportFrom(checkout)
    const colored = render(report, { color: true, width: 100 })
    expect(colored).toMatch(ANSI)
    expect(colored).not.toContain('`db.getProduct`')
    expect(colored).toContain('\u001b[1mdb.getProduct\u001b[22m')
    const noColor = render(report, { color: false, width: 100 })
    expect(noColor).not.toMatch(ANSI)
    expect(noColor).toContain('`db.getProduct`')
    // Same text either way (line breaks may differ because backticks take up room).
    const words = (text: string) => text.replace(/`/g, '').replace(/\s+/g, ' ')
    expect(words(plain(colored))).toBe(words(noColor))
  })

  it('folds long runs of identical siblings, unless fold is 0', () => {
    const many: Spec = {
      name: 'root',
      start: 0,
      end: 200,
      children: Array.from({ length: 20 }, (_, i) => ({
        name: `GET api/items/${i}`,
        kind: 'http' as const,
        start: i * 10,
        end: i * 10 + 10,
      })),
    }
    const folded = render(reportFrom(many), { color: false, width: 100 })
    expect(folded).toContain('GET api/items/0')
    expect(folded).toContain('GET api/items/1')
    expect(folded).toContain('└─ +18 more GET api/items/*')
    expect(folded).not.toContain('GET api/items/5 ')
    const unfolded = render(reportFrom(many), { color: false, width: 100, fold: 0 })
    expect(unfolded).toContain('GET api/items/19')
    expect(unfolded).not.toContain('more GET')
  })

  it('limits rows and insights', () => {
    const report = reportFrom(checkout)
    const output = render(report, { color: false, width: 100, maxRows: 3, maxInsights: 1 })
    expect(output).toContain('… 6 more rows (raise maxRows to see them)')
    expect(output).toContain('[1] ')
    expect(output).not.toContain('[2] ')
    expect(output).toContain(`+${report.insights.length - 1} more in report.insights`)
  })

  it('shows failures in the header and handles zero-length traces', () => {
    const failed = reportFrom({ name: 'job', start: 0, end: 0, status: 'error', error: 'Error: x' })
    const output = render(failed, { color: false, width: 80 })
    expect(output.split('\n')[0]).toBe('awaitfall job  0ms  0 spans  ✖ failed')
    expect(output).not.toContain('NaN')
    expect(output).not.toContain('Infinity')
  })

  it('renders without options using platform defaults', () => {
    expect(typeof render(reportFrom(checkout))).toBe('string')
  })
})
