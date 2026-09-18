// Fetch additional key Kalshi docs pages.
const pages = [
  ['get-tags-for-series-categories.md', 'https://docs.kalshi.com/api-reference/search/get-tags-for-series-categories.md'],
  ['get-filters-for-sports.md', 'https://docs.kalshi.com/api-reference/search/get-filters-for-sports.md'],
  ['create-order-v2.md', 'https://docs.kalshi.com/api-reference/orders/create-order-v2.md'],
  ['order-direction.md', 'https://docs.kalshi.com/getting_started/order_direction.md'],
  ['fixed-point.md', 'https://docs.kalshi.com/getting_started/fixed_point_migration.md'],
  ['pagination.md', 'https://docs.kalshi.com/getting_started/pagination.md'],
  ['get-balance.md', 'https://docs.kalshi.com/api-reference/portfolio/get-balance.md'],
  ['get-positions.md', 'https://docs.kalshi.com/api-reference/portfolio/get-positions.md'],
  ['get-multivariate-events.md', 'https://docs.kalshi.com/api-reference/events/get-multivariate-events.md']
]

for (const [name, url] of pages) {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.log(`## ${name}: HTTP ${res.status}`)
      continue
    }
    const text = await res.text()
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync('scripts/kalshi-docs', { recursive: true })
    writeFileSync(`scripts/kalshi-docs/${name}`, text)
    console.log(`## ${name}: ${text.length} chars saved`)
  } catch (e) {
    console.log(`## ${name}: ERR ${e.message}`)
  }
}
