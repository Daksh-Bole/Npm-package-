/**
 * Everything runtime-specific lives behind this interface, so the core works in Node.js,
 * Bun, Deno, edge runtimes and browsers. The `node` entry point wires in AsyncLocalStorage and
 * diagnostics_channel with static imports; the default entry point probes for them at runtime.
 */

/** Minimal AsyncLocalStorage-like API used for implicit parent tracking. */
export interface ContextBackend<T> {
  run<R>(store: T, fn: () => R): R
  getStore(): T | undefined
}

/** Minimal `node:diagnostics_channel` surface used for automatic HTTP capture. */
export interface DiagnosticsChannelLike {
  subscribe?: (name: string, fn: (message: any, name: string | symbol) => void) => void
  channel: (name: string) => { subscribe(fn: (message: any, name: string | symbol) => void): void }
}

interface StreamLike {
  isTTY?: boolean
  columns?: number
  write(chunk: string): unknown
}

interface ProcessLike {
  env?: Record<string, string | undefined>
  stderr?: StreamLike
  stdout?: StreamLike
  getBuiltinModule?: (id: string) => any
}

export interface Platform {
  /** Creates the context backend, or `undefined` when the runtime has no AsyncLocalStorage. */
  createContext<T>(): ContextBackend<T> | undefined
  diagnostics: DiagnosticsChannelLike | undefined
  env(name: string): string | undefined
  write(text: string): void
  color(): boolean
  width(): number
}

type AlsConstructor = new <T>() => ContextBackend<T>

const proc = (): ProcessLike | undefined => (globalThis as { process?: ProcessLike }).process

export function createPlatform(
  Als: AlsConstructor | undefined,
  diagnostics: DiagnosticsChannelLike | undefined,
): Platform {
  return {
    createContext: <T>() => (Als ? new Als<T>() : undefined),
    diagnostics,
    env: (name) => proc()?.env?.[name],
    write(text) {
      const stderr = proc()?.stderr
      if (stderr && typeof stderr.write === 'function') stderr.write(text + '\n')
      else console.log(text)
    },
    color() {
      const env = proc()?.env ?? {}
      if (env.NO_COLOR) return false
      if (env.FORCE_COLOR !== undefined)
        return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false'
      const stderr = proc()?.stderr
      return Boolean(stderr?.isTTY) && env.TERM !== 'dumb'
    },
    width() {
      const p = proc()
      const columns = p?.stderr?.columns || p?.stdout?.columns
      return columns ? Math.max(60, Math.min(200, columns)) : 100
    },
  }
}

/** Finds AsyncLocalStorage and diagnostics_channel without a static import of `node:*`. */
export function probePlatform(): Platform {
  const g = globalThis as { AsyncLocalStorage?: AlsConstructor }
  let Als: AlsConstructor | undefined = g.AsyncLocalStorage
  let diagnostics: DiagnosticsChannelLike | undefined
  const p = proc()
  if (p && typeof p.getBuiltinModule === 'function') {
    try {
      Als = Als ?? p.getBuiltinModule('node:async_hooks')?.AsyncLocalStorage
      diagnostics = p.getBuiltinModule('node:diagnostics_channel') ?? undefined
    } catch {
      // Not available in this runtime: fall back to explicit parents only.
    }
  }
  return createPlatform(Als, diagnostics)
}

let current: Platform | undefined

export function setPlatform(platform: Platform): void {
  current = platform
}

export function getPlatform(): Platform {
  if (!current) current = probePlatform()
  return current
}
