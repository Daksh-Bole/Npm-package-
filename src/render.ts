import { formatMs, normalizeName, padEnd, padStart, stringWidth, truncate } from './format'
import { getPlatform } from './platform'
import type { Insight, RenderOptions, SpanData, TraceReport } from './types'

type Style = (text: string) => string

function createPalette(enabled: boolean) {
  const style =
    (open: number, close: number): Style =>
    (text) =>
      enabled && text ? `\u001b[${open}m${text}\u001b[${close}m` : text
  return {
    bold: style(1, 22),
    dim: style(2, 22),
    red: style(31, 39),
    green: style(32, 39),
    yellow: style(33, 39),
    blue: style(34, 39),
    magenta: style(35, 39),
    cyan: style(36, 39),
    gray: style(90, 39),
    brightMagenta: style(95, 39),
    brightCyan: style(96, 39),
  }
}
type Palette = ReturnType<typeof createPalette>

interface Row {
  prefix: string
  name: string
  status?: number
  duration: number
  running: boolean
  intervals: Array<[number, number]>
  /** The span this row shows; `undefined` for a folded row. */
  span?: SpanData
  folded?: number
  marker?: { number: number; severity: Insight['severity'] }
}

type Item = { span: SpanData } | { folded: SpanData[]; label: string }

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const TITLES: Record<Insight['kind'], string> = {
  sequential: 'Sequential',
  repeated: 'Repeated',
  unawaited: 'Unawaited',
  bottleneck: 'Bottleneck',
  error: 'Error',
}

/** Renders a report as a text waterfall (with ANSI colors when `color` is on). */
export function render(report: TraceReport, options: RenderOptions = {}): string {
  const color = options.color ?? getPlatform().color()
  const width = Math.max(40, Math.floor(options.width ?? getPlatform().width()))
  const maxRows = Math.max(1, options.maxRows ?? 100)
  const maxInsights = Math.max(0, options.maxInsights ?? 5)
  const fold = Math.max(0, options.fold ?? 3)
  const p = createPalette(color)

  const total = report.duration > 0 ? report.duration : 1e-6
  const { rows, rowOf } = buildRows(report, fold)
  const shownInsights = report.insights.slice(0, maxInsights)
  shownInsights.forEach((insight, index) => {
    for (const id of insight.spanIds) {
      const row = rows[rowOf.get(id) ?? -1]
      if (row && !row.marker) {
        row.marker = { number: index + 1, severity: insight.severity }
        break
      }
    }
  })
  const visible = rows.slice(0, maxRows)
  const hiddenRows = rows.length - visible.length

  const durations = visible.map((row) => formatMs(row.duration) + (row.running ? '+' : ''))
  const durWidth = Math.max(...durations.map(stringWidth))
  const markerWidth = Math.max(
    0,
    ...visible.map((r) => (r.marker ? ` [${r.marker.number}]`.length : 0)),
  )
  const longestLabel = Math.max(...visible.map((r) => stringWidth(r.prefix + labelText(r))))
  let labelWidth = Math.min(longestLabel, Math.floor(width * 0.4))
  labelWidth = Math.max(Math.min(10, longestLabel), labelWidth)
  let barWidth = width - labelWidth - 1 - durWidth - 2 - markerWidth
  if (barWidth < 20) {
    labelWidth = Math.max(8, labelWidth - (20 - barWidth))
    barWidth = Math.max(10, width - labelWidth - 1 - durWidth - 2 - markerWidth)
  }
  const scale = barWidth / total
  const gutter = ' '.repeat(labelWidth + 1 + durWidth + 2)

  const lines: string[] = []
  lines.push(header(report, p, width))
  lines.push(gutter + p.dim(axis(total, barWidth)))
  visible.forEach((row, i) => {
    const label = styleLabel(row, labelWidth, p)
    const duration = padStart(durations[i] as string, durWidth)
    const bar = drawBar(row, scale, barWidth, p)
    const marker = row.marker
      ? (row.marker.severity === 'warn' ? p.yellow : p.blue)(` [${row.marker.number}]`)
      : ''
    const dur = row.span?.critical || row.running ? duration : p.dim(duration)
    lines.push(`${label} ${dur}  ${bar}${marker}`.trimEnd())
  })
  if (hiddenRows > 0) lines.push(p.dim(`… ${hiddenRows} more rows (raise maxRows to see them)`))
  if (report.dropped > 0) {
    lines.push(p.yellow(`… ${report.dropped} spans were not recorded because maxSpans was reached`))
  }

  if (shownInsights.length > 0) {
    lines.push('')
    shownInsights.forEach((insight, index) => {
      lines.push(...formatInsight(insight, index + 1, shownInsights.length, width, p, color))
    })
    const more = report.insights.length - shownInsights.length
    if (more > 0) lines.push(p.dim(`    +${more} more in report.insights`))
  }
  return lines.join('\n')
}

function header(report: TraceReport, p: Palette, width: number): string {
  const http = report.spans.filter((s) => s.kind === 'http').length
  const count = report.spans.length - 1
  const factList = [`${count} span${count === 1 ? '' : 's'}`]
  if (http > 0) factList.push(`${http} HTTP`)
  const duration = formatMs(report.duration)
  const failed = report.status === 'error' ? '  ✖ failed' : ''
  let facts = `  ${factList.join(' · ')}`
  const fixed = 'awaitfall '.length + 2 + duration.length + failed.length
  if (fixed + stringWidth(report.name) + facts.length > width) facts = ''
  const name = truncate(report.name, Math.max(1, width - fixed - facts.length))
  return (
    `${p.dim('awaitfall')} ${p.bold(name)}  ${p.bold(duration)}${p.dim(facts)}` +
    (failed ? `  ${p.red(failed.trim())}` : '')
  )
}

function buildRows(report: TraceReport, fold: number): { rows: Row[]; rowOf: Map<number, number> } {
  const children = new Map<number, SpanData[]>()
  for (const span of report.spans) {
    if (span.parentId === null) continue
    const list = children.get(span.parentId)
    if (list) list.push(span)
    else children.set(span.parentId, [span])
  }
  const rows: Row[] = []
  const rowOf = new Map<number, number>()
  const root = report.spans[0]
  if (!root) return { rows, rowOf }

  const claimSubtree = (span: SpanData, row: number): void => {
    const stack = [span]
    while (stack.length > 0) {
      const next = stack.pop() as SpanData
      rowOf.set(next.id, row)
      stack.push(...(children.get(next.id) ?? []))
    }
  }

  const stack: Array<{ item: Item; prefix: string; last: boolean; root: boolean }> = [
    { item: { span: root }, prefix: '', last: true, root: true },
  ]
  while (stack.length > 0) {
    const { item, prefix, last, root: isRoot } = stack.pop() as (typeof stack)[number]
    const branch = isRoot ? '' : last ? '└─ ' : '├─ '
    if ('folded' in item) {
      const start = Math.min(...item.folded.map((s) => s.start))
      const end = Math.max(...item.folded.map((s) => s.start + s.duration))
      const index = rows.length
      rows.push({
        prefix: prefix + branch,
        name: `+${item.folded.length} more ${item.label}`,
        duration: end - start,
        running: false,
        intervals: item.folded.map((s) => [s.start, s.start + s.duration]),
        folded: item.folded.length,
      })
      for (const span of item.folded) claimSubtree(span, index)
      continue
    }
    const span = item.span
    rowOf.set(span.id, rows.length)
    const status = span.kind === 'http' ? span.attrs.status : undefined
    rows.push({
      prefix: prefix + branch,
      name: span.name,
      status: typeof status === 'number' ? status : undefined,
      duration: span.duration,
      running: span.status === 'running',
      intervals: [[span.start, span.start + span.duration]],
      span,
    })
    const childPrefix = isRoot ? '' : prefix + (last ? '   ' : '│  ')
    const items = foldChildren(children.get(span.id) ?? [], fold)
    for (let i = items.length - 1; i >= 0; i--) {
      stack.push({
        item: items[i] as Item,
        prefix: childPrefix,
        last: i === items.length - 1,
        root: false,
      })
    }
  }
  return { rows, rowOf }
}

/** Collapses long runs of identical siblings (the N+1 staircase) into a single row. */
function foldChildren(kids: SpanData[], fold: number): Item[] {
  const items: Item[] = []
  const keyOf = (s: SpanData): string => `${s.kind}\u0000${normalizeName(s.name)}`
  let i = 0
  while (i < kids.length) {
    const first = kids[i] as SpanData
    const key = keyOf(first)
    let j = i + 1
    while (j < kids.length && keyOf(kids[j] as SpanData) === key) j++
    const run = kids.slice(i, j)
    if (fold > 0 && run.length > fold) {
      const keep = Math.max(1, fold - 1)
      for (const span of run.slice(0, keep)) items.push({ span })
      const rest = run.slice(keep)
      const same = rest.every((s) => s.name === first.name)
      items.push({ folded: rest, label: same ? first.name : normalizeName(first.name) })
    } else {
      for (const span of run) items.push({ span })
    }
    i = j
  }
  return items
}

function labelText(row: Row): string {
  return row.status === undefined ? row.name : `${row.name} ${row.status}`
}

function styleLabel(row: Row, width: number, p: Palette): string {
  const full = row.prefix + labelText(row)
  const text = truncate(full, width)
  const prefixLength = Math.min(row.prefix.length, text.length)
  const prefix = p.gray(text.slice(0, prefixLength))
  let rest = text.slice(prefixLength)
  const nameStyle: Style = row.folded
    ? p.gray
    : row.span?.status === 'error'
      ? p.red
      : row.running
        ? p.yellow
        : row.span?.kind === 'trace'
          ? p.bold
          : (t) => t
  if (text === full && row.status !== undefined) {
    const code = String(row.status)
    rest = rest.slice(0, rest.length - code.length)
    const statusStyle = row.status >= 500 ? p.red : row.status >= 400 ? p.yellow : p.green
    rest = nameStyle(rest) + statusStyle(code)
  } else {
    rest = nameStyle(rest)
  }
  return prefix + rest + ' '.repeat(Math.max(0, width - stringWidth(text)))
}

function drawBar(row: Row, scale: number, width: number, p: Palette): string {
  const coverage = new Float64Array(width)
  const touchesLeft = new Uint8Array(width)
  const touchesRight = new Uint8Array(width)
  for (const [startMs, endMs] of row.intervals) {
    let a = Math.min(width, Math.max(0, startMs * scale))
    let b = Math.min(width, Math.max(0, endMs * scale))
    if (b - a < 0.125) {
      b = Math.min(width, a + 0.125)
      a = Math.max(0, b - 0.125)
    }
    for (let i = Math.floor(a); i < Math.ceil(b) && i < width; i++) {
      const lo = Math.max(a, i)
      const hi = Math.min(b, i + 1)
      if (hi <= lo) continue
      coverage[i] = (coverage[i] as number) + (hi - lo)
      if (lo <= i + 1e-9) touchesLeft[i] = 1
      if (hi >= i + 1 - 1e-9) touchesRight[i] = 1
    }
  }
  let first = -1
  let last = -1
  const chars: string[] = []
  for (let i = 0; i < width; i++) {
    const c = Math.min(1, coverage[i] as number)
    let char = ' '
    if (c > 0.001) {
      if (row.running) char = '░'
      else if (c >= 0.875) char = '█'
      else if (touchesLeft[i] && touchesRight[i]) char = c >= 0.5 ? '█' : '▌'
      else if (touchesRight[i]) char = c >= 0.5 ? '▐' : '▕'
      else char = EIGHTHS[Math.min(7, Math.max(1, Math.round(c * 8)))] as string
    }
    if (char !== ' ') {
      if (first < 0) first = i
      last = i
    }
    chars.push(char)
  }
  if (first < 0) return ' '.repeat(width)
  const body = chars.slice(first, last + 1).join('')
  const span = row.span
  let style: Style
  if (row.folded) style = p.gray
  else if (span?.status === 'error') style = p.red
  else if (row.running) style = p.yellow
  else if (span?.kind === 'trace') style = p.gray
  else if (span?.kind === 'http')
    style = span.critical ? p.brightMagenta : (t) => p.dim(p.magenta(t))
  else style = span?.critical ? p.brightCyan : (t) => p.dim(p.cyan(t))
  return ' '.repeat(first) + style(body) + ' '.repeat(width - last - 1)
}

function axis(total: number, width: number): string {
  const maxTicks = Math.max(2, Math.floor(width / 10))
  const step = niceStep(total / maxTicks)
  const scale = width / total
  const out: string[] = new Array(width).fill(' ')
  let lastEnd = -2
  for (let tick = 0; tick <= total + step * 1e-9; tick += step) {
    const label = tickLabel(tick, step)
    const col = Math.round(tick * scale)
    if (col <= lastEnd + 1 || col + label.length > width) continue
    for (let k = 0; k < label.length; k++) out[col + k] = label[k] as string
    lastEnd = col + label.length - 1
  }
  return out.join('').trimEnd()
}

function niceStep(raw: number): number {
  if (!(raw > 0)) return 1
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 5, 10]) if (m * magnitude >= raw) return m * magnitude
  return 10 * magnitude
}

function tickLabel(tick: number, step: number): string {
  if (tick === 0) return '0'
  if (step >= 1000) return `${Number((tick / 1000).toFixed(step % 1000 === 0 ? 0 : 1))}s`
  if (step >= 1) return `${Math.round(tick)}ms`
  const decimals = Math.min(6, Math.ceil(-Math.log10(step)))
  return `${tick.toFixed(decimals)}ms`
}

function formatInsight(
  insight: Insight,
  number: number,
  count: number,
  width: number,
  p: Palette,
  color: boolean,
): string[] {
  const tag = padStart(`[${number}]`, String(count).length + 2)
  const title =
    insight.kind === 'repeated' && insight.severity === 'warn' ? 'N+1' : TITLES[insight.kind]
  const titleWidth = 11
  const indent = stringWidth(tag) + 1 + titleWidth + 1
  const tone = insight.severity === 'warn' ? p.yellow : p.blue
  const lines = wrapMessage(insight.message, Math.max(20, width - indent), color, p)
  return lines.map((line, i) =>
    i === 0
      ? `${tone(tag)} ${tone(padEnd(title, titleWidth))} ${line}`
      : `${' '.repeat(indent)}${line}`,
  )
}

/** Word-wraps a message; in color mode, `code` spans become bold instead of keeping backticks. */
function wrapMessage(message: string, width: number, color: boolean, p: Palette): string[] {
  let text = ''
  const codeMask: boolean[] = []
  message.split('`').forEach((part, i) => {
    const isCode = i % 2 === 1
    const chunk = isCode && !color ? `\`${part}\`` : part
    for (const char of chunk) {
      text += char
      for (let k = 0; k < char.length; k++) codeMask.push(isCode)
    }
  })

  const lines: Array<[number, number]> = []
  let lineStart = -1
  let lineEnd = -1
  let index = 0
  for (const word of text.split(' ')) {
    const start = index
    index += word.length + 1
    if (!word) continue
    const end = start + word.length
    if (lineStart >= 0 && stringWidth(text.slice(lineStart, end)) <= width) {
      lineEnd = end
      continue
    }
    if (lineStart >= 0) lines.push([lineStart, lineEnd])
    let cursor = start
    while (stringWidth(text.slice(cursor, end)) > width) {
      lines.push([cursor, cursor + width])
      cursor += width
    }
    lineStart = cursor
    lineEnd = end
  }
  if (lineStart >= 0) lines.push([lineStart, lineEnd])

  return lines.map(([from, to]) => {
    if (!color) return text.slice(from, to)
    let out = ''
    let runStart = from
    for (let i = from + 1; i <= to; i++) {
      if (i === to || codeMask[i] !== codeMask[runStart]) {
        const piece = text.slice(runStart, i)
        out += codeMask[runStart] ? p.bold(piece) : piece
        runStart = i
      }
    }
    return out
  })
}
