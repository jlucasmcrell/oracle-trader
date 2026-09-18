// Smoke test for Polymarket's public APIs (no auth required).
// Run with: node scripts/smoke-polymarket.mjs
const GAMMA = 'https://gamma-api.polymarket.com'
const CLOB = 'https://clob.polymarket.com'

async function main() {
  const listRes = await fetch(`${GAMMA}/markets?limit=5&active=true&closed=false`)
  if (!listRes.ok) throw new Error(`Gamma markets HTTP ${listRes.status}: ${await listRes.text()}`)
  const markets = await listRes.json()
  console.log(`Fetched ${markets.length} markets from Gamma\n`)

  for (const m of markets) {
    console.log(`- id=${m.id} question="${m.question}"`)
    console.log(`    outcomes=${m.outcomes} | outcomePrices=${m.outcomePrices}`)
    console.log(`    clobTokenIds=${m.clobTokenIds}`)
    console.log(`    volumeNum=${m.volumeNum} liquidityNum=${m.liquidityNum} endDate=${m.endDate} closed=${m.closed}`)
  }

  const first = markets[0]
  const tokenIds = first ? JSON.parse(first.clobTokenIds || '[]') : []
  if (tokenIds.length) {
    const yesToken = tokenIds[0]
    console.log(`\n--- CLOB probes for token_id=${yesToken} (YES) ---`)
    const mid = await (await fetch(`${CLOB}/midpoint?token_id=${yesToken}`)).json()
    console.log('midpoint ->', JSON.stringify(mid))
    const book = await (await fetch(`${CLOB}/book?token_id=${yesToken}`)).json()
    console.log('book.bids[0] ->', JSON.stringify(book.bids?.[0]))
    console.log('book.asks[0] ->', JSON.stringify(book.asks?.[0]))
    const price = await (await fetch(`${CLOB}/price?token_id=${yesToken}&side=buy`)).json()
    console.log('price(buy) ->', JSON.stringify(price))
  }

  console.log('\nSMOKE OK')
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err.message)
  process.exit(1)
})
