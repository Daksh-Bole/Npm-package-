/** Node.js, Bun and Deno entry point (the `node` export condition). */
import { AsyncLocalStorage } from 'node:async_hooks'
import * as diagnostics from 'node:diagnostics_channel'
import { createPlatform, setPlatform } from './platform'
import type { DiagnosticsChannelLike } from './platform'

setPlatform(createPlatform(AsyncLocalStorage, diagnostics as unknown as DiagnosticsChannelLike))

export * from './api'
