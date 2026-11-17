/** Formats milliseconds for humans: `0.42ms`, `4.2ms`, `412ms`, `1.24s`, `41.2s`, `2m05s`. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms'
  if (ms < 0.995) return `${ms.toFixed(2)}ms`
  if (ms < 9.95) return `${ms.toFixed(1)}ms`
  if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 9.995) return `${s.toFixed(2)}s`
  if (s < 59.95) return `${s.toFixed(1)}s`
  const minutes = Math.floor(s / 60)
  const seconds = Math.floor(s % 60)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

export function formatPercent(part: number, total: number): string {
  if (total <= 0) return '0%'
  return `${Math.round((part / total) * 100)}%`
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const LONG_HEX = /(?<![0-9a-z])(?=[0-9a-f]*\d)[0-9a-f]{12,}(?![0-9a-z])/gi
const NUMBER = /(?<![A-Za-z_])\d+(?:\.\d+)?(?![A-Za-z_])/g

/**
 * Turns `GET api.dev/users/42` and `GET api.dev/users/7` into the same key, `GET api.dev/users/*`,
 * so repeated operations are recognized even when their names include ids.
 */
export function normalizeName(name: string): string {
  return name.replace(UUID, '*').replace(LONG_HEX, '*').replace(NUMBER, '*')
}

export function formatError(error: unknown): string {
  try {
    if (error instanceof Error || (error && typeof error === 'object' && 'message' in error)) {
      const { name, message } = error as { name?: unknown; message?: unknown }
      const label = typeof name === 'string' && name ? name : 'Error'
      return truncate(`${label}: ${String(message)}`, 200)
    }
    return truncate(String(error), 200)
  } catch {
    return 'Unknown error'
  }
}

/** Display width of a string in a terminal (wide CJK/emoji count as 2, combining marks as 0). */
export function stringWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0)
  return width
}

function charWidth(code: number): number {
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0
  if (
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0xfe00 && code <= 0xfe0f)
  ) {
    return 0
  }
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

/** Cuts a string to at most `width` columns, ending with `…` when shortened. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  if (stringWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const w = charWidth(char.codePointAt(0) ?? 0)
    if (used + w > width - 1) break
    out += char
    used += w
  }
  return out + '…'
}

export function padEnd(text: string, width: number): string {
  const gap = width - stringWidth(text)
  return gap > 0 ? text + ' '.repeat(gap) : text
}

export function padStart(text: string, width: number): string {
  const gap = width - stringWidth(text)
  return gap > 0 ? ' '.repeat(gap) + text : text
}
