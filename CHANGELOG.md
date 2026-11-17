# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-17

First release.

### Added

- `trace()` records spans through `await`s, `Promise.all` and callbacks with AsyncLocalStorage, and prints a terminal waterfall when the trace ends.
- `span()`, `wrap()` and `instrument()` mark the steps to measure. `span()` just calls through when no trace is active.
- Outgoing HTTP is recorded automatically (fetch/undici, `node:http`/`node:https`, and libraries built on them) through Node's diagnostics channels. Nothing is monkey-patched. Query strings are dropped from span names.
- Insights: N+1 loops (`repeated`), siblings that could run in parallel (`sequential`), missing `await`s (`unawaited`), the critical-path `bottleneck`, and errors that were caught and swallowed (`error`).
- Critical-path highlighting, folding of repeated siblings, and output that fits the terminal width.
- `profile()` returns reports in tests without printing them.
- `trace.start()` for hook-based frameworks, plus `middleware()` for Express and Connect.
- `toChromeTrace()` exports traces for Perfetto, `chrome://tracing` and speedscope.
- `configure()` sets global defaults. `AWAITFALL=0` turns tracing off.
- ESM and CommonJS builds with type declarations. The `node` entry uses static imports, and the default entry works in runtimes without `node:*` modules.

[Unreleased]: https://github.com/Daksh-Bole/Npm-package-/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Daksh-Bole/Npm-package-/releases/tag/v0.1.0
