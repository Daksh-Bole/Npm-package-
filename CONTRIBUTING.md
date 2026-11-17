# Contributing to awaitfall

Thanks for helping! Bug reports, ideas, docs fixes and code are all welcome.

## Setup

You need Node.js 22.12+ or 24+ to develop. The published package itself supports Node 18+.

```bash
npm install
npm run check   # typecheck, lint, tests, build, smoke tests, package validation
```

Useful scripts:

| Script                            | What it does                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `npm test`                        | Unit and integration tests (Vitest)                                                      |
| `npm run test:coverage`           | Tests with a coverage report                                                             |
| `npm run typecheck`               | `tsc --noEmit` over sources and tests                                                    |
| `npm run lint` / `npm run format` | ESLint and Prettier                                                                      |
| `npm run build`                   | Builds ESM, CommonJS and `.d.ts` files into `dist/` (tsup)                               |
| `npm run test:smoke`              | Runs the built package through its public `exports` (ESM, CJS, default entry)            |
| `npm run lint:pkg`                | `publint` and `attw` (are the types wrong?)                                              |
| `npm run demo`                    | Runs `examples/demo.mjs` (build first)                                                   |
| `npm run screenshot`              | Regenerates `docs/demo.png` from the demo's real output (needs Playwright with Chromium) |

## Architecture

```
src/
  node.ts        Entry for the "node" export condition: wires in AsyncLocalStorage and
                 diagnostics_channel with static imports.
  index.ts       Entry for everything else (browsers, edge): finds them at runtime, if they exist.
  api.ts         The public surface, shared by both entries.
  platform.ts    Everything runtime-specific: context backend, output stream, color, width, env.
  recorder.ts    Internal span records, the current-span context, open/close bookkeeping.
  core.ts        trace(), trace.start(), span(), profile(), configure(): argument parsing,
                 sync/async handling, delivering reports.
  wrap.ts        wrap() and instrument() (a Proxy that turns async methods into spans).
  http.ts        Turns diagnostics_channel events (undici + node:http) into HTTP spans.
  middleware.ts  Connect/Express middleware built on trace.start().
  report.ts      Converts finished records into the public, JSON-safe TraceReport.
  analyze.ts     Self time, critical path and the insights. Pure functions over SpanData[].
  render.ts      The terminal waterfall: layout, folding, bars, axis, insight text.
  chrome.ts      Export to the Chrome Trace Event Format (Perfetto, chrome://tracing).
  format.ts      Small helpers: durations, name normalization, string widths.
```

Principles that shape the code:

1. **Never change user-visible behavior.** Return values, thrown errors and sync-versus-async behavior pass through untouched. Problems inside awaitfall are reported on stderr and never thrown into user code.
2. **Zero runtime dependencies.** Anything needed is small enough to write and test here.
3. **Hints, not verdicts.** Insights only state what the timing shows. Anything that depends on information awaitfall can't see, such as data dependencies, is phrased conditionally.
4. **Cheap when idle.** `span()` outside a trace costs one AsyncLocalStorage lookup.

### Adding an insight

Insights live in `src/analyze.ts` and work on plain `SpanData[]`, so they're easy to test with the `spansFrom()` helper in `test/helpers.ts`, with no timers or mocks involved. Each new insight needs tests for when it should fire **and** for when it must stay quiet. False positives cost more trust than missed findings.

### Changing the output

`test/render.test.ts` contains an inline snapshot of a full waterfall. If you change the layout on purpose, run `npx vitest run test/render.test.ts -u`, check the diff by eye, and regenerate `docs/demo.png` with `npm run screenshot`.

## Good first issues

- An insight for **retries**: the same operation fails and then succeeds under one parent.
- Show `span.set()` attributes in the waterfall (opt-in), e.g. row counts next to queries.
- A `--json` style option: `write` the report as JSON lines for log pipelines.
- A Bun and Deno smoke-test job in CI.
- More examples: Next.js route handlers, Prisma, a CLI build script.

## Pull requests

- Keep changes focused, and include tests.
- Run `npm run check` before pushing.
- Add an entry under `## [Unreleased]` in `CHANGELOG.md` for anything users will notice.
- By contributing, you agree that your contributions are licensed under the MIT License.
