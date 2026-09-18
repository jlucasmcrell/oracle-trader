/**
 * Polymarket smart-money consensus, traded on Kalshi.
 *
 * The signal is produced outside the app by `scripts/polymarket_consensus.py`
 * (hourly Windows task `OracleTrader-PolyConsensus`, read-only): when >= 3 of
 * the top-100 lifetime-profit Polymarket wallets sit on the same side of the
 * same market within 48 h it appends a row to
 * `data/polymarket-consensus/signals.jsonl`, with the Kalshi market its
 * matcher found for the signalled side and that market's book at signal time.
 *
 * The entry rule below is fixed in `docs/PREREGISTERED-polymarket-consensus.md`
 * (2026-09-13) and is not tunable from the panel: Kalshi only, taker at the
 * ask on the consensus side, signal at most 24 h old, market at least 6 h from
 * close, ask inside 10-90c, and refused once Kalshi has run more than 10c past
 * the Polymarket price the +6.4c/contract was measured at. Hold to settlement.
 *
 * This module is pure plus one file read; no Electron, no network, so the rule
 * is testable without either.
 */
import { readFileSync, statSync } from 'node:fs'

export interface ConsensusKalshiMatch {
  event?: string
  score?: number
  /** Kalshi ticker whose YES side is the signalled outcome; null when only the event matched. */
  market?: string | null
  yes_bid?: number | null
  yes_ask?: number | null
}

export interface ConsensusSignalRow {
  /** ISO time the shadow emitted the signal (once per conditionId). */
  ts: string
  conditionId: string
  title: string
  /** The Polymarket outcome the wallets are on; the matched Kalshi market's YES side. */
  outcome: string
  eventSlug?: string
  n_wallets?: number
  /** Polymarket price when the signal fired — the price the edge was measured against. */
  poly_price?: number | null
  kalshi?: ConsensusKalshiMatch | null
}

export interface ConsensusRule {
  maxSignalAgeHours: number
  minHoursToClose: number
  /** Ceiling on hours to close (round 96, amendment of 2026-09-14): a position that cannot settle inside
   *  the test window counts for nothing and holds a long-horizon slot for the whole test. */
  maxHoursToClose: number
  minPrice: number
  maxPrice: number
  maxDriftCents: number
}

/** The pre-registered rule. Defaults, not suggestions — see the doc named above. */
export const CONSENSUS_RULE: ConsensusRule = {
  maxSignalAgeHours: 24,
  minHoursToClose: 6,
  maxHoursToClose: 21 * 24,
  minPrice: 0.1,
  maxPrice: 0.9,
  maxDriftCents: 10
}

export type ConsensusRefusal =
  | 'no-match'
  | 'no-ask'
  | 'stale-signal'
  | 'too-close'
  | 'too-far'
  | 'price-high'
  | 'price-low'
  | 'drifted'

/**
 * Why this signal must not be traded, or null to take it. Every gate here is
 * from the pre-registration; nothing is inferred from the arm's own results.
 *
 * `ask` is the LIVE Kalshi ask we would pay now, `polyPrice` the Polymarket
 * price at signal. Drift is measured live-minus-signal so that a market that
 * has already run in our direction — the case where the consensus is priced
 * in and the graded edge no longer exists — is refused, while one that has
 * moved the other way (cheaper than when the wallets bought) is not.
 */
export function consensusRefusal(
  inp: { market?: string | null; ask?: number | null; polyPrice?: number | null; ageHours: number; hoursToClose: number },
  rule: ConsensusRule = CONSENSUS_RULE
): ConsensusRefusal | null {
  if (!inp.market) return 'no-match'
  if (inp.ask === undefined || inp.ask === null || !Number.isFinite(inp.ask)) return 'no-ask'
  if (!(inp.ageHours <= rule.maxSignalAgeHours)) return 'stale-signal'
  if (!(inp.hoursToClose >= rule.minHoursToClose)) return 'too-close'
  if (!(inp.hoursToClose <= rule.maxHoursToClose)) return 'too-far'
  if (inp.ask > rule.maxPrice) return 'price-high'
  if (inp.ask < rule.minPrice) return 'price-low'
  const poly = inp.polyPrice
  if (poly !== undefined && poly !== null && Number.isFinite(poly)) {
    if ((inp.ask - poly) * 100 > rule.maxDriftCents) return 'drifted'
  }
  return null
}

/**
 * Parse the shadow's JSONL and keep the rows that could still be acted on: a
 * Kalshi market was matched, its ask was recorded, and the signal is inside
 * the freshness window. Corrupt lines are skipped, not thrown — the file is
 * appended to by another process and a torn last line must not stop the scan.
 *
 * A conditionId is emitted once, but the shadow's `seen` state has been reset
 * before, so the newest row per Kalshi market wins rather than the first.
 */
export function parseConsensusSignals(text: string, nowMs: number, rule: ConsensusRule = CONSENSUS_RULE): ConsensusSignalRow[] {
  const byMarket = new Map<string, { row: ConsensusSignalRow; at: number }>()
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let row: ConsensusSignalRow
    try {
      row = JSON.parse(s) as ConsensusSignalRow
    } catch {
      continue
    }
    const market = row.kalshi?.market
    if (!market || typeof market !== 'string') continue
    const ask = row.kalshi?.yes_ask
    if (ask === undefined || ask === null || !Number.isFinite(ask)) continue
    const at = Date.parse(row.ts)
    if (!Number.isFinite(at)) continue
    if ((nowMs - at) / 3600_000 > rule.maxSignalAgeHours) continue
    const prev = byMarket.get(market)
    if (!prev || at > prev.at) byMarket.set(market, { row, at })
  }
  return [...byMarket.values()].sort((a, b) => b.at - a.at).map((x) => x.row)
}

/** Hours since the signal fired; Infinity when the timestamp will not parse (refused as stale). */
export function consensusAgeHours(row: ConsensusSignalRow, nowMs: number): number {
  const at = Date.parse(row.ts)
  return Number.isFinite(at) ? (nowMs - at) / 3600_000 : Number.POSITIVE_INFINITY
}

/**
 * Fresh consensus signals from the shadow's file, re-read only when it changes.
 * The shadow writes hourly and the scan runs every minute or two, so parsing
 * 5k lines on every scan would be pure waste; mtime is the cheap gate.
 */
export class ConsensusFeed {
  private cachedAt = -1
  private cachedSize = -1
  private rows: ConsensusSignalRow[] = []
  private lastError: string | undefined

  constructor(private readonly path: string) {}

  /** Last read failure (missing file, unreadable), for the status line. */
  error(): string | undefined {
    return this.lastError
  }

  read(nowMs: number, rule: ConsensusRule = CONSENSUS_RULE): ConsensusSignalRow[] {
    let mtime: number
    let size: number
    try {
      const st = statSync(this.path)
      mtime = st.mtimeMs
      size = st.size
    } catch (e) {
      this.lastError = `signals file unreadable: ${(e as Error).message}`
      this.rows = []
      this.cachedAt = -1
      this.cachedSize = -1
      return []
    }
    if (mtime !== this.cachedAt || size !== this.cachedSize) {
      try {
        this.rows = parseConsensusSignals(readFileSync(this.path, 'utf8'), nowMs, rule)
        this.cachedAt = mtime
        this.cachedSize = size
        this.lastError = undefined
      } catch (e) {
        this.lastError = `signals file unreadable: ${(e as Error).message}`
        return []
      }
    } else {
      // The cache was filtered for freshness at its own `now`; re-filter so a
      // signal cannot outlive the window just because the file stopped changing.
      this.rows = this.rows.filter((r) => consensusAgeHours(r, nowMs) <= rule.maxSignalAgeHours)
    }
    return this.rows
  }
}
