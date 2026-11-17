// A small, self-contained checkout flow with the usual async mistakes in it.
// Run it with `npm run build && npm run demo` (or `node examples/demo.mjs`).
import http from 'node:http'
import { instrument, span, trace } from 'awaitfall'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A pretend database client. instrument() turns every async method call into a span.
const db = instrument(
  {
    async getUser(id) {
      await sleep(45)
      return { id, name: 'Ada', country: 'NL' }
    },
    async getCart(userId) {
      await sleep(38)
      return { userId, items: [3, 14, 15, 92, 65, 35] }
    },
    async getProduct(id) {
      await sleep(16)
      return { id, price: 10 + (id % 7) }
    },
  },
  'db',
)

// A pretend third-party API, served locally so the demo runs offline.
const server = http.createServer(async (req, res) => {
  await sleep(req.url.startsWith('/tax') ? 140 : 30)
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, rate: 0.21 }))
})
await new Promise((resolve) => server.listen(Number(process.env.PORT) || 0, resolve))
const api = `http://localhost:${server.address().port}`

async function checkout(userId) {
  const user = await db.getUser(userId)
  const cart = await db.getCart(userId) // doesn't need `user`: could run in parallel

  const products = []
  for (const id of cart.items) products.push(await db.getProduct(id)) // N+1

  const total = await span('pricing', async () => {
    const { rate } = await (await fetch(`${api}/tax/${user.country}?key=secret`)).json()
    return products.reduce((sum, p) => sum + p.price, 0) * (1 + rate)
  })

  span('sendReceipt', () => fetch(`${api}/email`, { method: 'POST' })) // missing await
  return total
}

await trace('checkout', () => checkout(42))
await sleep(50)
server.close()
