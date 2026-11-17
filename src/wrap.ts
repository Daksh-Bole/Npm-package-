import { execute, span } from './core'
import { currentRecord, openSpan } from './recorder'

type AnyFunction = (...args: any[]) => any

/**
 * Returns a drop-in replacement for `fn` that records a span every time it is called inside a
 * trace. Arguments, `this`, return values and errors pass through untouched.
 *
 * @example
 * const getUser = wrap('db.getUser', rawGetUser)
 */
export function wrap<F extends AnyFunction>(name: string, fn: F): F
export function wrap<F extends AnyFunction>(fn: F): F
export function wrap<F extends AnyFunction>(nameOrFn: string | F, maybeFn?: F): F {
  const fn = typeof nameOrFn === 'function' ? nameOrFn : maybeFn
  if (typeof fn !== 'function') {
    throw new TypeError(
      `[awaitfall] wrap() expects a function${typeof nameOrFn === 'string' ? ' as the second argument' : ''}, got ${fn === null ? 'null' : typeof fn}`,
    )
  }
  if (typeof nameOrFn !== 'string' && typeof nameOrFn !== 'function') {
    throw new TypeError(`[awaitfall] wrap(name, fn) expects a string name, got ${typeof nameOrFn}`)
  }
  const name = (typeof nameOrFn === 'string' ? nameOrFn : '') || fn.name || 'anonymous'
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    return span(name, () => fn.apply(this, args))
  }
  Object.defineProperty(wrapped, 'name', { value: fn.name, configurable: true })
  Object.defineProperty(wrapped, 'length', { value: fn.length, configurable: true })
  return wrapped as unknown as F
}

/** Options for `instrument()`. */
export interface InstrumentOptions {
  /** Prefix for span names: `<name>.<method>`. Default: the object's class name. */
  name?: string
  /**
   * Also record methods that return synchronously. Default `false`: only calls that return a
   * promise become spans, so getters, event emitters and builders don't flood the waterfall.
   */
  sync?: boolean
}

/**
 * Returns a proxy of `target` whose methods record spans when called inside a trace. Ideal for
 * database clients, SDKs and repositories: one line, every call shows up.
 *
 * @example
 * const db = instrument(pool, 'pg')       // db.query(...) → span "pg.query"
 */
export function instrument<T extends object>(
  target: T,
  nameOrOptions?: string | InstrumentOptions,
): T {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
    throw new TypeError(
      `[awaitfall] instrument() expects an object, got ${target === null ? 'null' : typeof target}`,
    )
  }
  const options: InstrumentOptions =
    typeof nameOrOptions === 'string' ? { name: nameOrOptions } : (nameOrOptions ?? {})
  const prefix = options.name || defaultName(target)
  const wrappers = new Map<PropertyKey, { original: AnyFunction; wrapper: AnyFunction }>()

  const proxy: T = new Proxy(target, {
    get(obj, key, receiver) {
      // Use the real object as the receiver so getters relying on private fields keep working.
      const value: unknown = Reflect.get(obj, key, receiver === proxy ? obj : receiver)
      if (
        typeof value !== 'function' ||
        typeof key === 'symbol' ||
        key === 'constructor' ||
        key === 'then'
      ) {
        return value
      }
      const cached = wrappers.get(key)
      if (cached && cached.original === value) return cached.wrapper
      const original = value as AnyFunction
      const label = `${prefix}.${key}`
      const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        const self = this === proxy ? obj : this
        const parent = currentRecord()
        if (!parent) return original.apply(self, args)
        const record = openSpan(parent, label, 'span')
        if (!record) return original.apply(self, args)
        return execute(record, () => original.apply(self, args), { discardSync: !options.sync })
      }
      Object.defineProperty(wrapper, 'name', { value: original.name, configurable: true })
      wrappers.set(key, { original, wrapper })
      return wrapper
    },
  })
  return proxy
}

function defaultName(target: object): string {
  if (typeof target === 'function') return target.name || 'fn'
  const ctor = (target as { constructor?: { name?: string } }).constructor
  return ctor && ctor !== Object && ctor.name ? ctor.name : 'object'
}
