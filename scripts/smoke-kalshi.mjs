// Smoke test for Kalshi's public market-data API (no auth required).
// Run with: node scripts/smoke-kalshi.mjs
const candidates = [
  'https://api.elections.kalshi.com/trade-api/v2',
  'https://api.kalshi.com/trade-api/v2',
  'https://external-api.kalshi.com/trade-api/v2'
]

async function main() {
  let base = null
  for (const b of candidates) {
    try {
      const r = await fetch(`${b}/markets?limit=3&status=open`)
      if (r.ok) {
        base = b
        const j = await r.json()
        const mkts = j.markets ?? j
        console.log('WORKING base:', b)
        console.log('markets count:', Array.isArray(mkts) ? mkts.length : '?')
        console.log('first market keys:', Object.keys(mkts?.[0] ?? {}).join(','))
        console.log('sample:', JSON.stringify(mkts?.[0]).slice(0, 900))
        break
      }
      console.log(b, '=> HTTP', r.status, (await r.text()).slice(0, 120))
    } catch (e) {
      console.log(b, 'ERR', e.message)
    }
  }
  if (!base) return

  const ev = await (await fetch(`${base}/events?limit=3&status=open`)).json()
  console.log('\nevents count:', ev.events?.length)
  console.log('event sample:', JSON.stringify(ev.events?.[0]).slice(0, 600))

  const sr = await (await fetch(`${base}/series?limit=3`)).json()
  console.log('\nseries count:', sr.series?.length)
  console.log('series sample:', JSON.stringify(sr.series?.[0]).slice(0, 600))
  console.log('\nSMOKE OK')
}

main().catch((e) => {
  console.error('FAIL', e.message)
  process.exit(1)
})
