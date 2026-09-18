// Smoke test for the Manifold public API (no auth required).
// Run with: pnpm smoke:manifold
const BASE = 'https://api.manifold.markets'

async function main() {
  const url = `${BASE}/v0/search-markets?limit=5&sort=liquidity&filter=open`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  const markets = await res.json()
  console.log(`Fetched ${markets.length} markets from ${url}`)
  for (const m of markets) {
    console.log(
      `- [${m.id}] ${m.question} | prob=${m.probability} | liquidity=${m.totalLiquidity} | vol24h=${m.volume24Hours}`
    )
  }

  if (markets[0]) {
    const m = markets[0]
    const p = await (await fetch(`${BASE}/v0/market/${m.id}/prob`)).json()
    console.log(`\nMarket "${m.id}" /prob endpoint ->`, JSON.stringify(p))
  }

  console.log('\nSMOKE OK')
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err.message)
  process.exit(1)
})
