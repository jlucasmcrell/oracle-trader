import type { NewsItem } from '../../shared/ipc'

const GOOGLE_NEWS = 'https://news.google.com/rss/search'
const GDELT_DOC = 'https://api.gdeltproject.org/api/v2/doc/doc'
const CACHE_MS = 10 * 60_000
const cache = new Map<string, { at: number; items: NewsItem[] }>()

const OFFICIAL_FEEDS = [
  { source: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { source: 'BLS', url: 'https://www.bls.gov/feed/bls_latest.rss' },
  { source: 'SEC', url: 'https://www.sec.gov/news/pressreleases.rss' }
]

/**
 * Multi-source news discovery. Google News and GDELT provide breadth; official
 * agency feeds provide primary-source evidence. Results are cached, deduped,
 * timestamped, and sorted newest-first. A failed source never takes down the
 * whole research pass.
 */
export async function fetchNews(query: string, limit = 15): Promise<NewsItem[]> {
  const key = `${query.trim().toLowerCase()}|${limit}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.items

  const [google, gdelt, official] = await Promise.all([
    fetchGoogle(query, limit).catch(() => []),
    fetchGdelt(query, limit).catch(() => []),
    fetchOfficial(query).catch(() => [])
  ])
  const merged = dedupe([...official, ...google, ...gdelt])
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, limit)
  cache.set(key, { at: Date.now(), items: merged })
  return merged
}

async function fetchGoogle(query: string, limit: number): Promise<NewsItem[]> {
  const url = `${GOOGLE_NEWS}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
  const xml = await getText(url)
  return parseFeed(xml, 'Google News').slice(0, limit)
}

async function fetchGdelt(query: string, limit: number): Promise<NewsItem[]> {
  const params = new URLSearchParams({
    query: `(${query}) sourcelang:english`,
    mode: 'ArtList',
    format: 'json',
    maxrecords: String(Math.min(50, Math.max(limit, 10))),
    timespan: '48h',
    sort: 'DateDesc'
  })
  const res = await fetch(`${GDELT_DOC}?${params}`, {
    headers: { 'User-Agent': 'OracleTrader/0.1 research contact: local-user' },
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`)
  const body = (await res.json()) as {
    articles?: { title?: string; url?: string; domain?: string; seendate?: string }[]
  }
  return (body.articles ?? []).flatMap((a) => {
    if (!a.title || !a.url) return []
    return [{
      title: clean(a.title),
      source: a.domain ? `GDELT/${a.domain}` : 'GDELT',
      url: a.url,
      publishedAt: parseGdeltDate(a.seendate) ?? Date.now()
    }]
  })
}

async function fetchOfficial(query: string): Promise<NewsItem[]> {
  const tokens = significantTokens(query)
  if (tokens.length === 0) return []
  const settled = await Promise.all(
    OFFICIAL_FEEDS.map(async (feed) => {
      const xml = await getText(feed.url)
      return parseFeed(xml, feed.source).filter((item) => relevant(item.title, tokens))
    })
  )
  return settled.flat()
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'OracleTrader/0.1 local prediction-market research',
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml'
    },
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`News fetch failed: HTTP ${res.status}`)
  return res.text()
}

function parseFeed(xml: string, fallbackSource: string): NewsItem[] {
  const blocks = [
    ...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)
  ].map((m) => m[1])
  return blocks.flatMap((block) => {
    const title = clean(tag(block, 'title'))
    const href = block.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1]
    const link = clean(href ?? tag(block, 'link'))
    if (!title || !link) return []
    const published = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated')
    const source = clean(tag(block, 'source')) || sourceFromGoogleTitle(title) || fallbackSource
    const displayTitle = fallbackSource === 'Google News' ? stripGoogleSource(title) : title
    return [{ title: displayTitle, source, url: link, publishedAt: parseDate(published) ?? Date.now() }]
  })
}

function tag(xml: string, name: string): string {
  const match = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return match?.[1] ?? ''
}

function significantTokens(query: string): string[] {
  const stop = new Set(['will','what','when','where','which','would','could','should','about','before','after','market','price','above','below','between','the','and','for','with','from','this','that'])
  return query.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((x) => !stop.has(x)).slice(0, 12) ?? []
}

function relevant(title: string, tokens: string[]): boolean {
  const t = title.toLowerCase()
  return tokens.some((token) => t.includes(token))
}

function dedupe(items: NewsItem[]): NewsItem[] {
  const out: NewsItem[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function sourceFromGoogleTitle(title: string): string {
  const i = title.lastIndexOf(' - ')
  return i > 0 ? title.slice(i + 3) : ''
}

function stripGoogleSource(title: string): string {
  const i = title.lastIndexOf(' - ')
  return i > 0 ? title.slice(0, i) : title
}

function parseDate(raw: string): number | undefined {
  const n = Date.parse(clean(raw))
  return Number.isFinite(n) ? n : undefined
}

function parseGdeltDate(raw?: string): number | undefined {
  if (!raw) return undefined
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/)
  if (!m) return parseDate(raw)
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
}

function clean(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
