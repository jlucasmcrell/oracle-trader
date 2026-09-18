import { HttpClient } from '../util/http'
import type { VenueMarket } from '../../shared/types'
import { isMoneylineWin } from './moneyline'

/**
 * Sports devig shadow: sharp-book fair values vs Kalshi sports prices.
 *
 * Pulls h2h lines from The Odds API, devigs each bookmaker independently,
 * combines them into a robust consensus, and matches Kalshi games by team
 * names + start time, and RECORDS the gaps. No trading — this is the shadow
 * trial that decides whether the sports-anchor strategy earns execution.
 *
 * Free-tier budget: one h2h×eu request costs 1 credit, 500/month. Only
 * leagues present in the CURRENT Kalshi universe are polled, at most once
 * per SPORT_POLL_MS (2h), with the throttle persisted across restarts — the
 * three together keep a normal day well inside the free tier.
 */

export interface AnchorObservation {
  kalshiId: string
  question: string
  /** Kalshi mid (YES leg) at observation. */
  kalshiMid: number
  /** Devigged external fair probability for the SAME outcome as the YES leg. */
  fairProb: number
  /** kalshiMid - fairProb, in cents (positive = Kalshi rich vs consensus). */
  gapCents: number
  bookmaker: string
  sportKey: string
  ts: number
  /** For grading against final scores: the odds event and what the Kalshi YES side means. */
  eventId?: string
  homeTeam?: string
  awayTeam?: string
  market?: 'h2h' | 'spread' | 'total'
  /** Team the Kalshi YES side is on (h2h, spread). */
  team?: string
  /** Line for a spread ("wins by over point") or a total ("over point"). */
  point?: number
  /** Optional SportsGameOdds lifecycle fields. */
  externalEventId?: string
  phase?: 'discovery' | 'near-start' | 'pre-close' | 'final' | 'grade'
  eventStartsAt?: number
  oddsFreshAt?: number
  staleBooksExcluded?: number
  openingFairProb?: number
  closingFairProb?: number
  resultYes?: boolean
  clvCents?: number
  brier?: number
}

export interface SgoTrackedEvent {
  eventID: string
  leagueID: string
  startsAt: number
  home: string
  away: string
  homeKalshiId: string
  awayKalshiId: string
  homeQuestion: string
  awayQuestion: string
  initialKalshiHome: number
  initialKalshiAway: number
  initialFairHome: number
  initialFairAway: number
  discoveredAt: number
  lastRefreshAt?: number
  nearStartAt?: number
  preCloseAt?: number
  lastResultAt?: number
  finalizedAt?: number
  gradedAt?: number
}

export interface SportsShadowStats {
  n: number
  matched: number
  polls: number
  sumGapCents: number
  sumAbsGapCents: number
  lastPollAt?: number
  lastError?: string
  /** SportsGameOdds free-tier usage and health (supplemental shadow source). */
  sgoPolls?: number
  sgoObjects?: number
  sgoMatched?: number
  sgoLastPollAt?: number
  sgoLastNotice?: string
  sgoLastError?: string
  /** Object-metered monthly budget and targeted-event lifecycle telemetry. */
  sgoBudgetMonth?: string
  sgoMonthlyObjects?: number
  sgoTracked?: Record<string, SgoTrackedEvent>
  sgoTargetPolls?: number
  sgoFreshBooks?: number
  sgoStaleBooksExcluded?: number
  sgoGraded?: number
  sgoBrierSum?: number
  sgoClvN?: number
  sgoClvSumCents?: number
  sgoFinalized?: number
  /** Latest observation per Kalshi market awaiting a final score (The Odds API scores grading). */
  pending?: AnchorObservation[]
  gradedN?: number
  gradedBrier?: number
  /** The rule under test: buy the cheap side at Kalshi's mid when the gap is 3c or more. */
  ruleN?: number
  ruleNet?: number
}

export function defaultSportsShadow(): SportsShadowStats {
  return { n: 0, matched: 0, polls: 0, sumGapCents: 0, sumAbsGapCents: 0 }
}

interface ScoreEvent {
  id?: string
  completed?: boolean
  home_team?: string
  away_team?: string
  scores?: { name?: string; score?: string }[] | null
}

interface OddsEvent {
  id?: string
  sport_key?: string
  commence_time?: string
  home_team?: string
  away_team?: string
  bookmakers?: {
    key?: string
    markets?: { key?: string; outcomes?: { name?: string; price?: number; point?: number }[] }[]
  }[]
}

/** Multiplicative devig of decimal odds: fair_i = (1/d_i) / Σ(1/d_j). */
export function devig(decimalOdds: number[]): number[] {
  const inv = decimalOdds.map((d) => (d > 1 ? 1 / d : 0))
  const sum = inv.reduce((s, v) => s + v, 0)
  if (sum <= 0) return decimalOdds.map(() => 0)
  return inv.map((v) => v / sum)
}

/** Book weight in the consensus: Pinnacle is the sharpest line in the world, exchanges and the low-vig books next. */
function bookWeight(key: string): number {
  if (key === 'pinnacle') return 3
  if (key === 'betfair_ex_eu' || key === 'betonlineag' || key === 'lowvig') return 2
  return 1
}

/**
 * Spread and total consensus per line: P(team covers -X.5) keyed "team|X.5"
 * and P(over X.5) keyed "over|X.5", each devigged per book from the two sides
 * of the same line and weight-averaged across books. Kalshi lists one market
 * per strike ("Kansas City wins by over 7.5 points?", "Over 63.5 points
 * scored?"), so a strike is priced only where a book quotes that exact line.
 */
export function lineConsensus(ev: OddsEvent): { spread: Map<string, number>; total: Map<string, number>; books: number } {
  const acc = new Map<string, { p: number; w: number }[]>()
  let books = 0
  for (const book of ev.bookmakers ?? []) {
    const w = bookWeight(book.key ?? 'unknown')
    let used = false
    const push = (key: string, p: number): void => {
      const arr = acc.get(key) ?? []
      arr.push({ p, w })
      acc.set(key, arr)
      used = true
    }
    for (const market of book.markets ?? []) {
      const outcomes = market.outcomes ?? []
      const ok = (o: { name?: string; price?: number; point?: number }): boolean => !!o.name && !!o.price && o.price > 1 && typeof o.point === 'number'
      if ((market.key === 'spreads' || market.key === 'alternate_spreads') && outcomes.length >= 2) {
        // Each favorite line (point < 0) pairs with the other team's matching +point.
        for (const o of outcomes) {
          if (!ok(o) || o.point! >= 0) continue
          const other = outcomes.find((x) => ok(x) && x.name !== o.name && Math.abs(x.point! + o.point!) < 1e-9)
          if (!other) continue
          push(`${o.name}|${Math.abs(o.point!)}`, devig([o.price!, other.price!])[0])
        }
      } else if ((market.key === 'totals' || market.key === 'alternate_totals') && outcomes.length >= 2) {
        for (const over of outcomes) {
          if (!ok(over) || (over.name ?? '').toLowerCase() !== 'over') continue
          const under = outcomes.find((x) => ok(x) && (x.name ?? '').toLowerCase() === 'under' && Math.abs(x.point! - over.point!) < 1e-9)
          if (!under) continue
          push(`over|${over.point}`, devig([over.price!, under.price!])[0])
        }
      }
    }
    if (used) books++
  }
  const spread = new Map<string, number>()
  const total = new Map<string, number>()
  for (const [key, rows] of acc) {
    const w = rows.reduce((s, x) => s + x.w, 0)
    const p = rows.reduce((s, x) => s + x.p * x.w, 0) / w
    if (key.startsWith('over|')) total.set(key, p)
    else spread.set(key, p)
  }
  return { spread, total, books }
}

/** Devig every available book first, then take a weighted median-like mean. */
function consensusForEvent(ev: OddsEvent): { fairFor: (team: string) => number | undefined; books: string[] } | undefined {
  const byTeam = new Map<string, { p: number; w: number }[]>()
  const books: string[] = []
  for (const book of ev.bookmakers ?? []) {
    const market = book.markets?.find((m) => m.key === 'h2h')
    const outcomes = market?.outcomes ?? []
    if (outcomes.length < 2 || outcomes.some((o) => !o.name || !o.price || o.price <= 1)) continue
    const fair = devig(outcomes.map((o) => o.price!))
    const key = book.key ?? 'unknown'
    const weight = bookWeight(key)
    books.push(key)
    outcomes.forEach((o, i) => {
      const arr = byTeam.get(o.name!) ?? []
      arr.push({ p: fair[i], w: weight })
      byTeam.set(o.name!, arr)
    })
  }
  if (books.length === 0) return undefined
  return {
    books,
    fairFor: (team: string) => {
      const rows = byTeam.get(team)
      if (!rows?.length) return undefined
      const w = rows.reduce((sum, x) => sum + x.w, 0)
      return rows.reduce((sum, x) => sum + x.p * x.w, 0) / w
    }
  }
}

/** "Kansas City wins by over 7.5 points?" -> spread 7.5; "Over 63.5 points scored?" -> total 63.5; first-half markets are skipped. */
export function parseLineMarket(question: string): { kind: 'spread' | 'total'; point: number } | null {
  const q = question.toLowerCase()
  if (/\b1h\b|1st half|first half|\b1q\b|1st quarter/.test(q)) return null
  const spread = /wins by (?:over|more than) (\d+(?:\.\d)?)/.exec(q)
  if (spread) return { kind: 'spread', point: parseFloat(spread[1]) }
  const total = /^(?:will there be )?over (\d+(?:\.\d)?) /.exec(q)
  if (total) return { kind: 'total', point: parseFloat(total[1]) }
  return null
}

/**
 * Kalshi game tickers carry both teams' city codes (…-26SEP14DENKC-…). A team
 * name from the odds feed ("Kansas City Chiefs") maps to candidate codes: the
 * city's initials when it has several words (KC, NY, SD, TB, LA) and the first
 * three letters of the city (DEN, TEX, MIL, STL). Both teams must match.
 */
export function teamCodes(name: string): string[] {
  const words = name.replace(/[^A-Za-z ]/g, '').trim().split(/\s+/).filter(Boolean)
  const city = words.length >= 2 ? words.slice(0, -1) : words
  const nick = words.length >= 2 ? words[words.length - 1] : ''
  const out = new Set<string>()
  const initials = city.map((w) => w[0]).join('').toUpperCase()
  const first3 = city.join('').toUpperCase().slice(0, 3)
  if (city.length >= 2) out.add(initials)
  out.add(first3)
  // Exchange codes tell shared cities apart with the nickname's initial (LAA/LAD, NYY/NYM, CWS, WASH).
  if (nick) {
    if (city.length >= 2) out.add(initials + nick[0].toUpperCase())
    out.add(first3 + nick[0].toUpperCase())
  }
  return [...out].filter((c) => c.length >= 2)
}
/** 2 = a code of this team equals the segment, 1 = one is a prefix of the other, 0 = no match. */
function codeScore(seg: string, name: string): number {
  if (seg.length < 2 || seg.length > 5) return 0
  let best = 0
  for (const c of teamCodes(name)) {
    if (c === seg) return 2
    if (seg.length >= 3 && ((c.length >= 2 && seg.startsWith(c)) || (c.length >= 3 && c.startsWith(seg)))) best = 1
  }
  return best
}
/**
 * Which of the two teams a Kalshi moneyline or spread ticker is about, read
 * from its last segment ("…LAABOS-LAA2" → the Angels, "…MINCWS-CWS" → the
 * White Sox). Undefined when the segment is a number (totals) or ambiguous.
 */
export function subjectTeam(ticker: string, home: string, away: string): string | undefined {
  const parts = ticker.toUpperCase().split('-')
  const code = (parts[2] ?? '').replace(/[^A-Z].*$/, '')
  if (!code) return undefined
  const h = codeScore(code, home)
  const a = codeScore(code, away)
  if (h === a) return undefined
  return h > a ? home : away
}
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
/** Kalshi's event segment: YYMONDD[HHMM] then the away and home codes ("26SEP061820MINCWS"). */
export function parseEventSegment(ticker: string): { dateMs?: number; ymd?: string; hhmm?: string; teams: string } | undefined {
  const seg = ticker.toUpperCase().split('-')[1]
  if (!seg) return undefined
  const m = seg.match(/^(\d{2})([A-Z]{3})(\d{2})(\d{4})?([A-Z]+)$/)
  if (!m) return { teams: seg.replace(/[^A-Z]/g, '') }
  const month = MONTHS.indexOf(m[2])
  if (month < 0) return { teams: m[5] }
  const ymd = `${2000 + Number(m[1])}-${String(month + 1).padStart(2, '0')}-${m[3]}`
  return { dateMs: Date.UTC(2000 + Number(m[1]), month, Number(m[3]), 12), ymd, hhmm: m[4], teams: m[5] }
}
const ET_PARTS = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
/** Naive Eastern-time tuple of an instant, as minutes since the epoch of the naive calendar. */
function etNaiveMinutes(ms: number): number {
  const p = Object.fromEntries(ET_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) / 60_000
}
/**
 * Does the ticker's stamp name this start? Kalshi writes daily-series
 * tickers as the Eastern date and time ("26SEP062210" = Sep 6, 22:10 ET), so
 * with a time present the start must sit within three hours of it in ET —
 * which rejects the previous night of the same series. Weekly sports carry
 * the date only; those stamps were seen as the ET date (MLB) and the UTC
 * date (college football), so either is accepted.
 */
export function tickerDateMatches(ymd: string, startMs: number, hhmm?: string): boolean {
  if (hhmm && /^\d{4}$/.test(hhmm)) {
    const [y, mo, d] = ymd.split('-').map(Number)
    const stamp = Date.UTC(y, mo - 1, d, Number(hhmm.slice(0, 2)), Number(hhmm.slice(2))) / 60_000
    return Math.abs(stamp - etNaiveMinutes(startMs)) <= 180
  }
  const et = etNaiveMinutes(startMs) * 60_000
  return new Date(et).toISOString().slice(0, 10) === ymd || new Date(startMs).toISOString().slice(0, 10) === ymd
}
function codeMatches(seg: string, name: string): boolean {
  return codeScore(seg, name) > 0
}
/**
 * Does this Kalshi ticker name this game? The team segment must split into an
 * away code and a home code (either order), each matching its own team, and
 * the ticker's date must sit within 36 hours of the event's start when both
 * are known. The old "each team's code appears somewhere" test paired the
 * NFL's WAS@PHI ladder with Washington vs Washington State (2026-09-06).
 */
export function isSameGame(ticker: string, home: string, away: string, startMs?: number): boolean {
  const seg = parseEventSegment(ticker)
  if (!seg) return false
  if (startMs !== undefined && seg.ymd && !tickerDateMatches(seg.ymd, startMs, seg.hhmm)) return false
  const t = seg.teams
  for (let k = 2; k <= t.length - 2; k++) {
    const left = t.slice(0, k)
    const right = t.slice(k)
    if ((codeMatches(left, away) && codeMatches(right, home)) || (codeMatches(left, home) && codeMatches(right, away))) return true
  }
  return false
}
/** An observation whose Kalshi series and matched event disagree (league, date, or the game itself) is never graded or traded. */
export function observationConsistent(o: { kalshiId: string; sportKey?: string; homeTeam?: string; awayTeam?: string; market?: string; eventStartsAt?: number }): boolean {
  const sport = sportFor(o.kalshiId.toUpperCase().split('-')[0])
  if (sport && o.sportKey && sport !== o.sportKey) return false
  const seg = parseEventSegment(o.kalshiId)
  if (seg?.ymd && o.eventStartsAt !== undefined && !tickerDateMatches(seg.ymd, o.eventStartsAt, seg.hhmm)) return false
  if (o.homeTeam && o.awayTeam && !isSameGame(o.kalshiId, o.homeTeam, o.awayTeam, o.eventStartsAt)) return false
  return true
}

/**
 * Conservative team matching: every significant word of the team name must
 * appear in the market question (city OR nickname alone is not enough for
 * pairs like "New York"). Lowercased containment on words ≥4 chars, with a
 * fallback to the last word (the nickname) for very short names.
 */
export function teamInQuestion(team: string, question: string): boolean {
  const q = question.toLowerCase()
  const nick = team.toLowerCase().split(/\s+/).pop() ?? ''
  // Word-boundary nickname match ("Chiefs" in "Will the Chiefs beat…").
  // Nicknames are unique within a league, the caller requires BOTH teams to
  // match, and game start must sit within 12h of market close — so the
  // nickname alone is safe. City fragments alone are NOT (Kansas ≠ Chiefs).
  if (nick.length >= 4 && new RegExp(`\\b${nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q)) return true
  const words = team.toLowerCase().split(/\s+/).filter((w) => w.length >= 4)
  if (words.length === 0) return q.includes(team.toLowerCase())
  return words.filter((w) => q.includes(w)).length >= words.length
}


/**
 * Kalshi game-series prefix → The Odds API sport key.
 *
 * Derived from what Kalshi ACTUALLY lists, not from what a US reader would
 * assume: on a Monday morning its liquid single-game markets are Korean and
 * Japanese baseball and South American / Iberian soccer, with no MLB game
 * markets listed at all. A hardcoded NFL/MLB/NBA list polled six sports that
 * had no counterpart on Kalshi and matched nothing across 142 attempts.
 */
const SERIES_TO_SPORT: Record<string, string> = {
  KXMLBGAME: 'baseball_mlb',
  KXKBOGAME: 'baseball_kbo',
  KXNPBGAME: 'baseball_npb',
  KXNFLGAME: 'americanfootball_nfl',
  KXNCAAFGAME: 'americanfootball_ncaaf',
  KXNBAGAME: 'basketball_nba',
  KXNHLGAME: 'icehockey_nhl',
  KXMLSGAME: 'soccer_usa_mls',
  KXLALIGAGAME: 'soccer_spain_la_liga',
  KXBRASILEIROGAME: 'soccer_brazil_campeonato',
  KXLIGAPORTUGALGAME: 'soccer_portugal_primeira_liga',
  KXARGPREMDIVGAME: 'soccer_argentina_primera_division',
  KXLIGAMXGAME: 'soccer_mexico_ligamx',
  KXCHLLDPGAME: 'soccer_chile_campeonato'
}

/**
 * Sports whose Odds-API `/scores` feed never reports a finished game, so the
 * poll spends credits and returns nothing.
 *
 * Measured 2026-09-10 from the `[anchor] scores` instrumentation added the day
 * before (backlog 43): over five polls in 24 h, `baseball_npb` returned 1-6
 * events and `baseball_kbo` 1-4, with **0 completed with scores on every poll**,
 * against 84 and 35 pending observations. Every other league graded from the
 * same feed in the same window (MLS 14 completed, NCAAF 1, NFL 1, Primeira Liga
 * 1, Argentina 2), so this is per-league coverage, not a matcher bug. These two
 * grade from Kalshi's own settlement instead — see `gradeFromKalshi`.
 */
const NO_SCORES_FEED = new Set(['baseball_npb', 'baseball_kbo'])

const SPORT_POLL_MS = 2 * 3600_000
const KALSHI_PUBLIC = 'https://api.elections.kalshi.com/trade-api/v2'
const LADDER_SUFFIXES = ['GAME', 'SPREAD', 'TOTAL', '1HTOTAL', '1HSPREAD']
/** Every Kalshi sports series the anchor can price: each league's game series plus its spread and total ladders. */
export const SPORTS_SERIES: string[] = Object.keys(SERIES_TO_SPORT).flatMap((g) => LADDER_SUFFIXES.map((s) => g.replace(/GAME$/, s)))
/** Odds-API sport for a Kalshi series prefix, whichever ladder it is (KXNFLSPREAD -> americanfootball_nfl). */
export function sportFor(prefix: string): string | undefined {
  return SERIES_TO_SPORT[prefix.toUpperCase().replace(/(1H|1Q)?(SPREAD|TOTAL|GAME)$/, '') + 'GAME']
}
interface RawKalshiMarket {
  ticker?: string
  event_ticker?: string
  title?: string
  yes_bid_dollars?: string
  yes_ask_dollars?: string
  last_price_dollars?: string
  close_time?: string
  exchange_index?: number
  /** 'yes' | 'no' on a settled market; empty or absent while it is open or void. */
  result?: string
}
/** Leagues where Pinnacle (region "eu") is worth the second credit near game time. */
const MAJOR_LEAGUES = new Set(['americanfootball_nfl', 'americanfootball_ncaaf', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl', 'soccer_spain_la_liga', 'soccer_usa_mls'])
const MAX_LEAGUES_PER_SCAN = 4
const NEAR_START_MS = 5 * 3600_000
const BASE_CADENCE_MS = 8 * 3600_000
const NEAR_CADENCE_MS = 3600_000

/** Key under which today's spent credits are kept in the persisted poll map. */
/** The share of a daily credit allowance spendable by this hour of the UTC day, never below a dozen credits. */
export function pacedBudget(dailyBudget: number, now: number): number {
  // A small plan (free tier, ~16 credits a day) cannot be paced meaningfully; spend it as it comes.
  if (dailyBudget <= 100) return dailyBudget
  return Math.max(12, dailyBudget * Math.min(1, (new Date(now).getUTCHours() + 1) / 24))
}

export function spentKey(now: number): string {
  return `__spentDay:${new Date(now).toISOString().slice(0, 10)}`
}

/**
 * Which leagues to poll now, and with which regions, paced to the plan's
 * monthly credit allowance (one credit per region per request). At the free
 * tier (500) credits go where they buy information: the leagues with the most
 * Kalshi markets, only when a game closes within a day, hourly (and with
 * Pinnacle's region) once a game is within five hours of its close — the
 * closing line, the number a sports edge is measured against — and every
 * eight hours otherwise. A bigger plan scales the league count, shortens both
 * cadences (30- and 10-minute floors), adds Pinnacle's region to every
 * request, and a daily budget (allowance / 31) caps spending whatever the
 * schedule asks for.
 */
export function pollPlan(markets: { seriesTicker?: string; id: string; closeTime?: number }[], pollAt: Record<string, number>, now: number, creditsPerMonth = 500): { sport: string; regions: string; markets: string; cost: number }[] {
  const scale = Math.max(1, Math.min(40, creditsPerMonth / 500))
  const maxLeagues = Math.max(MAX_LEAGUES_PER_SCAN, Math.min(12, Math.round(MAX_LEAGUES_PER_SCAN * Math.sqrt(scale))))
  const baseCadence = Math.max(30 * 60_000, BASE_CADENCE_MS / scale)
  const nearCadence = Math.max(10 * 60_000, NEAR_CADENCE_MS / scale)
  const windowMs = (scale >= 4 ? 48 : 24) * 3600_000
  const euAlways = creditsPerMonth >= 5000
  // Spreads and totals ride along from 5,000 credits: Kalshi lists more spread
  // and total strikes than moneylines, each anchorable to the book's line.
  const marketsList = creditsPerMonth >= 5000 ? 'h2h,spreads,totals' : 'h2h'
  const marketCount = marketsList.split(',').length
  const dailyBudget = creditsPerMonth / 31
  // Pace the day's allowance through the UTC day (floor: a dozen credits so a
  // small plan still polls). Unpaced, twelve leagues at six credits every
  // half hour drained 644 of 645 credits by mid-morning UTC and left the US
  // afternoon and evening games unpolled (2026-09-07).
  const paced = pacedBudget(dailyBudget, now)
  let spent = pollAt[spentKey(now)] ?? 0
  const bySport = new Map<string, number[]>()
  for (const m of markets) {
    const prefix = (m.seriesTicker ?? m.id).toUpperCase().split('-')[0]
    const sport = sportFor(prefix)
    if (!sport) continue
    const arr = bySport.get(sport) ?? []
    arr.push(m.closeTime ?? Number.POSITIVE_INFINITY)
    bySport.set(sport, arr)
  }
  // Leagues with a game closing soonest first (closing lines buy the most), then by market count.
  const ranked = [...bySport.entries()]
    .sort((a, b) => Math.min(...a[1]) - Math.min(...b[1]) || b[1].length - a[1].length)
    .slice(0, maxLeagues)
  const out: { sport: string; regions: string; markets: string; cost: number }[] = []
  for (const [sport, closes] of ranked) {
    const soonest = Math.min(...closes)
    if (!(soonest - now < windowMs)) continue
    const nearStart = soonest - now < NEAR_START_MS
    const cadence = nearStart ? nearCadence : baseCadence
    if (now - (pollAt[sport] ?? 0) < cadence) continue
    const regions = euAlways || (nearStart && MAJOR_LEAGUES.has(sport)) ? 'us,eu' : 'us'
    const cost = regions.split(',').length * marketCount
    if (spent + cost > paced) break
    spent += cost
    out.push({ sport, regions, markets: marketsList, cost })
  }
  return out
}

/** Odds-API sport keys worth polling for THIS universe (one credit each). */
export function sportsInUniverse(markets: { seriesTicker?: string; id: string }[]): string[] {
  const keys = new Set<string>()
  for (const m of markets) {
    const prefix = (m.seriesTicker ?? m.id).toUpperCase().split('-')[0]
    const sport = sportFor(prefix)
    if (sport) keys.add(sport)
  }
  return [...keys]
}

/**
 * Kalshi game markets mostly arrive with NO category (the event-categories
 * cache misses them), so detect by series shape too: game series embed
 * 'GAME' in the ticker (KXMLBGAME, KXNFLGAME, …).
 */
export function isSportsMarket(m: { category?: string; seriesTicker?: string; id?: string }): boolean {
  if (/sport/i.test(m.category ?? '')) return true
  const s = (m.seriesTicker ?? m.id ?? '').toUpperCase()
  return /GAME/.test(s.split('-')[0])
}

export class SportsAnchor {
  private http = new HttpClient({ baseUrl: 'https://api.the-odds-api.com' })
  private kalshi = new HttpClient({ baseUrl: KALSHI_PUBLIC, rateLimit: 100 })
  private kalshiCache: { at: number; markets: VenueMarket[] } | null = null
  private emptyUntil = new Map<string, number>()

  /**
   * Every open Kalshi sports market in the anchored leagues (moneyline, spread
   * and total ladders), refreshed every ten minutes from the public series
   * endpoints. Independent of the trader's ranked universe, which keeps three
   * markets per series and so never carried a whole ladder (2026-09-06: the
   * anchor went quiet for hours while the exchange listed hundreds).
   */
  async kalshiSports(now = Date.now()): Promise<VenueMarket[]> {
    if (this.kalshiCache && now - this.kalshiCache.at < 10 * 60_000) return this.kalshiCache.markets
    const out: VenueMarket[] = []
    for (const series of SPORTS_SERIES) {
      if ((this.emptyUntil.get(series) ?? 0) > now) continue
      let rows: RawKalshiMarket[] = []
      try {
        rows = (await this.kalshi.get<{ markets?: RawKalshiMarket[] }>(`/markets?series_ticker=${series}&status=open&limit=200`)).markets ?? []
      } catch {
        this.emptyUntil.set(series, now + 60 * 60_000)
        continue
      }
      if (rows.length === 0) {
        this.emptyUntil.set(series, now + 6 * 3600_000)
        continue
      }
      for (const r of rows) {
        if (!r.ticker) continue
        const bid = parseFloat(r.yes_bid_dollars ?? '')
        const ask = parseFloat(r.yes_ask_dollars ?? '')
        const last = parseFloat(r.last_price_dollars ?? '')
        const probability = bid > 0 && ask > 0 && ask > bid ? (bid + ask) / 2 : Number.isFinite(last) && last > 0 ? last : undefined
        out.push({
          venue: 'kalshi',
          id: r.ticker,
          question: r.title ?? r.ticker,
          status: 'open',
          probability,
          closeTime: r.close_time ? Date.parse(r.close_time) : undefined,
          eventTicker: r.event_ticker,
          seriesTicker: series,
          exchangeIndex: r.exchange_index
        })
      }
    }
    this.kalshiCache = { at: now, markets: out }
    return out
  }

  /**
   * Poll due sports and return gap observations against the supplied Kalshi
   * markets. Costs zero credits when no sports market resembles a match.
   */
  async poll(
    apiKey: string,
    kalshiSports: VenueMarket[],
    stats: SportsShadowStats,
    /** PERSISTED per-sport throttle. An in-memory map re-polls every sport on
     * each restart, which burned ~140 credits of a 500/month free tier in one
     * day of frequent restarts. */
    pollAt: Record<string, number>,
    /** The plan's monthly credit allowance; the schedule paces itself to it. */
    creditsPerMonth = 500
  ): Promise<AnchorObservation[]> {
    if (!apiKey || kalshiSports.length === 0) return []
    const out: AnchorObservation[] = []
    const now = Date.now()
    // Only spend credits where they buy information (see pollPlan).
    void SPORT_POLL_MS
    for (const { sport, regions, markets: mk, cost } of pollPlan(kalshiSports, pollAt, now, creditsPerMonth)) {
      pollAt[sport] = now
      pollAt[spentKey(now)] = (pollAt[spentKey(now)] ?? 0) + cost
      let events: OddsEvent[]
      try {
        events = await this.http.get<OddsEvent[]>(
          `/v4/sports/${sport}/odds/?apiKey=${encodeURIComponent(apiKey)}&regions=${regions}&markets=${mk}&oddsFormat=decimal`
        )
        stats.polls++
        stats.lastPollAt = now
        const seen: [string, string, OddsEvent[]] = [sport, regions, events]
        this.lastEvents = [...this.lastEvents.filter((x) => x[0] !== sport), seen].slice(-12)
      } catch (err) {
        // Out-of-season sports 404/422 — record once, skip quietly.
        stats.lastError = `${sport}: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`
        continue
      }
      // Kalshi lists ONE market per team ("Yankees win"), grouped by event —
      // so match at the EVENT level: home team names one member market, away
      // names a sibling. Each member's YES then anchors to its own team's
      // devigged fair.
      const byEvent = new Map<string, VenueMarket[]>()
      for (const m of kalshiSports) {
        if (m.probability === undefined) continue
        const ev = m.eventTicker ?? m.id
        const arr = byEvent.get(ev) ?? []
        arr.push(m)
        byEvent.set(ev, arr)
      }
      for (const ev of events) {
        if (!ev.home_team || !ev.away_team) continue
        const consensus = consensusForEvent(ev)
        if (!consensus) continue
        const fairFor = consensus.fairFor
        const lines = lineConsensus(ev)
        const start = ev.commence_time ? Date.parse(ev.commence_time) : undefined
        // Spread and total ladders: one Kalshi market per strike, priced where a
        // book quotes that exact line ("Kansas City wins by over 7.5 points?"
        // <-> KC -7.5; "Over 63.5 points scored?" <-> total 63.5).
        for (const group of byEvent.values()) {
          // A ladder anchors only to events of its own league (KXNFL* never to a college game).
          if (sportFor((group[0].seriesTicker ?? group[0].id).toUpperCase().split('-')[0]) !== sport) continue
          const close = group[0].closeTime
          if (start !== undefined && close !== undefined) {
            if (start > close + 3600_000) continue
            if (close - start > 7 * 24 * 3600_000) continue
          }
          for (const m of group) {
            if (m.probability === undefined) continue
            const line = parseLineMarket(m.question)
            if (!line) continue
            let fairProb: number | undefined
            let team: string | undefined
            // Both teams' codes must sit in the ticker and the subject team
            // is read from it too. Question text alone paired "Los Angeles A
            // wins by over 1.5 runs?" with an MLS match (2026-09-07) and
            // bought the Angels' run line at a soccer fair value.
            if (!isSameGame(m.id, ev.home_team, ev.away_team, start)) continue
            if (line.kind === 'spread') {
              team = subjectTeam(m.id, ev.home_team, ev.away_team)
              if (!team) continue
              fairProb = lines.spread.get(`${team}|${line.point}`)
            } else {
              if (!(start !== undefined && close !== undefined && close - start < 26 * 3600_000)) continue
              fairProb = lines.total.get(`over|${line.point}`)
            }
            if (fairProb === undefined || fairProb <= 0 || fairProb >= 1) continue
            out.push({
              kalshiId: m.id,
              question: m.question.slice(0, 80),
              kalshiMid: m.probability,
              fairProb: Math.round(fairProb * 10000) / 10000,
              gapCents: Math.round((m.probability - fairProb) * 10000) / 100,
              bookmaker: `line-consensus:${lines.books} books`,
              sportKey: sport,
              ts: now,
              eventId: ev.id,
              homeTeam: ev.home_team,
              awayTeam: ev.away_team,
              market: line.kind,
              team,
              point: line.point,
              eventStartsAt: start
            })
          }
        }
        for (const group of byEvent.values()) {
          // A game must START BEFORE its market closes; Kalshi stamps game
          // markets well after the event (a KBO market closing 66h out for a
          // game starting 48h earlier). An absolute ±36h skew guard rejected
          // exact team-pair matches, so bound the direction instead: start
          // no later than close (1h grace) and no more than a week before.
          // The two-nickname pairing inside one event carries the precision.
          const close = group[0].closeTime
          if (start !== undefined && close !== undefined) {
            if (start > close + 3600_000) continue
            if (close - start > 7 * 24 * 3600_000) continue
          }
          // Moneyline legs only — spreads/totals/periods share the event and
          // the team names but are NOT priced by h2h odds.
          if (sportFor((group[0].seriesTicker ?? group[0].id).toUpperCase().split('-')[0]) !== sport) continue
          if (!isSameGame(group[0].id, ev.home_team!, ev.away_team!, start)) continue
          const legs = group.filter((m) => isMoneylineWin(m.question, ev.home_team!, ev.away_team!))
          const homeM = legs.find((m) => subjectTeam(m.id, ev.home_team!, ev.away_team!) === ev.home_team)
          const awayM = legs.find((m) => subjectTeam(m.id, ev.home_team!, ev.away_team!) === ev.away_team)
          if (!homeM || !awayM || homeM === awayM) continue
          for (const [m, team] of [[homeM, ev.home_team], [awayM, ev.away_team]] as const) {
            const fairProb = fairFor(team)
            if (fairProb === undefined || fairProb <= 0 || fairProb >= 1 || m.probability === undefined) continue
            out.push({
              kalshiId: m.id,
              question: m.question.slice(0, 80),
              kalshiMid: m.probability,
              fairProb: Math.round(fairProb * 10000) / 10000,
              gapCents: Math.round((m.probability - fairProb) * 10000) / 100,
              bookmaker: ('consensus-v1:' + consensus.books.join(',')).slice(0, 120),
              sportKey: sport,
              ts: now,
              eventId: ev.id,
              homeTeam: ev.home_team,
              awayTeam: ev.away_team,
              market: 'h2h',
              team,
              eventStartsAt: start
            })
          }
        }
      }
    }
    // Alternate lines (paid plans): price the rest of each Kalshi ladder for
    // games within five hours, two markets per event per region, throttled to
    // one read per event per 30 minutes inside the daily budget.
    if (creditsPerMonth >= 5000) {
      const budget = pacedBudget(creditsPerMonth / 31, now)
      for (const [sport, regions, events] of this.lastEvents) {
        for (const ev of events) {
          if (!ev.id || !ev.home_team || !ev.away_team) continue
          const start = ev.commence_time ? Date.parse(ev.commence_time) : undefined
          if (start === undefined || start - now > NEAR_START_MS || now - start > 5 * 3600_000) continue
          const ladder = kalshiSports.filter(
            (m) => m.probability !== undefined && sportFor((m.seriesTicker ?? m.id).toUpperCase().split('-')[0]) === sport && parseLineMarket(m.question) && isSameGame(m.id, ev.home_team!, ev.away_team!, start)
          )
          if (ladder.length === 0) continue
          const altKey = `__alt:${ev.id}`
          if (now - (pollAt[altKey] ?? 0) < 30 * 60_000) continue
          const cost = 2 * regions.split(',').length
          if ((pollAt[spentKey(now)] ?? 0) + cost > budget) break
          pollAt[altKey] = now
          pollAt[spentKey(now)] = (pollAt[spentKey(now)] ?? 0) + cost
          let alt: OddsEvent
          try {
            alt = await this.http.get<OddsEvent>(`/v4/sports/${sport}/events/${encodeURIComponent(ev.id)}/odds?apiKey=${encodeURIComponent(apiKey)}&regions=${regions}&markets=alternate_spreads,alternate_totals&oddsFormat=decimal`)
          } catch {
            continue
          }
          const lines = lineConsensus({ ...alt, home_team: ev.home_team, away_team: ev.away_team })
          const priced = new Set(out.filter((o) => o.eventId === ev.id).map((o) => o.kalshiId))
          for (const m of ladder) {
            if (priced.has(m.id)) continue
            const line = parseLineMarket(m.question)!
            let fairProb: number | undefined
            let team: string | undefined
            if (line.kind === 'spread') {
              team = subjectTeam(m.id, ev.home_team, ev.away_team)
              if (!team) continue
              fairProb = lines.spread.get(`${team}|${line.point}`)
            } else fairProb = lines.total.get(`over|${line.point}`)
            if (fairProb === undefined || fairProb <= 0 || fairProb >= 1) continue
            out.push({
              kalshiId: m.id,
              question: m.question.slice(0, 80),
              kalshiMid: m.probability!,
              fairProb: Math.round(fairProb * 10000) / 10000,
              gapCents: Math.round((m.probability! - fairProb) * 10000) / 100,
              bookmaker: `alternate-lines:${lines.books} books`,
              sportKey: sport,
              ts: now,
              eventId: ev.id,
              homeTeam: ev.home_team,
              awayTeam: ev.away_team,
              market: line.kind,
              team,
              point: line.point,
              eventStartsAt: start
            })
          }
        }
      }
    }
    for (const o of out) {
      stats.n++
      stats.sumGapCents += o.gapCents
      stats.sumAbsGapCents += Math.abs(o.gapCents)
    }
    stats.matched = out.length
    // Keep the latest observation per market for score grading (the closing-line comparison).
    const pending = new Map((stats.pending ?? []).map((o) => [o.kalshiId, o]))
    for (const o of out) if (o.eventId) pending.set(o.kalshiId, o)
    stats.pending = [...pending.values()].filter((o) => now - o.ts < 4 * 24 * 3600_000).slice(-600)
    return out
  }

  /** Events seen on the last poll per sport (with the regions used), for the alternate-line reads. */
  private lastEvents: [string, string, OddsEvent[]][] = []

  /**
   * Grade pending observations against final scores (2 credits per sport, at
   * most every six hours) and write one row per graded market with the P&L
   * of the rule under test: buy the cheap side at Kalshi's mid when the gap is
   * 3c or more, filled as a maker at the mid. This is the anchor's running
   * out-of-sample test; the maintenance session reads anchor-grades.jsonl.
   */
  async grade(apiKey: string, stats: SportsShadowStats, pollAt: Record<string, number>, creditsPerMonth: number, now: number, write: (row: Record<string, unknown>) => void): Promise<void> {
    // A matcher fix must also purge the queue: never grade a pair the matcher would no longer make.
    const pending = (stats.pending ?? []).filter(observationConsistent)
    stats.pending = pending
    if (!apiKey || pending.length === 0) return
    const budget = Math.max(16, creditsPerMonth / 31)
    for (const sport of [...new Set(pending.map((o) => o.sportKey))]) {
      if (NO_SCORES_FEED.has(sport)) continue
      const key = `__scores:${sport}`
      if (now - (pollAt[key] ?? 0) < 6 * 3600_000) continue
      if ((pollAt[spentKey(now)] ?? 0) + 2 > budget) break
      pollAt[key] = now
      pollAt[spentKey(now)] = (pollAt[spentKey(now)] ?? 0) + 2
      let rows: ScoreEvent[]
      try {
        rows = await this.http.get<ScoreEvent[]>(`/v4/sports/${sport}/scores/?apiKey=${encodeURIComponent(apiKey)}&daysFrom=2`)
      } catch {
        continue
      }
      const byId = new Map(rows.filter((r) => r.completed && r.id && r.scores).map((r) => [r.id!, r]))
      // Silent-instrument guard (2026-09-09): grading wrote nothing for 29 h
      // while spending 2 credits per sport per 6 h. All 44 rows on file are
      // NCAAF; the 91 finished-but-ungraded observations are NPB/KBO/MLS. The
      // suspicion is that the scores feed's coverage is narrower than the odds
      // feed's, so byId is empty for those sports — this line settles it
      // rather than leaving the poll to fail in silence.
      const mine = pending.filter((o) => o.sportKey === sport && o.resultYes === undefined)
      const overlap = mine.filter((o) => o.eventId && byId.has(o.eventId)).length
      console.log(
        `[anchor] scores ${sport}: ${rows.length} events, ${byId.size} completed with scores; ${mine.length} pending, ${overlap} matchable`
      )
      for (const o of pending) {
        if (o.sportKey !== sport || !o.eventId || o.resultYes !== undefined) continue
        const r = byId.get(o.eventId)
        if (!r?.scores) continue
        const sc = (name?: string): number => {
          const s = r.scores!.find((x) => x.name === name)
          return s ? parseFloat(s.score ?? '') : Number.NaN
        }
        const g = gradeObservation(o, sc(o.homeTeam), sc(o.awayTeam))
        if (!g) continue
        o.resultYes = g.yesWon
        stats.gradedN = (stats.gradedN ?? 0) + 1
        stats.gradedBrier = (stats.gradedBrier ?? 0) + (o.fairProb - (g.yesWon ? 1 : 0)) ** 2
        if (g.ruleSide) {
          stats.ruleN = (stats.ruleN ?? 0) + 1
          stats.ruleNet = Math.round(((stats.ruleNet ?? 0) + g.rulePnl) * 10000) / 10000
        }
        write({ gradedAt: now, ...o, yesWon: g.yesWon, ruleSide: g.ruleSide, rulePnl: g.rulePnl, homeScore: sc(o.homeTeam), awayScore: sc(o.awayTeam) })
      }
    }
    stats.pending = pending.filter((o) => o.resultYes === undefined && now - o.ts < 4 * 24 * 3600_000)
  }

  /**
   * Grade the leagues the scores feed cannot see (`NO_SCORES_FEED`) against
   * Kalshi's own settlement, which is free and is the ledger of record anyway.
   *
   * One public GET per Kalshi series per six hours, no Odds API credits. The
   * settled market carries `result` ('yes' | 'no'), which IS the YES-leg
   * outcome for the exact ticker the observation was recorded on, so no team
   * or score matching is involved — the class of bug that produced the
   * ungradable NPB/KBO backlog cannot arise here.
   */
  async gradeFromKalshi(stats: SportsShadowStats, pollAt: Record<string, number>, now: number, write: (row: Record<string, unknown>) => void): Promise<void> {
    const pending = (stats.pending ?? []).filter(observationConsistent)
    stats.pending = pending
    const wanted = pending.filter((o) => NO_SCORES_FEED.has(o.sportKey) && o.resultYes === undefined)
    if (wanted.length === 0) return
    for (const series of [...new Set(wanted.map((o) => o.kalshiId.toUpperCase().split('-')[0]))]) {
      const key = `__kalshiSettled:${series}`
      if (now - (pollAt[key] ?? 0) < 6 * 3600_000) continue
      pollAt[key] = now
      let rows: RawKalshiMarket[]
      try {
        rows = (await this.kalshi.get<{ markets?: RawKalshiMarket[] }>(`/markets?series_ticker=${series}&status=settled&limit=200`)).markets ?? []
      } catch {
        continue
      }
      const byTicker = new Map(rows.filter((r) => r.ticker && (r.result === 'yes' || r.result === 'no')).map((r) => [r.ticker!, r.result!]))
      const mine = wanted.filter((o) => o.kalshiId.toUpperCase().split('-')[0] === series)
      const overlap = mine.filter((o) => byTicker.has(o.kalshiId)).length
      console.log(`[anchor] kalshi-settled ${series}: ${rows.length} settled, ${byTicker.size} with a result; ${mine.length} pending, ${overlap} matchable`)
      for (const o of mine) {
        const result = byTicker.get(o.kalshiId)
        if (!result) continue
        const g = ruleOutcome(o, result === 'yes')
        o.resultYes = g.yesWon
        stats.gradedN = (stats.gradedN ?? 0) + 1
        stats.gradedBrier = (stats.gradedBrier ?? 0) + (o.fairProb - (g.yesWon ? 1 : 0)) ** 2
        if (g.ruleSide) {
          stats.ruleN = (stats.ruleN ?? 0) + 1
          stats.ruleNet = Math.round(((stats.ruleNet ?? 0) + g.rulePnl) * 10000) / 10000
        }
        write({ gradedAt: now, ...o, yesWon: g.yesWon, ruleSide: g.ruleSide, rulePnl: g.rulePnl, gradedFrom: 'kalshi-settlement' })
      }
    }
    stats.pending = pending.filter((o) => o.resultYes === undefined && now - o.ts < 4 * 24 * 3600_000)
  }
}

/** Pure: did the Kalshi YES side win, and what would the 3c rule have made per contract at the mid? */
export function gradeObservation(o: AnchorObservation, homeScore: number, awayScore: number): { yesWon: boolean; ruleSide: 'YES' | 'NO' | null; rulePnl: number } | null {
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null
  let yesWon: boolean
  if (o.market === 'total') {
    if (o.point === undefined) return null
    yesWon = homeScore + awayScore > o.point
  } else {
    if (!o.team || !o.homeTeam) return null
    const mine = o.team === o.homeTeam ? homeScore : awayScore
    const theirs = o.team === o.homeTeam ? awayScore : homeScore
    yesWon = o.market === 'spread' && o.point !== undefined ? mine - theirs > o.point : mine > theirs
  }
  return ruleOutcome(o, yesWon)
}

/**
 * Pure: the rule under test, given a known YES-leg outcome. Split out so the
 * Kalshi-settlement path (`gradeFromKalshi`), which knows `yesWon` directly and
 * never sees a score, books P&L by the identical arithmetic.
 */
export function ruleOutcome(o: { gapCents: number; kalshiMid: number }, yesWon: boolean): { yesWon: boolean; ruleSide: 'YES' | 'NO' | null; rulePnl: number } {
  if (Math.abs(o.gapCents) < 3) return { yesWon, ruleSide: null, rulePnl: 0 }
  const side: 'YES' | 'NO' = o.gapCents > 0 ? 'NO' : 'YES'
  const pnl = side === 'YES' ? (yesWon ? 1 - o.kalshiMid : -o.kalshiMid) : yesWon ? -(1 - o.kalshiMid) : o.kalshiMid
  return { yesWon, ruleSide: side, rulePnl: Math.round(pnl * 10000) / 10000 }
}

