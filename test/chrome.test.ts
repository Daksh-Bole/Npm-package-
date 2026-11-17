import { describe, expect, it } from 'vitest'
import { toChromeTrace } from '../src/node'
import type { ChromeTraceEvent } from '../src/node'
import { reportFrom } from './helpers'

describe('toChromeTrace()', () => {
  const report = reportFrom({
    name: 'root',
    start: 0,
    end: 100,
    children: [
      { name: 'a', start: 0, end: 60, children: [{ name: 'a1', start: 10, end: 50 }] },
      { name: 'b', start: 20, end: 80 }, // overlaps a without nesting → separate lane
      { name: 'c', start: 60, end: 100 },
      { name: 'late', start: 90, end: null },
    ],
  })
  const trace = toChromeTrace(report)
  const slices = trace.traceEvents.filter((e) => e.ph === 'X')

  it('emits one complete event per span, in microseconds', () => {
    expect(slices).toHaveLength(report.spans.length)
    const a = slices.find((e) => e.name === 'a') as ChromeTraceEvent
    expect(a.dur).toBe(60_000)
    expect(a.ts).toBe(report.startedAt * 1000)
    expect(slices.find((e) => e.name === 'late')?.args).toMatchObject({ status: 'running' })
    expect(trace.displayTimeUnit).toBe('ms')
  })

  it('assigns lanes so that events on each lane nest properly', () => {
    const byLane = new Map<number, ChromeTraceEvent[]>()
    for (const e of slices) byLane.set(e.tid, [...(byLane.get(e.tid) ?? []), e])
    expect(byLane.size).toBeGreaterThan(1)
    for (const events of byLane.values()) {
      const open: number[] = []
      for (const e of [...events].sort((x, y) => (x.ts as number) - (y.ts as number))) {
        const start = e.ts as number
        const end = start + (e.dur as number)
        while (open.length && (open[open.length - 1] as number) <= start) open.pop()
        if (open.length) expect(end).toBeLessThanOrEqual(open[open.length - 1] as number)
        open.push(end)
      }
    }
  })

  it('names the process and lanes, and survives JSON round-trips', () => {
    const meta = trace.traceEvents.filter((e) => e.ph === 'M')
    expect(meta[0]).toMatchObject({ name: 'process_name', args: { name: 'awaitfall: root' } })
    expect(meta.some((e) => e.name === 'thread_name')).toBe(true)
    expect(JSON.parse(JSON.stringify(trace))).toEqual(trace)
  })
})
