import { HttpClient } from '../util/http'
import type { VenueMarket } from '../../shared/types'
import { isMoneylineWin } from './moneyline'
import {
  teamInQuestion,
  type AnchorObservation,
  type SgoTrackedEvent,
  type SportsShadowStats
} from './sportsAnchor'

/**
 * SportsGameOdds supplemental sports anchor (shadow only).
 *
 * Discovery is deliberately cheap. Exact Kalshi matches are retained and then
 * refreshed by eventID near start and after completion. This spends the free
 * object-metered allowance on events we can actually grade instead of repeatedly
 * downloading unrelated games.
 */

const BASE_URL = 'https://api.sportsgameodds.com/v2'
const DISCOVERY_MS = 12 * 3600_000
const MAX_DISCOVERY_EVENTS = 20
const MAX_TARGET_EVENTS = 10
const MONTHLY_OBJECT_BUDGET = 2400
const CURRENT_BOOK_MAX_AGE_MS = 30 * 60_000
const RESULT_RETRY_MS = 6 * 3600_000
const TRACK_RETENTION_MS = 45 * 24 * 3600_000
const DISCOVERY_KEY = 'sgo:discovery:v3'

const SERIES_TO_LEAGUE: Record<string, string> = {
  KXMLBGAME: 'MLB',
  KXNFLGAME: 'NFL',
  KXNCAAFGAME: 'NCAAF',
  KXNBAGAME: 'NBA',
  KXNHLGAME: 'NHL',
  KXMLSGAME: 'MLS'
}

interface SgoTeam {
  teamID?: string
  names?: { long?: string; medium?: string; short?: string }
  statEntityID?: string
  score?: number
}

interface SgoBookQuote {
  bookmakerID?: string
  odds?: string
  openOdds?: string
  closeOdds?: string
  available?: boolean
  lastUpdatedAt?: string
}

interface SgoOdd {
  oddID?: string
  statEntityID?: string
  periodID?: string
  betTypeID?: string
  sideID?: string
  fairOddsAvailable?: boolean
  fairOdds?: string
  openFairOdds?: string
  closeFairOdds?: string
  score?: number
  scoringSupported?: boolean
  byBookmaker?: Record<string, SgoBookQuote>
}

interface SgoEvent {
  eventID?: string
  leagueID?: string
  teams?: { home?: SgoTeam; away?: SgoTeam }
  status?: {
    startsAt?: string
    started?: boolean
    live?: boolean
    ended?: boolean
    completed?: boolean
    cancelled?: boolean
    finalized?: boolean
  }
  odds?: Record<string, SgoOdd>
}

interface SgoResponse {
  success?: boolean
  data?: SgoEvent[]
  notice?: string
  nextCursor?: string
}

type OddsPhase = 'current' | 'open' | 'close'

interface FairPair {
  home: number
  away: number
  source: string
  freshAt?: number
  staleExcluded: number
  booksUsed: number
}

function americanToDecimal(raw?: string): number | undefined {
  if (!raw) return undefined
  const v = Number(raw.replace(/[^0-9+.-]/g, ''))
  if (!Number.isFinite(v) || v === 0) return undefined
  return v > 0 ? 1 + v / 100 : 1 + 100 / Math.abs(v)
}

function impliedFromAmerican(raw?: string): number | undefined {
  const d = americanToDecimal(raw)
  return d && d > 1 ? 1 / d : undefined
}

function longName(t?: SgoTeam): string | undefined {
  return t?.names?.long || t?.names?.medium
}

function moneylineLeg(ev: SgoEvent, side: 'home' | 'away'): SgoOdd | undefined {
  const entity = ev.teams?.[side]?.statEntityID ?? side
  return Object.values(ev.odds ?? {}).find((o) =>
    o.periodID === 'game' && o.betTypeID === 'ml' &&
    (o.statEntityID === entity || o.sideID === side)
  )
}

function quoteForPhase(q: SgoBookQuote, phase: OddsPhase): string | undefined {
  if (phase === 'open') return q.openOdds
  if (phase === 'close') return q.closeOdds
  return q.odds
}

function topLevelForPhase(o: SgoOdd, phase: OddsPhase): string | undefined {
  if (phase === 'open') return o.openFairOdds
  if (phase === 'close') return o.closeFairOdds
  return o.fairOdds
}

/**
 * Build a no-vig paired probability. Current consensus excludes stale books;
 * historical open/close fields are exempt because their timestamps are defined
 * by the provider rather than by lastUpdatedAt.
 */
function fairPair(ev: SgoEvent, phase: OddsPhase, now = Date.now()): FairPair | undefined {
  const home = moneylineLeg(ev, 'home')
  const away = moneylineLeg(ev, 'away')
  if (!home || !away) return undefined

  const sharp = new Set(['pinnacle', 'circa', 'bookmaker', 'betonline', 'lowvig', 'betfair', 'matchbook', 'novig'])
  const rows: { home: number; away: number; w: number; book: string; at?: number }[] = []
  let staleExcluded = 0
  const homeBooks = home.byBookmaker ?? {}
  const awayBooks = away.byBookmaker ?? {}

  for (const [key, hb] of Object.entries(homeBooks)) {
    const ab = awayBooks[key]
    if (!ab || hb.available === false || ab.available === false) continue
    const hAt = hb.lastUpdatedAt ? Date.parse(hb.lastUpdatedAt) : undefined
    const aAt = ab.lastUpdatedAt ? Date.parse(ab.lastUpdatedAt) : undefined
    const at = hAt !== undefined && aAt !== undefined ? Math.min(hAt, aAt) : hAt ?? aAt
    if (phase === 'current' && (at === undefined || now - at > CURRENT_BOOK_MAX_AGE_MS || at > now + 60_000)) {
      staleExcluded++
      continue
    }
    const hi = impliedFromAmerican(quoteForPhase(hb, phase))
    const ai = impliedFromAmerican(quoteForPhase(ab, phase))
    if (!hi || !ai || hi + ai <= 0) continue
    const book = (hb.bookmakerID ?? key).toLowerCase()
    const w = sharp.has(book) ? 2 : 1
    rows.push({ home: hi / (hi + ai), away: ai / (hi + ai), w, book, at })
  }

  if (rows.length) {
    const weight = rows.reduce((s, x) => s + x.w, 0)
    const fresh = rows.map((x) => x.at).filter((x): x is number => x !== undefined)
    return {
      home: rows.reduce((s, x) => s + x.home * x.w, 0) / weight,
      away: rows.reduce((s, x) => s + x.away * x.w, 0) / weight,
      source: `sgo-${phase}-books-v2:${rows.map((x) => x.book).join(',')}`.slice(0, 160),
      freshAt: fresh.length ? Math.max(...fresh) : undefined,
      staleExcluded,
      booksUsed: rows.length
    }
  }

  // Provider fair odds remain useful when the free plan filters bookmaker
  // detail. They are not treated as freshness-proven current quotes.
  const hi = impliedFromAmerican(topLevelForPhase(home, phase))
  const ai = impliedFromAmerican(topLevelForPhase(away, phase))
  if (!hi || !ai || hi + ai <= 0) return undefined
  return {
    home: hi / (hi + ai),
    away: ai / (hi + ai),
    source: `sgo-${phase}-fair-v2`,
    staleExcluded,
    booksUsed: 0
  }
}

function leaguesInUniverse(markets: VenueMarket[]): string[] {
  const out = new Set<string>()
  for (const m of markets) {
    const prefix = (m.seriesTicker ?? m.id).toUpperCase().split('-')[0]
    const league = SERIES_TO_LEAGUE[prefix]
    if (league) out.add(league)
  }
  return [...out]
}

function monthKey(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 7)
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function resetMonthlyBudget(stats: SportsShadowStats, now: number): void {
  const month = monthKey(now)
  if (stats.sgoBudgetMonth === month) return
  stats.sgoBudgetMonth = month
  // Preserve already observed usage when upgrading in the middle of a month.
  // It is safer to under-use the free allowance than to assume a fresh quota.
  stats.sgoMonthlyObjects = Math.min(stats.sgoObjects ?? 0, MONTHLY_OBJECT_BUDGET)
}

function remainingBudget(stats: SportsShadowStats): number {
  return Math.max(0, MONTHLY_OBJECT_BUDGET - (stats.sgoMonthlyObjects ?? 0))
}

function accountResponse(stats: SportsShadowStats, response: SgoResponse, now: number, targeted: boolean): SgoEvent[] {
  const rows = response.data ?? []
  stats.sgoPolls = (stats.sgoPolls ?? 0) + 1
  if (targeted) stats.sgoTargetPolls = (stats.sgoTargetPolls ?? 0) + 1
  stats.sgoObjects = (stats.sgoObjects ?? 0) + rows.length
  stats.sgoMonthlyObjects = (stats.sgoMonthlyObjects ?? 0) + rows.length
  stats.sgoLastPollAt = now
  stats.sgoLastNotice = response.notice?.slice(0, 240)
  stats.sgoLastError = undefined
  return rows
}

function marketGroups(markets: VenueMarket[]): VenueMarket[][] {
  const grouped = new Map<string, VenueMarket[]>()
  for (const m of markets) {
    if (m.probability === undefined) continue
    const key = m.eventTicker ?? m.id
    const arr = grouped.get(key) ?? []
    arr.push(m)
    grouped.set(key, arr)
  }
  return [...grouped.values()]
}

function matchedMarkets(ev: SgoEvent, groups: VenueMarket[][]): { home: VenueMarket; away: VenueMarket } | undefined {
  const home = longName(ev.teams?.home)
  const away = longName(ev.teams?.away)
  if (!home || !away) return undefined
  const start = ev.status?.startsAt ? Date.parse(ev.status.startsAt) : undefined

  for (const group of groups) {
    const close = group[0]?.closeTime
    if (start !== undefined && close !== undefined) {
      if (start > close + 3600_000 || close - start > 7 * 24 * 3600_000) continue
    }
    const legs = group.filter((m) => isMoneylineWin(m.question, home, away))
    const homeM = legs.find((m) => teamInQuestion(home, m.question))
    const awayM = legs.find((m) => teamInQuestion(away, m.question))
    if (homeM && awayM && homeM !== awayM) return { home: homeM, away: awayM }
  }
  return undefined
}

function observation(
  tracked: SgoTrackedEvent,
  side: 'home' | 'away',
  fair: FairPair,
  phase: AnchorObservation['phase'],
  now: number,
  open?: FairPair,
  close?: FairPair
): AnchorObservation {
  const kalshiId = side === 'home' ? tracked.homeKalshiId : tracked.awayKalshiId
  const question = side === 'home' ? tracked.homeQuestion : tracked.awayQuestion
  const kalshiMid = side === 'home' ? tracked.initialKalshiHome : tracked.initialKalshiAway
  const p = side === 'home' ? fair.home : fair.away
  return {
    kalshiId,
    question: question.slice(0, 80),
    kalshiMid,
    fairProb: round4(p),
    gapCents: round2((kalshiMid - p) * 100),
    bookmaker: fair.source,
    sportKey: `sgo:${tracked.leagueID || 'unknown'}`,
    ts: now,
    externalEventId: tracked.eventID,
    phase,
    eventStartsAt: tracked.startsAt,
    oddsFreshAt: fair.freshAt,
    staleBooksExcluded: fair.staleExcluded,
    openingFairProb: open ? round4(side === 'home' ? open.home : open.away) : undefined,
    closingFairProb: close ? round4(side === 'home' ? close.home : close.away) : undefined
  }
}

function gradeEvent(ev: SgoEvent, tracked: SgoTrackedEvent, stats: SportsShadowStats, now: number): AnchorObservation[] {
  if (tracked.gradedAt || !ev.status?.finalized || ev.status.cancelled) return []
  const homeScore = ev.teams?.home?.score ?? moneylineLeg(ev, 'home')?.score
  const awayScore = ev.teams?.away?.score ?? moneylineLeg(ev, 'away')?.score
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore) || homeScore === awayScore) return []
  const close = fairPair(ev, 'close', now) ?? fairPair(ev, 'current', now)
  const current = close ?? fairPair(ev, 'open', now)
  if (!current) return []
  const homeWon = Number(homeScore) > Number(awayScore)
  const rows: AnchorObservation[] = []

  for (const side of ['home', 'away'] as const) {
    const resultYes = side === 'home' ? homeWon : !homeWon
    const initialFair = side === 'home' ? tracked.initialFairHome : tracked.initialFairAway
    const initialKalshi = side === 'home' ? tracked.initialKalshiHome : tracked.initialKalshiAway
    const closingFair = side === 'home' ? current.home : current.away
    const row = observation(tracked, side, current, 'grade', now, undefined, close)
    row.resultYes = resultYes
    row.clvCents = round2((closingFair - initialKalshi) * 100)
    row.brier = round4((initialFair - (resultYes ? 1 : 0)) ** 2)
    rows.push(row)
    stats.sgoBrierSum = (stats.sgoBrierSum ?? 0) + row.brier
    stats.sgoClvSumCents = (stats.sgoClvSumCents ?? 0) + row.clvCents
    stats.sgoClvN = (stats.sgoClvN ?? 0) + 1
  }

  tracked.gradedAt = now
  tracked.finalizedAt = now
  stats.sgoGraded = (stats.sgoGraded ?? 0) + rows.length
  stats.sgoFinalized = (stats.sgoFinalized ?? 0) + 1
  return rows
}

export class SportsGameOddsAnchor {
  private http = new HttpClient({ baseUrl: BASE_URL, rateLimit: 9, timeoutMs: 30_000 })

  private async fetch(apiKey: string, params: URLSearchParams): Promise<SgoResponse> {
    return this.http.get<SgoResponse>(`/events/?${params.toString()}`, { 'x-api-key': apiKey })
  }

  async poll(
    apiKey: string,
    kalshiSports: VenueMarket[],
    stats: SportsShadowStats,
    pollAt: Record<string, number>
  ): Promise<AnchorObservation[]> {
    if (!apiKey) return []
    const now = Date.now()
    resetMonthlyBudget(stats, now)
    stats.sgoTracked = stats.sgoTracked ?? {}
    const tracked = stats.sgoTracked
    const out: AnchorObservation[] = []
    const groups = marketGroups(kalshiSports)

    // Remove old completed tracking records, but retain unresolved matches long
    // enough for delayed official finalization.
    for (const [id, row] of Object.entries(tracked)) {
      const anchor = row.gradedAt ?? row.startsAt
      if (now - anchor > TRACK_RETENTION_MS) delete tracked[id]
    }

    const leagues = leaguesInUniverse(kalshiSports)
    if (leagues.length && now - (pollAt[DISCOVERY_KEY] ?? 0) >= DISCOVERY_MS && remainingBudget(stats) > 0) {
      const limit = Math.min(MAX_DISCOVERY_EVENTS, remainingBudget(stats))
      pollAt[DISCOVERY_KEY] = now // persist before I/O to avoid restart storms
      const params = new URLSearchParams({
        leagueID: leagues.join(','),
        type: 'match',
        oddsAvailable: 'true',
        live: 'false',
        finalized: 'false',
        startsAfter: new Date(now - 3600_000).toISOString(),
        startsBefore: new Date(now + 7 * 24 * 3600_000).toISOString(),
        oddID: 'points-home-game-ml-home',
        includeOpposingOdds: 'true',
        includeOpenCloseOdds: 'true',
        limit: String(limit)
      })
      try {
        const response = await this.fetch(apiKey, params)
        const events = accountResponse(stats, response, now, false)
        for (const ev of events) {
          if (!ev.eventID || ev.status?.started || ev.status?.live || ev.status?.cancelled) continue
          const match = matchedMarkets(ev, groups)
          const current = fairPair(ev, 'current', now)
          if (!match || !current || match.home.probability === undefined || match.away.probability === undefined) continue
          const home = longName(ev.teams?.home)
          const away = longName(ev.teams?.away)
          const startsAt = ev.status?.startsAt ? Date.parse(ev.status.startsAt) : NaN
          if (!home || !away || !Number.isFinite(startsAt)) continue
          const first = tracked[ev.eventID] ?? {
            eventID: ev.eventID,
            leagueID: ev.leagueID ?? 'unknown',
            startsAt,
            home,
            away,
            homeKalshiId: match.home.id,
            awayKalshiId: match.away.id,
            homeQuestion: match.home.question,
            awayQuestion: match.away.question,
            initialKalshiHome: match.home.probability,
            initialKalshiAway: match.away.probability,
            initialFairHome: current.home,
            initialFairAway: current.away,
            discoveredAt: now
          }
          tracked[ev.eventID] = first
          const open = fairPair(ev, 'open', now)
          const close = fairPair(ev, 'close', now)
          out.push(observation(first, 'home', current, 'discovery', now, open, close))
          out.push(observation(first, 'away', current, 'discovery', now, open, close))
          stats.sgoFreshBooks = (stats.sgoFreshBooks ?? 0) + current.booksUsed
          stats.sgoStaleBooksExcluded = (stats.sgoStaleBooksExcluded ?? 0) + current.staleExcluded
        }
      } catch (err) {
        stats.sgoLastError = (err instanceof Error ? err.message : String(err)).slice(-240)
      }
    }

    // Spend remaining credits only on exact matched event IDs. Capture one
    // six-hour snapshot, one pre-start snapshot, and delayed final result.
    const due: SgoTrackedEvent[] = []
    for (const row of Object.values(tracked)) {
      if (row.gradedAt) continue
      const until = row.startsAt - now
      if (until > 30 * 60_000 && until <= 6 * 3600_000 && !row.nearStartAt && now - row.discoveredAt >= 30 * 60_000) due.push(row)
      else if (until <= 30 * 60_000 && until > -2 * 3600_000 && !row.preCloseAt) due.push(row)
      else if (until <= -2 * 3600_000 && now - (row.lastResultAt ?? 0) >= RESULT_RETRY_MS) due.push(row)
    }

    const allowance = Math.min(MAX_TARGET_EVENTS, remainingBudget(stats))
    const targets = due.sort((a, b) => a.startsAt - b.startsAt).slice(0, allowance)
    if (targets.length) {
      const key = `sgo:target:${targets.map((x) => x.eventID).sort().join(',')}`
      // A scan loop can call poll repeatedly while a request is in flight.
      if (now - (pollAt[key] ?? 0) >= 5 * 60_000) {
        pollAt[key] = now
        const params = new URLSearchParams({
          eventIDs: targets.map((x) => x.eventID).join(','),
          oddID: 'points-home-game-ml-home',
          includeOpposingOdds: 'true',
          includeOpenCloseOdds: 'true',
          expandResults: 'true',
          limit: String(targets.length)
        })
        try {
          const response = await this.fetch(apiKey, params)
          const events = accountResponse(stats, response, now, true)
          for (const ev of events) {
            if (!ev.eventID) continue
            const row = tracked[ev.eventID]
            if (!row) continue
            row.lastRefreshAt = now
            const until = row.startsAt - now
            if (ev.status?.finalized) {
              row.lastResultAt = now
              out.push(...gradeEvent(ev, row, stats, now))
              continue
            }
            const current = fairPair(ev, 'current', now)
            if (!current) continue
            const open = fairPair(ev, 'open', now)
            const close = fairPair(ev, 'close', now)
            const phase: AnchorObservation['phase'] = until <= 30 * 60_000 ? 'pre-close' : 'near-start'
            if (phase === 'pre-close') row.preCloseAt = now
            else row.nearStartAt = now
            out.push(observation(row, 'home', current, phase, now, open, close))
            out.push(observation(row, 'away', current, phase, now, open, close))
            stats.sgoFreshBooks = (stats.sgoFreshBooks ?? 0) + current.booksUsed
            stats.sgoStaleBooksExcluded = (stats.sgoStaleBooksExcluded ?? 0) + current.staleExcluded
          }
          // Missing/non-final result rows get a bounded retry later.
          for (const row of targets) if (row.startsAt <= now - 2 * 3600_000) row.lastResultAt = now
        } catch (err) {
          stats.sgoLastError = (err instanceof Error ? err.message : String(err)).slice(-240)
        }
      }
    }

    stats.sgoMatched = (stats.sgoMatched ?? 0) + out.filter((x) => x.phase === 'discovery').length
    return out
  }
}

