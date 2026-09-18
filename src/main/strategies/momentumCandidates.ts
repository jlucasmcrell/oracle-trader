/**
 * Records every momentum CANDIDATE window, whether or not it clears the flat 3c bar - so the population the
 * log-odds idea (REVIEW-CHANGES §76, backlog 67) is actually about gets measured before it is ever traded.
 *
 * `momentumSignals` only sees a market once its point move is >= `momentumMinMovePct`. Everything under
 * that bar - which in log-odds terms includes the largest moves in the tails, where a 1c tick at 97c is
 * 0.35 - leaves no trace anywhere. A log-odds bar set at the at-the-money unit (0.12) is a strict superset
 * of the flat bar, so the only way it can change the arm's P&L is through windows the flat bar rejected,
 * and nothing records those. This does.
 *
 * PURELY OBSERVATIONAL. Nothing here changes what momentum trades. It runs whether or not the momentum arm
 * is enabled (the arm is in cool-down while this is written), and it has its own term in the candle-fetch
 * gate so it does not go blind when the other candle reader is switched off.
 *
 * Division of labour, as in `cullRecorder.ts`: the recorder OBSERVES and the grader JUDGES. Rows carry the
 * raw window (prices, move, log-odds move, confirmation facts, executable quotes) and the threshold the live
 * arm was using at the time - never a verdict - so a grader can apply the flat bar, any log-odds bar, or a
 * rule not yet thought of, after the fact.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MarketCandle, OrderBook, VenueMarket } from '../../shared/types'

export interface MomentumCandidateRow {
  ts: number
  ticker: string
  event?: string
  series?: string
  category?: string
  /** Market close, ISO, so a grader can settle it. */
  close?: string
  /** Window slot: floor(ts / windowMs). The grader keeps the largest move per (ticker, slot). */
  slot: number
  windowMin: number
  /** Candles inside the window, and how many of them traded. */
  candles: number
  volCandles: number
  from: number
  to: number
  /** Point move in cents, signed. */
  movePoints: number
  /** Log-odds move, signed; omitted (never NaN) when either end sits at 0 or 1. */
  moveLogit?: number
  /** Direction held at mid-window - the live arm's confirmation. */
  midHeld: boolean
  /** The flat bar the live arm was using when this was recorded, in cents. Recorded, not applied. */
  thrPoints: number
  /** Side momentum would buy. */
  side: 'YES' | 'NO'
  /** Best quotes at record time in YES terms; the side's executable ask is derived by the grader. */
  yb?: number
  ya?: number
  /**
   * The capacity facts the live arm gates an entry on, recorded raw so a grader can apply the arm's caps
   * (one entry per market per day, no re-entry within an hour of an exit, no second position in an event)
   * instead of scoring windows the arm could not have traded. Absent means the trader had no record.
   *
   * `priorEntriesToday` counts entries on this ticker today by ANY strategy: the trader's churn record is
   * one map shared by every arm, and the live guard reads it the same way, so a mean-reversion entry on the
   * ticker blocks a momentum entry too. While this recorder runs the momentum arm is disabled, so every
   * non-zero value here came from another arm - which is exactly the block the live arm would have hit.
   */
  priorEntriesToday?: number
  /** Whole minutes since the ticker's last exit today, floored: 59.9 is still inside a 60-minute lockout. */
  minutesSinceExit?: number
  eventExposed?: boolean
}

export interface MomentumCandidateCfg {
  windowMin: number
  /** `momentumMinMovePct`, a price fraction (0.03 = 3c). */
  thr: number
}

/**
 * The mid a candle is priced at when it has no trade close: both sides averaged, else whichever single side
 * the minute quoted. THE implementation - `momentumSignals` and `meanReversionSignals` import it from here.
 * The recorder's first version carried a stricter private copy (both sides or nothing), and the review
 * reproduced a window the live arm traded that the recorder dropped without a trace. One function, no copy.
 */
export function midOf(a?: number, b?: number): number | undefined {
  if (a !== undefined && b !== undefined) return (a + b) / 2
  if (a !== undefined) return a
  return b
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

export function logit(p: number): number | undefined {
  if (!(p > 0 && p < 1)) return undefined
  return Math.log(p / (1 - p))
}

/**
 * The window exactly as `momentumSignals` reads it - same cutoff, same minimum candle count, same price
 * choice - so a recorded row is the row the live arm evaluated, not a near copy that drifts. Returns
 * undefined where the live arm would `continue` before it had a move to measure.
 */
export function computeCandidate(
  m: VenueMarket,
  allCandles: MarketCandle[] | undefined,
  book: OrderBook | undefined,
  cfg: MomentumCandidateCfg,
  nowMs: number
): MomentumCandidateRow | undefined {
  const windowSec = cfg.windowMin * 60
  const cutoff = Math.floor(nowMs / 1000) - windowSec
  const candles = (allCandles ?? []).filter((c) => c.endTs >= cutoff)
  if (candles.length < Math.max(2, Math.floor(cfg.windowMin / 2))) return undefined
  const priceAt = (c: MarketCandle): number | undefined => c.close ?? midOf(c.bidClose, c.askClose)
  const newest = priceAt(candles[candles.length - 1])
  const oldest = priceAt(candles[0])
  if (newest === undefined || oldest === undefined) return undefined
  const move = newest - oldest
  const mid = priceAt(candles[Math.floor(candles.length / 2)])
  // The live arm's confirmation, its exact formula negated: it `continue`s on this condition.
  const midHeld = mid !== undefined && !(move > 0 ? mid <= oldest : mid >= oldest)
  const lo = logit(oldest)
  const ln = logit(newest)
  const row: MomentumCandidateRow = {
    ts: nowMs,
    ticker: m.id,
    event: m.eventTicker,
    series: m.seriesTicker,
    category: m.category,
    slot: Math.floor(nowMs / (cfg.windowMin * 60_000)),
    windowMin: cfg.windowMin,
    candles: candles.length,
    volCandles: candles.filter((c) => (c.volume ?? 0) > 0).length,
    from: round2(oldest),
    to: round2(newest),
    movePoints: round2(move * 100),
    midHeld,
    thrPoints: round2(cfg.thr * 100),
    side: move > 0 ? 'YES' : 'NO'
  }
  if (lo !== undefined && ln !== undefined) row.moveLogit = Math.round((ln - lo) * 10000) / 10000
  // The venue mapper yields NaN for a close_time it cannot parse; new Date(NaN).toISOString() THROWS.
  const closeMs = m.closeTime
  if (closeMs !== undefined && Number.isFinite(closeMs)) row.close = new Date(closeMs).toISOString()
  const yb = book?.bids[0]?.price
  const ya = book?.asks[0]?.price
  if (typeof yb === 'number') row.yb = yb
  if (typeof ya === 'number') row.ya = ya
  return row
}

/**
 * Where rows go. Injected at startup for the reason `cullRecorder.ts` gives: this module is imported by the
 * trader, which the test suite imports, and pulling electron in here would break every such test. Unset
 * means inert - and inert means the candle-fetch gate does not fetch for it either.
 */
let outDir: string | undefined
export function setMomentumCandidateDir(dir: string): void {
  outDir = dir
}
export function momentumCandidatesActive(): boolean {
  return outDir !== undefined
}

/**
 * A window whose price did not move by a tick is not a candidate under any bar, flat or log-odds, and at
 * ~100 markets a scan every ~30 s it would be most of the file. One cent is the floor.
 */
export const MIN_ABS_MOVE_POINTS = 1
/**
 * Hard bound per UTC day. ~100 markets x 144 ten-minute slots is 14,400 rows if EVERY window moved and was
 * recorded once, and growth re-records add a few per moving window; 40,000 leaves room without letting a
 * runaway fill the disk. Dropped rows are counted and logged, never silent.
 */
export const MAX_ROWS_PER_DAY = 40_000

/** Largest |movePoints| recorded so far per ticker in the current slot. */
let recorded = new Map<string, { slot: number; absMove: number }>()
let day = ''
let rowsToday = 0
let droppedToday = 0
/** Rows selected for writing whose append threw. Counted, never hidden - and never marked as recorded. */
let writeFailedToday = 0
let lastHeartbeatAt = 0
const HEARTBEAT_MS = 60 * 60_000
/** The hour's totals, reported in one line. A line per scan with a fresh row was 2,000 lines a day. */
const hour = { scans: 0, fresh: 0, offered: 0, withCandles: 0, flat: 0, dup: 0, errors: 0, writeFailed: 0 }

export interface MomentumCandidateStats {
  day: string
  /** Rows that reached the file. Counted AFTER the append returns, so a failing disk cannot inflate it. */
  rowsToday: number
  droppedToday: number
  writeFailedToday: number
}
export function momentumCandidateStats(): MomentumCandidateStats {
  return { day, rowsToday, droppedToday, writeFailedToday }
}

/**
 * Appends the rows worth keeping: one per (ticker, slot) on first sight, and again whenever the window's
 * move has grown by at least a cent since the last row for that ticker in the slot, so a move that crosses
 * a bar mid-slot is seen crossing it. The grader keeps the largest per (ticker, slot).
 *
 * `seen` is the number of markets offered and `withCandles` how many had a window at all: the pair is the
 * recorder's OUTPUT health. A fresh log line that says "0 with candles" is a blind recorder, not a quiet
 * market (ladder15 wrote healthy heartbeats over an empty ledger for a week).
 */
export function recordMomentumCandidates(rows: MomentumCandidateRow[], seen: number, withCandles: number, nowMs = Date.now(), errors = 0): void {
  const dir = outDir
  if (dir === undefined) return
  try {
    const today = new Date(nowMs).toISOString().slice(0, 10)
    if (today !== day) {
      recorded = new Map()
      rowsToday = 0
      droppedToday = 0
      writeFailedToday = 0
      day = today
    }
    // SELECT without touching `recorded`: a row is marked recorded only once the append has returned. The
    // re-review reproduced the other order - a failed write left the row marked, the stats claiming it,
    // and its later growth re-record discarded as a dup with no counter anywhere.
    const fresh: MomentumCandidateRow[] = []
    const chosen = new Map<string, { slot: number; absMove: number }>()
    let flat = 0
    let dup = 0
    let capped = 0
    for (const r of rows) {
      const abs = Math.abs(r.movePoints)
      if (abs < MIN_ABS_MOVE_POINTS) {
        flat++
        continue
      }
      const prev = chosen.get(r.ticker) ?? recorded.get(r.ticker)
      if (prev !== undefined && prev.slot === r.slot && abs < prev.absMove + 1) {
        dup++
        continue
      }
      if (rowsToday + fresh.length >= MAX_ROWS_PER_DAY) {
        capped++
        continue
      }
      chosen.set(r.ticker, { slot: r.slot, absMove: abs })
      fresh.push(r)
    }
    droppedToday += capped
    // WRITE, then mark. On failure nothing is marked, so the next scan offers the same rows again.
    let written = 0
    if (fresh.length > 0) {
      try {
        mkdirSync(dir, { recursive: true })
        appendFileSync(join(dir, `${today}.jsonl`), fresh.map((r) => JSON.stringify(r)).join('\n') + '\n')
        written = fresh.length
        for (const [ticker, v] of chosen) recorded.set(ticker, v)
        rowsToday += written
      } catch {
        writeFailedToday += fresh.length
        hour.writeFailed += fresh.length
      }
    }
    hour.scans++
    hour.fresh += written
    hour.offered += seen
    hour.withCandles += withCandles
    hour.flat += flat
    hour.dup += dup
    hour.errors += errors
    // One line an hour, first one at once after a start: the hour's totals. "With candles" per scan is the
    // blindness signal; "failed to write" is the empty-ledger signal. Both are OUTPUT health.
    if (nowMs - lastHeartbeatAt >= HEARTBEAT_MS) {
      lastHeartbeatAt = nowMs
      const per = (v: number): string => (hour.scans > 0 ? (v / hour.scans).toFixed(1) : '0')
      console.log(
        `[momentum-rec] last ${hour.scans} scans: ${hour.fresh} recorded (${rowsToday} today, ${droppedToday} dropped at the ${MAX_ROWS_PER_DAY}/day cap, ${writeFailedToday} failed to write); ` +
          `per scan ${per(hour.offered)} markets offered, ${per(hour.withCandles)} with candles; ${hour.flat} unmoved, ${hour.dup} already recorded this slot, ${hour.errors} market errors`
      )
      hour.scans = hour.fresh = hour.offered = hour.withCandles = hour.flat = hour.dup = hour.errors = hour.writeFailed = 0
    }
  } catch {
    // Observation must never break trading.
  }
}

/** Test seam: forget today, and go inert again. */
export function resetMomentumCandidates(): void {
  recorded = new Map()
  day = ''
  rowsToday = 0
  droppedToday = 0
  writeFailedToday = 0
  lastHeartbeatAt = 0
  hour.scans = hour.fresh = hour.offered = hour.withCandles = hour.flat = hour.dup = hour.errors = hour.writeFailed = 0
  outDir = undefined
}
