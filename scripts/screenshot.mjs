// Regenerates docs/demo.png from the real output of examples/demo.mjs.
// Usage: npm run build && node scripts/screenshot.mjs   (needs Playwright with Chromium)
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const run = spawnSync(process.execPath, ['examples/demo.mjs'], {
  env: { ...process.env, FORCE_COLOR: '1', PORT: '3000' },
  encoding: 'utf8',
})
if (run.status !== 0) throw new Error(`demo failed:\n${run.stderr}`)
const ansi = run.stderr.trimEnd()

const COLORS = {
  31: '#ff7b72',
  32: '#7ee787',
  33: '#e3b341',
  34: '#79c0ff',
  35: '#d2a8ff',
  36: '#56d4dd',
  90: '#6e7681',
  95: '#f2c2ff',
  96: '#8ff0f7',
}
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function toHtml(text) {
  let html = ''
  let state = { bold: false, dim: false, color: null }
  // eslint-disable-next-line no-control-regex
  const pattern = /\u001b\[([0-9;]*)m/g
  let last = 0
  const flush = (chunk) => {
    if (!chunk) return
    const style = []
    if (state.color) style.push(`color:${state.color}`)
    if (state.bold) style.push('font-weight:700')
    if (state.dim) style.push('opacity:.55')
    html += style.length
      ? `<span style="${style.join(';')}">${escape(chunk)}</span>`
      : escape(chunk)
  }
  for (const match of text.matchAll(pattern)) {
    flush(text.slice(last, match.index))
    last = match.index + match[0].length
    for (const code of match[1].split(';').map(Number)) {
      if (code === 0) state = { bold: false, dim: false, color: null }
      else if (code === 1) state.bold = true
      else if (code === 2) state.dim = true
      else if (code === 22) state = { ...state, bold: false, dim: false }
      else if (code === 39) state.color = null
      else if (COLORS[code]) state.color = COLORS[code]
    }
  }
  flush(text.slice(last))
  return html
}

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 28px; background: #e9edf2; }
  .window { display: inline-block; background: #0d1117; border-radius: 12px;
    box-shadow: 0 18px 50px rgba(15, 23, 42, .35); overflow: hidden; }
  .bar { height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 16px;
    background: #161b22; color: #8b949e; font: 13px/1 'DejaVu Sans Mono', monospace; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title { margin-left: 12px; }
  pre { margin: 0; padding: 18px 22px 22px; color: #c9d1d9;
    font: 14px/1.22 'DejaVu Sans Mono', monospace; }
  .prompt { color: #7ee787; }
</style></head><body><div class="window">
  <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title">node examples/demo.mjs</span></div>
  <pre><span class="prompt">$</span> node examples/demo.mjs\n\n${toHtml(ansi)}</pre>
</div></body></html>`

const browser = await chromium.launch()
const context = await browser.newContext({
  deviceScaleFactor: 2,
  viewport: { width: 1200, height: 900 },
})
const tab = await context.newPage()
await tab.setContent(page)
await tab.locator('.window').screenshot({ path: 'docs/demo.png' })
await browser.close()
console.log('wrote docs/demo.png')
