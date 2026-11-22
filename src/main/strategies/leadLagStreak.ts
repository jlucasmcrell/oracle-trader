/**
 * Lead-lag streak sizer (operator, 2026-11-22: "If we are winning during a few hours or half a day one day - we need
 * to double the trade size that day, as soon as we know. Same for losing.").
 *
 * The ladder judges every 20 settled trades on a 95% band, which takes days, and it can only double or stop. This
 * reacts within hours: every first gap per ticker and side that clears fees on a proven coin is graded at ONE contract
 * at the price the scan saw, the gaps of one 15-minute window are netted into a single win or loss once Kalshi
 * settles it, and three windows in a row the same way double or halve the size level (1, 2, 4).
 *
 * Why windows, not gaps: two or three coins in one window move together, so per-gap streaks mostly count one window
 * three times. Why every gap, not only fills: the sizer must keep learning while it trades small.
 *
 * Backtest (2026-11-22, every first gap on BTC/ETH/SOL/HYPE/ZEC from 2026-10-14, 1,148 gaps, results from Kalshi):
 * flat x2 +$9.44; this rule at N=3 +$52.04 at the same average size (x1.96); it beat flat x2 in both halves
 * (Oct 14-Nov 2 +$56.12 vs +$17.48, Nov 3-22 -$1.51 vs -$8.04) and at N=2 and N=4, not at N=5. The rule was chosen
 * after seeing the data, so expect less live. The ladder's stops and the window caps still apply on top.
 */
import { kalshiTakerFeeCentsFor } from '../util/kalshiFee'

export type StreakLevel = 1 | 2 | 4

export interface StreakConfig {
  /** On: lead-lag's order size comes from the streak level instead of the ladder's per-order size. */
  leadLagStreakSizing?: boolean
  /** Windows in a row needed to move one level (default 3). */
  leadLagStreakRun?: number
  /** Weekend contracts at the top level (default 4). Weekends trade AT the level, capped here. */
  leadLagStreakWeekendMax?: number
  /** Weekday contracts at the top level (default 2). Weekdays trade at HALF the level, at least 1, capped here. */
  leadLagStreakWeekdayMax?: number
}

export interface StreakGap {
  /** `${ticker}|${side}`: the first sighting per market and side is the one a taker would have bought. */
  key: string
  ticker: string
  side: 'yes' | 'no'
  /** Price of the side bought, dollars (YES ask, or 1 - YES bid). */
  cost: number
  coin: string
  /** Window close, ms. */
  close: number
}

export interface StreakWindow {
  close: number
  gaps: number
  /** Net at one contract per gap, cents, after the taker fee. */
  netCents: number
  win: boolean
  levelAfter: StreakLevel
}

export interface StreakState {
  level: StreakLevel
  winRun: number
  lossRun: number
  pending: StreakGap[]
  /** Newest first, at most 24. */
  recent: StreakWindow[]
  changedAt?: number
}

export const STREAK_DEFAULT_RUN = 3
/** Kalshi settles the 15-minute crypto markets about a minute after close; grade no sooner than this. */
export const STREAK_SETTLE_DELAY_MS = 60_000
/** A window still without results this long after close is dropped, not counted: it must not stall the ones after it. */
export const STREAK_GIVE_UP_MS = 45 * 60_000

export function newStreakState(level: StreakLevel = 2): StreakState {
  return { level, winRun: 0, lossRun: 0, pending: [], recent: [] }
}

/** A persisted state, or a fresh one when the file holds nothing usable. */
export function loadStreakState(raw: unknown): StreakState {
  const s = raw as Partial<StreakState> | undefined
  if (!s || ![1, 2, 4].includes(s.level as number)) return newStreakState()
  const nat = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0)
  const pending = Array.isArray(s.pending)
    ? s.pending.filter((g) => g && typeof g.key === 'string' && typeof g.ticker === 'string' && (g.side === 'yes' || g.side === 'no') &&
        Number.isFinite(g.cost) && g.cost > 0 && g.cost < 1 && Number.isFinite(g.close))
    : []
  return { level: s.level as StreakLevel, winRun: nat(s.winRun), lossRun: nat(s.lossRun), pending, recent: Array.isArray(s.recent) ? s.recent.slice(0, 24) : [], changedAt: s.changedAt }
}

/** Record a gap; only the first sighting per ticker and side counts. Returns true when it was new. */
export function observeGap(state: StreakState, gap: Omit<StreakGap, 'key'>): boolean {
  const key = `${gap.ticker}|${gap.side}`
  if (state.pending.some((g) => g.key === key)) return false
  if (state.recent.some((w) => w.close === gap.close)) return false // that window is already graded
  state.pending.push({ ...gap, key })
  return true
}

/** Window closes that are due for grading at `now`, oldest first. */
export function dueWindows(state: StreakState, now: number): number[] {
  return [...new Set(state.pending.map((g) => g.close))].filter((c) => c + STREAK_SETTLE_DELAY_MS <= now).sort((a, b) => a - b)
}

export function windowNetCents(gaps: readonly StreakGap[], results: ReadonlyMap<string, 'yes' | 'no'>): number | null {
  let net = 0
  for (const g of gaps) {
    const r = results.get(g.ticker)
    if (r !== 'yes' && r !== 'no') return null
    net += (r === g.side ? 100 : 0) - g.cost * 100 - kalshiTakerFeeCentsFor(g.cost, 1)
  }
  return +net.toFixed(2)
}

export interface StreakChange { from: StreakLevel; to: StreakLevel; why: string }

/**
 * Grade one settled window (all its gaps' results known) and move the level if a run completes. Removes the window's
 * gaps from `pending`. Returns the level change, if any.
 */
export function gradeWindow(state: StreakState, close: number, results: ReadonlyMap<string, 'yes' | 'no'>, run = STREAK_DEFAULT_RUN): { graded: boolean; window?: StreakWindow; change?: StreakChange } {
  const gaps = state.pending.filter((g) => g.close === close)
  const net = windowNetCents(gaps, results)
  if (net === null || !gaps.length) return { graded: false }
  state.pending = state.pending.filter((g) => g.close !== close)
  const win = net > 0
  const n = Math.max(1, Math.floor(run))
  const from = state.level
  let change: StreakChange | undefined
  if (win) {
    state.winRun++
    state.lossRun = 0
    if (state.winRun >= n) {
      state.winRun = 0
      const to = Math.min(4, from * 2) as StreakLevel
      if (to !== from) change = { from, to, why: `${n} winning windows in a row` }
    }
  } else {
    state.lossRun++
    state.winRun = 0
    if (state.lossRun >= n) {
      state.lossRun = 0
      const to = Math.max(1, from / 2) as StreakLevel
      if (to !== from) change = { from, to, why: `${n} losing windows in a row` }
    }
  }
  if (change) state.level = change.to
  const w: StreakWindow = { close, gaps: gaps.length, netCents: net, win, levelAfter: state.level }
  state.recent = [w, ...state.recent].slice(0, 24)
  return { graded: true, window: w, change }
}

/** Drop windows whose results never arrived. Returns the closes dropped. */
export function dropStale(state: StreakState, now: number): number[] {
  const stale = [...new Set(state.pending.filter((g) => g.close + STREAK_GIVE_UP_MS <= now).map((g) => g.close))]
  if (stale.length) state.pending = state.pending.filter((g) => !stale.includes(g.close))
  return stale
}

/** Contracts per sweep at this level: weekends AT the level, weekdays at half of it; at least 1, capped per day type. */
export function streakContracts(level: StreakLevel, weekend: boolean, cfg: StreakConfig): number {
  if (weekend) return Math.max(1, Math.min(level, cfg.leadLagStreakWeekendMax ?? 4))
  return Math.max(1, Math.min(Math.floor(level / 2), cfg.leadLagStreakWeekdayMax ?? 2))
}
