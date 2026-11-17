# Launch kit

Everything needed to launch awaitfall: repository setup, the demo, and drafts of the launch posts. Fill in the links after publishing, and edit the drafts so they sound like you.

## Positioning

- **Tagline:** See where your async time goes.
- **One-liner:** A waterfall of your awaits, right in your terminal, with hints that catch N+1 loops, missed `Promise.all`s and forgotten `await`s.
- **Short pitch:** Wrap any async function in `trace()` and get a terminal waterfall of everything it awaited, including HTTP calls captured automatically, plus a short list of what to fix.
- **Natural sharing mechanism:** the output is a picture. People screenshot it into pull requests and team chats ("found an N+1 in checkout"), and anyone who sees it can reproduce it with one line.

What not to claim: no performance-gain numbers for anyone's app, no "first ever", and no comparisons that put other projects down. Let the screenshot do the work.

## Before launch

1. **Repository:** rename the GitHub repository to `awaitfall` (Settings → General). GitHub redirects the old URL, but update the URLs in `package.json`, `README.md` and `CHANGELOG.md` anyway. Add the description "See where your async time goes: a terminal waterfall of your awaits with N+1 / missing-await hints" and the topics `nodejs`, `typescript`, `async`, `performance`, `tracing`, `developer-tools`, `n-plus-one`, `cli`.
2. **Social preview:** upload `docs/demo.png` under Settings → Social preview.
3. **GIF:** record `docs/demo.gif` with [VHS](https://github.com/charmbracelet/vhs) (`npm run build && vhs docs/demo.tape`) and consider putting it at the top of the README.
4. **Issues:** open 3–5 labeled `good first issue` from the list in CONTRIBUTING.md, so visitors who want to help have somewhere to start.
5. **Publish:** follow [PUBLISHING.md](./PUBLISHING.md), then tag the release on GitHub and paste in the changelog.
6. **Check:** test the README instructions in a fresh folder, on a phone and in dark mode.

## Demo script (30–45 seconds)

1. Show an ordinary-looking checkout function and say "this endpoint takes 350ms and I don't know why".
2. Add `import { trace } from 'awaitfall'` and wrap the call in `trace('checkout', …)`.
3. Run it. The waterfall appears, with findings 1–4 underneath.
4. Fix the N+1 (one batched call) and add the missing `Promise.all`.
5. Run it again and show the shorter waterfall and the smaller number.
6. End card: `npm i awaitfall` and the repository URL.

## X / Twitter

> Your async code is slow because it waits, not because it computes.
>
> I built awaitfall: wrap a function in `trace()` and get a waterfall of every await in your terminal, plus hints for:
>
> • N+1 loops
> • calls that could be Promise.all'd
> • forgotten awaits
> • the real bottleneck
>
> Zero deps, zero config. HTTP calls show up automatically.
>
> npm i awaitfall
> [link] [screenshot or GIF]

Follow-up reply: a before/after of a real fix, or the `profile()` snippet that fails CI on N+1 queries.

## Reddit (r/node, r/javascript, r/typescript; check each subreddit's self-promotion rules first)

**Title:** I made a tiny tool that draws a waterfall of your awaits in the terminal and points out N+1 loops and missing awaits

**Body:**

> Most slow Node code I've debugged wasn't CPU-bound. It was waiting: awaits in a loop, two independent calls run one after the other, a fire-and-forget promise that turned out to matter. CPU profilers don't show waiting, and setting up OpenTelemetry + Jaeger to answer "why is this function slow?" felt like too much.
>
> So I wrote **awaitfall**. You wrap a function:
>
> ```js
> await trace('checkout', () => checkout(cartId))
> ```
>
> and it prints a waterfall of everything that function awaited, with nesting, overlap and the critical path highlighted. `fetch`/axios/`node:http` calls appear automatically (through Node's diagnostics channels, no monkey-patching). Then it lists findings like "`db.getProduct` ran 6× one after another (that's an N+1)" or "`sendReceipt` was still running when `checkout` finished: missing await?"
>
> There's also `profile()` for tests, so you can assert an endpoint has no N+1 in CI, plus Express middleware and Perfetto export.
>
> Zero dependencies, ESM + CJS, types included. It's v0.1, so I'd really like feedback on false positives in the hints and on what else it should detect.
>
> [GitHub link] · [npm link]

## Show HN

**Title:** Show HN: Awaitfall – a terminal waterfall of your awaits, with N+1 and missing-await hints

**Text:**

> awaitfall is a small Node.js library. You wrap a function in `trace()`, and when it finishes it prints a waterfall of the spans it awaited, with HTTP requests captured automatically through `diagnostics_channel`. It then analyzes the timing: repeated sequential calls under one parent (N+1), sibling stages that ran back-to-back (a possible missed Promise.all, phrased as a question since it can't see data dependencies), work that outlived its parent (a missing await), and the span with the most self time on the critical path.
>
> I wanted something between `console.time` and a full OpenTelemetry setup, for the "why is this one function slow?" moments, and for CI checks such as "this endpoint must not issue queries in a loop".
>
> Implementation notes: AsyncLocalStorage for parent tracking, no monkey-patching, zero dependencies, about 10 KB min+gzip. Outside an active trace `span()` is a passthrough (a few ns), so instrumentation can stay in production code.
>
> Limitations: Node-centric (browsers only get explicit handles), the insights are heuristics, and database queries only show up if you wrap the client (`instrument(pool)`) until drivers publish diagnostics channels.
>
> [GitHub link]

## LinkedIn

> I just released my first open-source developer tool: **awaitfall**.
>
> It answers a question every backend developer asks: "where did the time go?" Wrap an async function, and it prints a waterfall of everything that function waited on, then tells you what to fix: N+1 query loops, calls that could run in parallel, promises nobody awaited, and the real bottleneck.
>
> What I focused on:
> ✅ One line to start, zero dependencies
> ✅ HTTP calls captured automatically, no monkey-patching
> ✅ Test helpers, so performance regressions fail CI
> ✅ Careful wording: hints say "if", not "you must"
>
> It's MIT-licensed and on npm as `awaitfall`. Feedback and contributions are very welcome. [link]
>
> #nodejs #javascript #typescript #opensource #performance

## Developer-focused demo ideas

- **Blog post:** "Finding an N+1 in 10 seconds without an APM": the checkout example, then the fix, then a `profile()` test that guards it.
- **Before/after GIF:** the same endpoint before and after `Promise.all`, with the waterfall visibly shortening.
- **Live stream / talk:** trace a popular open-source project's slow test setup and find something real (with the maintainers' consent before posting results).

## Measuring the launch honestly

Track npm weekly downloads, GitHub stars, issues opened by people you don't know, and comments that mention a real bug found. That last one is the signal that matters. Don't buy stars, post fake testimonials, or ask friends to upvote: Hacker News and Reddit detect and penalize vote rings.
