import type { TradingEngine } from '../engine/engine'
import type { VenueId, VenueMarket } from '../../shared/types'
import type { ArbOpportunity, ResearchResult } from '../../shared/ipc'
import { fetchNews } from './news'

const STOP = new Set([
  'a', 'an', 'the', 'will', 'be', 'is', 'are', 'was', 'were', 'in', 'on', 'of', 'to', 'for', 'by', 'with',
  'at', 'from', 'and', 'or', 'who', 'what', 'which', 'when', 'how', 'do', 'does', 'did', 'this', 'that', 'it',
  'he', 'she', 'they', 'we', 'you', 'i', 'me', 'my', 'vs', 'its', 'his', 'her', 'their', 'about', 'before', 'after'
])

const VENUES: VenueId[] = ['polymarket-us', 'kalshi']

function stem(w: string): string {
  if (/^[a-z]{4,}s$/.test(w)) return w.slice(0, -1)
  return w
}

function norm(q: string): string[] {
  return [...new Set(q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).map(stem))]
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  const union = new Set([...sa, ...sb]).size
  return union === 0 ? 0 : inter / union
}

/**
 * Bet vetting + arbitrage discovery for a topic:
 *  - recent news headlines
 *  - the same topic priced across all venues (consensus comparison)
 *  - cross-venue pairs whose probabilities diverge (arbitrage candidates)
 */
export async function researchTopic(engine: TradingEngine, topic: string): Promise<ResearchResult> {
  const news = await fetchNews(topic, 15).catch(() => [])

  const byVenue: { venue: VenueId; markets: VenueMarket[] }[] = []
  for (const v of VENUES) {
    const adapter = engine.getAdapter(v)
    let markets: VenueMarket[] = []
    if (adapter) {
      try {
        markets = await adapter.searchMarkets({ term: topic, limit: 20, status: 'open' })
      } catch {
        markets = []
      }
    }
    byVenue.push({ venue: v, markets })
  }

  const opportunities: ArbOpportunity[] = []
  for (let i = 0; i < byVenue.length; i++) {
    for (let j = i + 1; j < byVenue.length; j++) {
      for (const a of byVenue[i].markets) {
        const na = norm(a.question)
        for (const b of byVenue[j].markets) {
          const sim = jaccard(na, norm(b.question))
          if (sim < 0.3) continue
          const pa = a.probability ?? 0
          const pb = b.probability ?? 0
          if (pa <= 0 || pb <= 0) continue
          opportunities.push({
            venueA: byVenue[i].venue,
            marketAId: a.id,
            questionA: a.question,
            probA: pa,
            venueB: byVenue[j].venue,
            marketBId: b.id,
            questionB: b.question,
            probB: pb,
            spread: Math.abs(pa - pb),
            similarity: sim
          })
        }
      }
    }
  }
  opportunities.sort((x, y) => y.spread - x.spread)

  return { topic, news, byVenue, opportunities: opportunities.slice(0, 15) }
}
