import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlatform, probePlatform } from '../src/platform'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('platform', () => {
  it('finds AsyncLocalStorage and diagnostics_channel at runtime in Node.js', () => {
    const platform = probePlatform()
    expect(platform.createContext()).toBeDefined()
    expect(platform.diagnostics).toBeDefined()
  })

  it('detects color support from NO_COLOR, FORCE_COLOR and the TTY', () => {
    const platform = createPlatform(undefined, undefined)
    vi.stubEnv('NO_COLOR', '1')
    vi.stubEnv('FORCE_COLOR', '1')
    expect(platform.color()).toBe(false)
    vi.stubEnv('NO_COLOR', '')
    expect(platform.color()).toBe(true)
    vi.stubEnv('FORCE_COLOR', '0')
    expect(platform.color()).toBe(false)
    vi.unstubAllEnvs()
    delete process.env.FORCE_COLOR
    delete process.env.NO_COLOR
    const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY')
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true })
    try {
      vi.stubEnv('TERM', 'xterm-256color')
      expect(platform.color()).toBe(true)
      vi.stubEnv('TERM', 'dumb')
      expect(platform.color()).toBe(false)
    } finally {
      if (tty) Object.defineProperty(process.stderr, 'isTTY', tty)
      else delete (process.stderr as { isTTY?: boolean }).isTTY
    }
  })

  it('clamps the terminal width and falls back to 100 columns', () => {
    const platform = createPlatform(undefined, undefined)
    const set = (stream: NodeJS.WriteStream, columns: number | undefined) =>
      Object.defineProperty(stream, 'columns', { value: columns, configurable: true })
    const before = [process.stderr.columns, process.stdout.columns]
    try {
      set(process.stderr, 30)
      expect(platform.width()).toBe(60)
      set(process.stderr, 500)
      expect(platform.width()).toBe(200)
      set(process.stderr, undefined)
      set(process.stdout, undefined)
      expect(platform.width()).toBe(100)
    } finally {
      set(process.stderr, before[0])
      set(process.stdout, before[1])
    }
  })

  it('writes to stderr with a trailing newline', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    createPlatform(undefined, undefined).write('hello')
    expect(write).toHaveBeenCalledWith('hello\n')
  })

  it('works without any context backend', () => {
    expect(createPlatform(undefined, undefined).createContext()).toBeUndefined()
  })
})
