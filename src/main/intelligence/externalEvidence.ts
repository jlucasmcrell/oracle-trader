import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CandidatePacket, EvidenceRef } from './types'
import { fetchNews } from '../strategies/news'

const REDDIT_DATASET = 'gd_lvz8ah06191smkebj4'
const MONTHLY_RECORD_CAP = 4000
const REDDIT_CACHE_MS = 6 * 3600_000

interface BudgetState {
  month: string
  recordsRequested: number
  searches: Record<string, number>
}

interface RedditRecord {
  title?: string
  description?: string
  body?: string
  url?: string
  post_url?: string
  subreddit?: string
  community_name?: string
  date_posted?: string
  created_at?: string
  num_comments?: number
  upvotes?: number
}

/**
 * Adds point-in-time external evidence to intelligence packets. Free news
 * sources are always used. Bright Data Reddit discovery is optional and
 * tightly budgeted so a 5,000-credit monthly allowance cannot run away.
 */
export class ExternalEvidenceService {
  private budgetPath: string

  constructor(userData: string) {
    this.budgetPath = join(userData, 'intelligence', 'external-data-budget.json')
  }

  async enrich(packet: CandidatePacket): Promise<void> {
    const news = await fetchNews(packet.market.question, 12).catch(() => [])
    for (const [i, item] of news.entries()) {
      packet.evidence.push({
        id: `external-news-${i + 1}`,
        source: item.source,
        asOf: item.publishedAt,
        text: item.title,
        url: item.url
      })
    }

    const token = process.env.BRIGHTDATA_API_KEY?.trim()
    if (!token || !this.redditEligible(packet)) return
    const reddit = await this.fetchReddit(packet.market.question, token, 6).catch(() => [])
    for (const [i, item] of reddit.entries()) {
      packet.evidence.push({ ...item, id: `reddit-${i + 1}` })
    }
  }

  private redditEligible(packet: CandidatePacket): boolean {
    // Reddit is useful for discovery in sports, politics, entertainment,
    // personnel and breaking-event markets. It is deliberately excluded from
    // mechanical crypto-strike, numeric macro and weather pricing.
    const s = `${packet.strategy} ${packet.market.question}`.toLowerCase()
    if (/bitcoin|ethereum|crypto|temperature|weather|cpi|payroll|gdp|fed funds|interest rate/.test(s)) return false
    return /sport|game|match|player|team|election|candidate|nominee|award|movie|show|resign|appoint|launch|release|lawsuit|court|ceo|president|congress/.test(s)
  }

  private async fetchReddit(query: string, token: string, count: number): Promise<Omit<EvidenceRef, 'id'>[]> {
    const state = this.loadBudget()
    const key = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 180)
    const last = state.searches[key] ?? 0
    if (Date.now() - last < REDDIT_CACHE_MS) return []
    if (state.recordsRequested + count > MONTHLY_RECORD_CAP) return []

    // Reserve before calling: crashes/retries must never double-spend credits.
    state.searches[key] = Date.now()
    state.recordsRequested += count
    this.saveBudget(state)

    // Keyword discovery is asynchronous. The synchronous /scrape endpoint
    // treats this dataset as collect-by-URL and rejects keyword/date fields.
    const triggerParams = new URLSearchParams({
      dataset_id: REDDIT_DATASET,
      include_errors: 'true',
      type: 'discover_new',
      discover_by: 'keyword'
    })
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const trigger = await fetch(`https://api.brightdata.com/datasets/v3/trigger?${triggerParams}`, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ keyword: query.slice(0, 240), date: 'Past week', num_of_posts: count }]),
      signal: AbortSignal.timeout(30_000)
    })
    if (!trigger.ok) throw new Error(`Bright Data Reddit trigger HTTP ${trigger.status}: ${(await trigger.text()).slice(0, 240)}`)
    const started = (await trigger.json()) as { snapshot_id?: string }
    if (!started.snapshot_id) throw new Error('Bright Data Reddit trigger returned no snapshot_id')

    const snapshotId = encodeURIComponent(started.snapshot_id)
    let ready = false
    for (let attempt = 0; attempt < 24; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      const progress = await fetch(`https://api.brightdata.com/datasets/v3/progress/${snapshotId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000)
      })
      if (!progress.ok) throw new Error(`Bright Data Reddit progress HTTP ${progress.status}`)
      const state = (await progress.json()) as { status?: string }
      if (state.status === 'ready') {
        ready = true
        break
      }
      if (state.status === 'failed') throw new Error('Bright Data Reddit snapshot failed')
    }
    if (!ready) throw new Error('Bright Data Reddit snapshot timed out')

    const download = await fetch(`https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}?format=json`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(45_000)
    })
    if (!download.ok) throw new Error(`Bright Data Reddit download HTTP ${download.status}: ${(await download.text()).slice(0, 240)}`)
    const raw = (await download.json()) as RedditRecord[] | { data?: RedditRecord[] }
    const rows = Array.isArray(raw) ? raw : raw.data ?? []
    return rows.slice(0, count).flatMap((r) => {
      const text = [r.title, r.description ?? r.body].filter(Boolean).join(' - ').slice(0, 1200)
      const url = r.url ?? r.post_url
      if (!text) return []
      const source = r.subreddit ?? r.community_name ?? 'unknown'
      const when = Date.parse(r.date_posted ?? r.created_at ?? '')
      return [{
        source: `Reddit/r/${source}`,
        asOf: Number.isFinite(when) ? when : Date.now(),
        text: `${text} [upvotes=${r.upvotes ?? 'n/a'} comments=${r.num_comments ?? 'n/a'}]`,
        url
      }]
    })
  }

  private loadBudget(): BudgetState {
    const month = new Date().toISOString().slice(0, 7)
    try {
      if (existsSync(this.budgetPath)) {
        const parsed = JSON.parse(readFileSync(this.budgetPath, 'utf8')) as BudgetState
        if (parsed.month === month) return parsed
      }
    } catch {
      // Reset malformed telemetry; this file contains no credentials.
    }
    return { month, recordsRequested: 0, searches: {} }
  }

  private saveBudget(state: BudgetState): void {
    mkdirSync(dirname(this.budgetPath), { recursive: true })
    const tmp = `${this.budgetPath}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, this.budgetPath)
  }
}
