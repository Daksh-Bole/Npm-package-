# How awaitfall was chosen

This document records the idea discovery, validation and product design behind awaitfall: the ideas considered, how they were scored, what already exists, and why this one was built. Research was done in November 2026 against the npm registry and the web. Download numbers are monthly figures from the npm search API at that time.

## 1. Ideas considered

Each idea is scored from 1 to 10 per criterion, then weighted: uniqueness 20%, usefulness 20%, reusability 15%, adoption potential 15%, demo/viral potential 15%, feasibility 10%, extensibility 5%.

| #   | Idea                                                                                                        | Uniq | Use | Reuse | Adopt | Demo | Feas | Ext | **Score** |
| --- | ----------------------------------------------------------------------------------------------------------- | ---: | --: | ----: | ----: | ---: | ---: | --: | --------: |
| 1   | **Async waterfall tracer with automatic insights** (N+1, missed `Promise.all`, missing `await`, bottleneck) |    8 |   9 |     9 |     8 |    9 |    8 |   9 |  **8.55** |
| 2   | API response shape-drift sentinel: learns response shapes in development and warns when they change         |    7 |   7 |     7 |     6 |    6 |    7 |   8 |      6.75 |
| 3   | "Network tab for Node": outgoing HTTP inspector in the terminal                                             |    5 |   7 |     7 |     6 |    7 |    8 |   6 |      6.50 |
| 4   | Python icecream-style `dbg(x)` that prints the expression's source text                                     |    4 |   6 |     8 |     7 |    7 |    6 |   5 |      6.15 |
| 5   | Record-to-test: capture real calls in development and generate unit tests                                   |    7 |   6 |     6 |     5 |    7 |    4 |   7 |      6.05 |
| 6   | Config typo guard: a Proxy that throws "did you mean `database`?" on unknown keys                           |    6 |   5 |     7 |     5 |    6 |    9 |   4 |      6.00 |
| 7   | Mutation detective: who mutated this object, with stack and diff                                            |    6 |   6 |     6 |     5 |    6 |    8 |   5 |      6.00 |
| 8   | Secret redaction for logs by pattern (JWTs, cloud keys, Stripe keys)                                        |    4 |   7 |     8 |     6 |    4 |    8 |   6 |      6.00 |
| 9   | Runtime type-from-value: print a TypeScript type or Zod schema for any value                                |    4 |   6 |     7 |     6 |    6 |    8 |   6 |      5.95 |
| 10  | Event-loop blocking pinpointer with stack traces                                                            |    5 |   7 |     6 |     6 |    6 |    5 |   6 |      5.90 |
| 11  | Startup import-cost tree: which `import` makes the app slow to boot                                         |    5 |   6 |     6 |     5 |    7 |    7 |   5 |      5.85 |
| 12  | `.env` drift checker (`.env` vs `.env.example` vs `process.env.X` usage)                                    |    3 |   7 |     8 |     6 |    4 |    9 |   5 |      5.85 |
| 13  | Unsettled-promise detector ("this promise never resolved, created here")                                    |    7 |   6 |     6 |     5 |    5 |    5 |   6 |      5.80 |
| 14  | Flaky-test fingerprinting (detects timing and order dependence)                                             |    6 |   7 |     6 |     5 |    5 |    4 |   6 |      5.70 |
| 15  | React stale-closure detector                                                                                |    7 |   6 |     5 |     5 |    6 |    3 |   5 |      5.55 |
| 16  | Structured-concurrency scopes (cancel siblings on failure)                                                  |    4 |   7 |     7 |     5 |    3 |    7 |   6 |      5.45 |
| 17  | Async-context-grouped console (logs grouped per request)                                                    |    6 |   5 |     6 |     4 |    6 |    6 |   5 |      5.45 |
| 18  | AI commit-message or code-explainer CLI                                                                     |    2 |   6 |     6 |     6 |    5 |    8 |   5 |      5.20 |

Ideas 4, 8, 9, 12 and 16 lost most points on uniqueness: mature alternatives exist (`debug`/icecream ports, pino redaction, quicktype, dotenv-safe/dotenv-linter, effection). Ideas 5, 14 and 15 lost on feasibility: doing them well needs deep code analysis.

## 2. Competitive analysis for the winner

| Existing option                                                         | What it does                                                             | Gap                                                                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `console.time` / `time-span`                                            | Flat timers                                                              | No nesting, overlap or analysis                                                                                                     |
| CPU profilers: `--cpu-prof`, 0x, `@platformatic/flame`, Clinic.js Flame | CPU flamegraphs                                                          | Show CPU time, not waiting. Most async latency is waiting.                                                                          |
| Clinic.js Bubbleprof (`clinic`, ~314k/mo)                               | Visualizes async operations                                              | Heavy, whole-process, HTML output. The last npm release was in June 2023.                                                           |
| OpenTelemetry SDK + Jaeger/Tempo, or `otel-tui`/`otel-desktop-viewer`   | Full tracing with a UI                                                   | Needs an SDK, exporters and a collector or separate viewer binary. Built for production observability, not a 10-second local check. |
| `opentelemetry-exporter-console-pretty`                                 | Prettier console output for OTel spans                                   | Requires the OTel SDK. No insights. Last published July 2023.                                                                       |
| `why-is-node-running` (~605M/mo)                                        | Explains why a process won't exit                                        | Different problem. Its success shows that "why is X" developer tools are in demand.                                                 |
| `why-slow` (12 downloads/mo)                                            | CLI hook that reports event-loop blocking and sync I/O                   | Flat report, process-wide, no per-operation waterfall                                                                               |
| `why-api-slow`                                                          | Express middleware: DB/HTTP/app time breakdown, repeated-query detection | Express-only, category totals instead of a span tree, monkey-patches `fetch`. Its own README calls it an untested first build.      |
| `qguard` (~9k/mo), `@7nohe/adonis-bullet`, DexterJS                     | N+1 detection at the driver or ORM level                                 | Database-only, no general async picture                                                                                             |
| `critpath`                                                              | Critical-path waterfall for GitHub Actions CI runs                       | Different domain (CI pipelines), but the same visual idea. It suggests developers like terminal waterfalls.                         |

**Conclusion.** The parts exist separately: tracing, N+1 detection, async visualization. None of the packages found combines them into a framework-agnostic, zero-dependency library that (a) works in scripts, tests, CLIs and servers, (b) captures HTTP without monkey-patching, (c) shows a wall-clock waterfall with the critical path in the terminal, and (d) explains what to fix. That combination is awaitfall's reason to exist. This isn't a claim that nobody has had the idea. The closest attempts (`why-slow`, `why-api-slow`) suggest the demand is real.

## 3. Product design

|                     |                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Name**            | `awaitfall` (await + waterfall). Short, easy to spell, and it describes the output. `awaitfall` and `await-fall` were both unregistered on npm when checked (November 17, 2026). `whyslow` was rejected because npm's similarity rules would likely block it next to the existing `why-slow`.                |
| **One-liner**       | See where your async time goes. A waterfall of your awaits in the terminal, with hints for N+1 loops, missed `Promise.all`s and forgotten `await`s.                                                                                                                                                          |
| **Problem**         | Slow async code is usually slow because of waiting: sequential awaits, loops of queries, one slow dependency. Existing tools show CPU time, flat numbers, or need a tracing stack.                                                                                                                           |
| **Audience**        | Node.js and TypeScript developers working on API handlers, scripts, CLIs, build tooling, test suites and serverless functions.                                                                                                                                                                               |
| **Value**           | One wrapper gives you a picture of where time went and a short list of what to fix.                                                                                                                                                                                                                          |
| **Differentiator**  | Wall-clock waterfall with the critical path, plus automatic, explained insights. Zero config, zero dependencies, no monkey-patching.                                                                                                                                                                         |
| **Killer features** | 1. One-line `trace()`, with HTTP captured automatically. 2. Insights: N+1, sequential, unawaited, bottleneck, swallowed errors. 3. `profile()` for CI assertions ("no N+1 on this endpoint"). 4. `instrument()` to cover a whole DB client or SDK in one line. 5. Chrome/Perfetto export when you need more. |
| **Workflow**        | Something feels slow → wrap it in `trace()` → read the waterfall → fix the finding → add a `profile()` assertion so it stays fixed.                                                                                                                                                                          |
| **Use cases**       | Slow API endpoints, slow test setup, build scripts, data imports, serverless cold paths, checking that a refactor really parallelized things.                                                                                                                                                                |
| **Advantage**       | Lower friction than OpenTelemetry, more actionable than profilers, more general than ORM-specific N+1 tools.                                                                                                                                                                                                 |

## 4. Sharing mechanism

The output is a picture. A colored waterfall with numbered findings works well as a screenshot in a pull request, a Slack thread or a post ("look at this N+1 in our checkout"). Spreading it costs nothing: the person you show it to can reproduce it with one line of code.
