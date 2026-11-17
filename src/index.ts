/**
 * Default entry point (browsers, edge runtimes, bundlers that don't use the `node` condition).
 * AsyncLocalStorage and diagnostics_channel are discovered at runtime when the platform has them;
 * otherwise use the explicit handle: `trace('x', async (t) => { await t.span('y', fn) })`.
 */
import { probePlatform, setPlatform } from './platform'

setPlatform(probePlatform())

export * from './api'
