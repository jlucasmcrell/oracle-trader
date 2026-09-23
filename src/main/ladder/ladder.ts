/**
 * Promotion ladder: the automation that replaces "remember to flip the switch".
 *
 * Every strategy that is being tested has a pre-registered gate. This module
 * evaluates each gate on a timer and moves the strategy between stages on its
 * own — up to a tiny-live stage when the gate passes, back down when live
 * evidence turns against it — and records every transition. The operator's
 * global arm (liveArmed, execution mode) is never touched: without it no
 * promotion can spend money, and demotions always run.
 *
 * Stages:
 *   shadow / paper  – records only (quoter shadow meter, convergence collector,
 *                     settlement paper ledger)
 *   tiny-live       – real orders at the fixed micro size the gate authorised
 *   live            – Polymarket US micro-maker (already live at one contract)
 *   disabled        – demoted by evidence; re-promotion needs the gate again
 *                     after a cool-down
 *   blocked         – gate passed but a precondition failed (unfunded shard,
 *                     exchange paused, not armed); retried next run
 *
 * Trade-small mode (the default since 2026-09-06): recording-only strategies
 * go to tiny-live real-money tests without waiting for their gate; the live-
 * loss rules demote, and after ladderMaxDemotionsBeforeGate stops the
 * cool-down grows (14 days, doubling) — nothing is dead for good. Weather
 * strategies need collateral on Kalshi shard 0, which the ladder tops up from
 * another shard within ladderAutoAllocateUsd.
 *
 * Live stages are judged by decideStage on NET PROFIT AFTER FEES since the
 * stage began (never win rate): a hard stop at -$5 x size, and at every 20
 * settled trades a checkpoint that scales the size up (x2, x4) when the
 * strategy makes money with 80% confidence, stops it when it loses with 80%
 * confidence, and otherwise keeps testing; at 100 trades the sign of the net
 * decides. A small win is a win.
 *
 * The decision functions are pure and unit-tested; the runner only gathers
 * evidence and applies the decision through the strategies' own setConfig.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { loadJsonOrQuarantine } from '../store/json'
import { dirname, join } from 'node:path'
import type { TradingEngine } from '../engine/engine'
import type { AutoTrader } from '../strategies/autoTrader'
import type { AutoTraderConfig, MiniAutoConfig } from '../../shared/ipc'
import { statsBand } from '../strategies/ledgerAudit'
import { LEADLAG_PROVEN_DEFAULT } from '../strategies/leadLag'
import type { MiniAuto } from '../strategies/miniAuto'
import type { VenueId } from '../../shared/types'
import type { VenueAdapter } from '../../shared/venue'
import { sendAlert } from '../util/alert'

export type Stage = 'shadow' | 'paper' | 'tiny-live' | 'live' | 'disabled' | 'blocked'
export type CoreStrategyId = 'quoter' | 'convergence' | 'settlement' | 'polyus-micro-maker'
export type GenericStrategyId =
  | 'kalshi-fade'
  | 'kalshi-momentum'
  | 'kalshi-book-imbalance'
  | 'kalshi-volume-spike'
  | 'kalshi-cross-venue'
  | 'kalshi-news'
  | 'kalshi-dutch'
  | 'kalshi-leadlag'
  | 'kalshi-sports-anchor'
  | 'kalshi-consensus'
  | 'kalshi-flow-follow'
  | 'kalshi-mean-reversion'
  | 'kalshi-weather-morning'
  | 'polyus-fade'
  | 'polyus-book-imbalance'
  | 'polyus-weather-fair'
  | 'polyus-lag'
export type LadderStrategyId = CoreStrategyId | GenericStrategyId

/**
 * Signal strategies under the same ladder (operator invariant 2026-09-06:
 * every strategy in the app is tested, scaled or stopped by the ladder;
 * nothing stays off without a ladder verdict). One on/off flag each; size
 * scales by a per-strategy stake multiplier (lead-lag: contracts per order).
 */
export interface GenericSpec {
  id: GenericStrategyId
  venue: 'kalshi' | 'polymarket-us'
  /** perfByStrategy / calibration / research-log key */
  key: string
  /** config flag that switches live execution on */
  flag: string
  /** extra config that must be on for the flag to matter */
  also?: Record<string, unknown>
  /** sized by contracts per order instead of the stake multiplier */
  contracts?: boolean
  /**
   * Contracts per notch, for a `contracts` arm that needs more room than the shared MAX_NOTCH ceiling
   * allows. lead-lag sat pinned at 4 per sweep - the ladder's maximum - while it was the only arm earning,
   * and raising MAX_NOTCH would have lifted every unproven arm with it. Defaults to 1.
   */
  contractsPerNotch?: number
}
export interface LeadLagRow {
  ts?: string
  kalshiTicker?: string
  executed?: boolean
  /** Contracts the IOC actually filled (absent on rows written before 2026-09-08). */
  filledContracts?: number
  /** The coin (absent on rows written before the coin field existed; those count). */
  underlying?: string
}
/**
 * Does a lead-lag dislocation row count as this arm's live evidence?
 *
 * Only a sweep that FILLED does. Until 2026-09-08 the sweep marked itself
 * executed whenever the venue accepted the IOC, including the majority that
 * crossed nothing, so this join credited the arm with settlements of markets
 * it never held. Rows without a fill count are pre-fix rows and cannot be
 * told apart, so they are excluded: an arm's evidence restarting is a lesser
 * harm than an arm scaled on another strategy's P&L.
 */
export function leadLagRowCounts(r: LeadLagRow, since: number, provenCoins: readonly string[] = LEADLAG_PROVEN_DEFAULT): boolean {
  if (!r.executed || !r.kalshiTicker) return false
  if (!((r.filledContracts ?? 0) > 0)) return false
  // An unproven coin's fills are judged by the pre-registered per-coin gate, not by this pool: the stage
  // baseline was earned by BTC/ETH and a pool cannot stop a subset (round 93, backlog 91).
  if (r.underlying !== undefined && !provenCoins.includes(r.underlying)) return false
  const ts = Date.parse(r.ts ?? '')
  return Number.isFinite(ts) && ts >= since
}

export const GENERIC_STRATEGIES: GenericSpec[] = [
  { id: 'kalshi-fade', venue: 'kalshi', key: 'fade', flag: 'fadeEnabled' },
  { id: 'kalshi-momentum', venue: 'kalshi', key: 'momentum', flag: 'momentumEnabled' },
  { id: 'kalshi-book-imbalance', venue: 'kalshi', key: 'book-imbalance', flag: 'bookEnabled' },
  { id: 'kalshi-volume-spike', venue: 'kalshi', key: 'volume-spike', flag: 'volumeSpikeEnabled' },
  { id: 'kalshi-cross-venue', venue: 'kalshi', key: 'cross-venue', flag: 'crossVenueEnabled' },
  { id: 'kalshi-news', venue: 'kalshi', key: 'news', flag: 'newsEnabled' },
  { id: 'kalshi-dutch', venue: 'kalshi', key: 'dutch', flag: 'dutchLiveEnabled', also: { dutchEnabled: true } },
  // contractsPerNotch: lead-lag sizes in CONTRACTS, and at notch 4 it was pinned at 4 per sweep - the
  // ladder's ceiling, reached while it was the only arm earning. Multiplying here lifts lead-lag alone
  // instead of raising MAX_NOTCH for every unproven arm, and leaves the stage stop (which scales on the
  // notch, not the order) exactly where it was.
  { id: 'kalshi-leadlag', venue: 'kalshi', key: 'leadlag', flag: 'leadLagLiveEnabled', contracts: true, contractsPerNotch: 1 },
  { id: 'kalshi-sports-anchor', venue: 'kalshi', key: 'sports-anchor', flag: 'sportsAnchorLiveEnabled' },
  // Polymarket smart-money consensus, taken on Kalshi. Pre-registered
  // 2026-09-13 (docs/PREREGISTERED-polymarket-consensus.md); the ladder's
  // tiny-live stop is the first stop, the doc adds a -$8 hard money stop and a
  // 2026-10-13 no-flow deadline.
  { id: 'kalshi-consensus', venue: 'kalshi', key: 'consensus', flag: 'consensusEnabled' },
  { id: 'kalshi-flow-follow', venue: 'kalshi', key: 'flow-follow', flag: 'flowFollowEnabled' },
  { id: 'kalshi-mean-reversion', venue: 'kalshi', key: 'mean-reversion', flag: 'meanReversionEnabled' },
  { id: 'kalshi-weather-morning', venue: 'kalshi', key: 'weather-morning', flag: 'weatherMorningEnabled' },
  { id: 'polyus-fade', venue: 'polymarket-us', key: 'fade', flag: 'fadeEnabled' },
  { id: 'polyus-book-imbalance', venue: 'polymarket-us', key: 'book-imbalance', flag: 'bookEnabled' },
  { id: 'polyus-weather-fair', venue: 'polymarket-us', key: 'weather-fair', flag: 'weatherFairEnabled' },
  // Kalshi leads Polymarket US in play, pre-registered 2026-09-22 (docs/PREREGISTERED-polyus-lag.md, section 160).
  { id: 'polyus-lag', venue: 'polymarket-us', key: 'lag', flag: 'lagEnabled' }
]
const GENERIC_BY_ID = new Map<string, GenericSpec>(GENERIC_STRATEGIES.map((g) => [g.id, g]))

export interface LadderTransition {
  at: number
  from: Stage
  to: Stage
  reason: string
  /** The stage's evidence baseline this transition replaced (backlog 81a). */
  baseline?: Record<string, number>
}

export interface LadderStrategy {
  id: LadderStrategyId
  stage: Stage
  since: number
  /** Counters at the last promotion, so live evidence is measured since then. */
  baseline?: Record<string, number>
  lastEval?: number
  lastVerdict?: string
  cooldownUntil?: number
  /** Real-money demotions so far; after the configured count the strategy must pass its gate again. */
  demotions?: number
  /** The operator switched this strategy off in the panel: trade-small entry stays off until it is switched back on. */
  operatorHold?: boolean
  /**
   * Stopped by its own pre-registered read (section 163): off, and never re-armed by trade-small's clock. Not an
   * operator hold - the operator switching it on in the panel still brings it back, and clears this.
   */
  retired?: { at: number; reason: string }
  /** Size notch at the live stages: 1 = micro (one contract), then 2, 4. */
  notch?: number
  /** Number of 20-trade checkpoints already judged at the current stage. */
  lastCheckpoint?: number
  /** SIZES_VERSION whose size table was last applied to this strategy. */
  sizesVersion?: number
  history: LadderTransition[]
}

export interface LadderStatus {
  enabled: boolean
  mode: LadderMode
  lastRunAt?: number
  lastPromotionAt?: number
  strategies: LadderStrategy[]
  note?: string
}

interface LadderState {
  strategies: Record<string, LadderStrategy>
  lastRunAt?: number
  lastPromotionAt?: number
}

// ---- pure decision rules ----

export interface GateEvidence {
  n: number
  events: number
  mean: number
  lo: number
}
/** The 5-minute markout band for an arm: how the price moves against us right after we enter. */
export interface AdverseEvidence {
  n: number
  mean: number
  lo: number
  hi: number
  /** markoutN / (markoutN + markoutMissingN). Undefined on an arm that has never recorded the miss count. */
  coverage?: number
}
export interface StageEvidence {
  /**
   * Exempt from the 100-trade SIGN stop (band stop and hard stop still apply). Set for lead-lag only: its rows
   * disperse ~45c around an edge measured in single cents, and `scripts/ladder-power-sim.ts` (the production
   * decideStage on a true +1.5c arm at its volume) had the sign rule stop it in 67 of 100 thirty-day runs - the
   * rule was deciding the account's one earning arm on noise (external review GLM 5.3, F-02; 2026-09-19).
   */
  signStopExempt?: boolean
  /**
   * Hard stop in dollars per size notch, when it differs from LIVE_STOP_DOLLARS. Lead-lag: $10 (operator,
   * 2026-09-20). Its results swing $4-5 on an ordinary day, so $5 sat inside one day's noise: the simulation
   * (§138, scripts/ladder-power-sim.ts) had $5 switch off a true +1.5c arm in 78 of 100 thirty-day runs against 62
   * at $10, for about $3 more lost per cycle if the arm is bad. Every other arm keeps the default.
   */
  stopDollars?: number
  /**
   * Realized dollars for this arm across its WHOLE life, including every re-based or renamed cohort. Unlike
   * `netDollars` this is not a delta against the stage baseline, so recapturing the baseline cannot reset it.
   */
  lifetimeDollars?: number
  /** Settled trades since the current stage began. */
  n: number
  netDollars: number
  /** Mean and standard error of the per-trade net (any consistent unit). */
  mean: number
  se: number
  /**
   * Sample standard deviation in the same unit as `mean`, when the caller can supply it. Kept apart from
   * `se` because a clustered SE is not sd/sqrt(n). Absent means the one-sided-sample guard is skipped.
   */
  sd?: number
  /**
   * How many clusters the SE was estimated from, when it is a clustered one. Drives the t multiplier:
   * a cluster-robust SE has G-1 degrees of freedom, and the normal 0.84 is only its limit.
   */
  clusters?: number
  unit?: string
  /**
   * Entry-quality meter: the 5-minute markout band, when the arm has one. Lifetime rather than per-stage on
   * purpose - adverse selection is a property of the entry rule, not of the size we happen to be trading.
   */
  adverse?: AdverseEvidence
  /** Dollars at risk per trade at the current size, so the hard stop scales with the stake. */
  stake?: number
}
export interface StageDecision {
  kind: 'scale-up' | 'stop' | 'hold'
  checkpoint: number
  reason: string
}
export interface Decision {
  to: Stage
  reason: string
}

export const QUOTER_GATE = { minFills: 30, minEvents: 40 }
export const LIVE_STOP_DOLLARS = 5
/** Lead-lag's own hard stop per notch (operator decision 2026-09-20, §139); see StageEvidence.stopDollars. */
export const LEADLAG_STOP_DOLLARS = 10
/** Weather contracts settle on Kalshi shard 0; below this a micro test is a rejected-order loop. */
export const SHARD0_MIN_DOLLARS = 5
/**
 * What every shard the venue reports should hold so an arm can take its stake there. Kalshi rejects an order
 * whose shard is unfunded even when the aggregate covers it many times over (2026-09-21: $63.55 in the account,
 * 3,105 fade candidates refused in fifty scans, every live arm blocked).
 */
export const SHARD_FLOOR_DOLLARS = 5
/** Never move less than this - a stream of cent transfers is noise on a non-atomic API. */
export const SHARD_MIN_MOVE = 1
/** Ceiling on what one levelling pass may move, and on a whole UTC day. Bounds a misbehaving loop. */
export const SHARD_MAX_MOVE_PER_RUN = 25
export const SHARD_MAX_MOVE_PER_DAY = 60
/** Working balance kept on every shard that has traded (sports, crypto), fed from shard 0's surplus above the weather cap. */
export const SHARD_WORKING_DOLLARS = 15
export const COOLDOWN_MS = 3 * 24 * 3600_000
export const LONG_COOLDOWN_MS = 14 * 24 * 3600_000
export const PROMOTION_STAGGER_MS = 1 * 3600_000

/**
 * Cool-down after a strategy's k-th stop: 3 days while k is below the cap,
 * then 14 days doubling per stop (max 56). Nothing is ever dead for good; a
 * pre-registered gate can still re-enter a strategy sooner.
 */
export function cooldownAfter(demotions: number, cap: number): number {
  if (demotions < cap) return COOLDOWN_MS
  return Math.min(4 * LONG_COOLDOWN_MS, LONG_COOLDOWN_MS * 2 ** (demotions - cap))
}
/** Bump when the size table changes so already-live strategies pick the new sizes up once. */
export const SIZES_VERSION = 2
/** Live-stage rule (operator directive 2026-09-06): judged every 20 settled trades. */
export const CHECKPOINT_TRADES = 20
/** After this many trades the sign of the net decides. */
export const THOROUGH_TRADES = 100
/** One-sided 80% confidence. */
export const CONFIDENCE_Z = 0.84
/**
 * One-sided 80% Student-t quantile on `df` degrees of freedom, for a CLUSTER-robust standard error.
 *
 * A cluster-robust SE estimated from G clusters carries G-1 degrees of freedom, not infinity, and the
 * normal 0.84 is only its limit. At the cluster counts this system actually runs at the difference is not
 * academic: with two day-clusters the correct multiplier is 1.376, so a band drawn with 0.84 is 39% too
 * narrow before the finite-cluster correction is even applied.
 */
export function clusterT(df: number): number {
  const TABLE = [1.376, 1.061, 0.978, 0.941, 0.92, 0.906, 0.896, 0.889, 0.883, 0.879, 0.876, 0.873, 0.87, 0.868, 0.866]
  if (!Number.isFinite(df) || df < 1) return TABLE[0]
  if (df >= TABLE.length) return Math.max(CONFIDENCE_Z, 0.866 - (0.866 - CONFIDENCE_Z) * Math.min(1, (df - TABLE.length) / 45))
  return TABLE[df - 1]
}
/**
 * One-sided 95% Student-t quantile on `df` degrees of freedom: the bar for adding SIZE. The 80% band above
 * is a screening threshold - with ~18 arms each tested at repeated checkpoints, a fifth of zero-edge arms
 * clear it at any one look, so it may admit an arm to tiny-live but must not scale one (external review
 * 2026-09-19, five of five reports; §127). Stops keep the 80% band: stopping early costs time, not money.
 */
export function clusterT95(df: number): number {
  const TABLE = [6.314, 2.92, 2.353, 2.132, 2.015, 1.943, 1.895, 1.86, 1.833, 1.812, 1.796, 1.782, 1.771, 1.761, 1.753]
  if (!Number.isFinite(df) || df < 1) return TABLE[0]
  if (df >= TABLE.length) return Math.max(SCALE_Z, 1.753 - (1.753 - SCALE_Z) * Math.min(1, (df - TABLE.length) / 45))
  return TABLE[df - 1]
}
export const SCALE_Z = 1.645
export const MAX_NOTCH = 4
/** Markout observations needed before entry quality can veto a scale-up. */
export const ADVERSE_MIN_N = 15
/**
 * Share of an arm's exits that must actually carry a markout before the band may veto anything. Exits
 * inside five minutes never get one, and they are the arm's losers, so a thin sample runs OPTIMISTIC -
 * the direction that would let a bad arm past a veto built to catch it. momentum sits at 33% coverage.
 */
export const ADVERSE_MIN_COVERAGE = 0.8

export function meanCi(values: number[]): { n: number; mean: number; se: number; lo: number; hi: number } {
  const n = values.length
  if (n === 0) return { n: 0, mean: 0, se: 0, lo: 0, hi: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / n
  const varS = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0
  const se = Math.sqrt(varS / n)
  return { n, mean, se, lo: mean - 1.96 * se, hi: mean + 1.96 * se }
}

/**
 * Mean and CLUSTERED standard error over grouped observations (groups = the
 * event, day or market whose outcome the observations share). Weather fills
 * on one city-day, or several convergence strikes on one hourly close, win or
 * lose together; counting them as independent trades overstates confidence.
 */
export function clusteredMean(rows: { v: number; g: string }[]): { n: number; groups: number; mean: number; se: number; sd: number } {
  const n = rows.length
  if (n === 0) return { n: 0, groups: 0, mean: 0, se: 0, sd: 0 }
  const mean = rows.reduce((a, r) => a + r.v, 0) / n
  const by = new Map<string, { n: number; sum: number }>()
  for (const r of rows) {
    const g = by.get(r.g) ?? { n: 0, sum: 0 }
    g.n++
    g.sum += r.v
    by.set(r.g, g)
  }
  const clustered = clusteredSe([...by.values()], n, mean)
  // Fewer than three clusters cannot estimate their own variance: one cluster
  // makes the clustered SE exactly zero (2026-09-07: a strategy was stopped on
  // a "band" of -2.93..-2.93 after one day), so floor it at the plain SE.
  const plain = n > 1 ? Math.sqrt(rows.reduce((a, r) => a + (r.v - mean) ** 2, 0) / (n - 1) / n) : 0
  // The sample sd travels separately from the SE: the SE may be clustered (and is then not sd/sqrt(n)),
  // but decideStage needs the raw dispersion to tell a two-sided sample from a one-sided one.
  const sd = n > 1 ? Math.sqrt(rows.reduce((a, r) => a + (r.v - mean) ** 2, 0) / (n - 1)) : 0
  return { n, groups: by.size, mean, se: by.size < 3 ? Math.max(clustered, plain) : clustered, sd }
}
/** Clustered SE from per-group (n, sum) pairs; with one observation per group this is the ordinary SE. */
export function clusteredSe(groups: { n: number; sum: number }[], n: number, mean: number): number {
  if (n === 0) return 0
  // The G/(G-1) finite-cluster correction. Without it this estimator is biased LOW, worst at the three-to-
  // six clusters that a few days of trading produces - which is precisely when the ladder is deciding
  // whether to double a live arm's size on it.
  const g = groups.length
  const correction = g > 1 ? Math.sqrt(g / (g - 1)) : 1
  return (Math.sqrt(groups.reduce((a, x) => a + (x.sum - x.n * mean) ** 2, 0)) / n) * correction
}

/**
 * Day-clustered SE for the Kalshi trader's calibration ledger, from the
 * per-day (n, sum) buckets plus the sum of squares. Same floor as
 * clusteredMean: under three clusters the clustered SE cannot estimate its own
 * variance and with one cluster it is exactly zero, which on 2026-09-07 gave
 * momentum a -2.93..-2.93 "80% band" and stopped it on no evidence at all.
 * Falls back to the plain SE when the buckets do not account for every trade.
 */
export interface CalibAccumulator {
  netN?: number; netSum?: number; netSq?: number
  byDay?: Record<string, { n: number; sum: number; w?: number; wsum?: number }>
  wN?: number; wSum?: number; wSq?: number; wTrades?: number
}

/**
 * Contract-weighted mean, SE and sd of the net cents per contract since the stage baseline - the estimand the
 * doctrine states and both labs compute (audit 2026-09-19, B-21). N is contracts, the day clusters carry
 * contract sums, and the SE is the G/(G-1)-corrected cluster estimator over those sums (the lab's formula),
 * floored at the plain SE below three clusters as dayClusteredSe does. Returns null when the weighted
 * accumulators do not cover every trade counted since the baseline (a stage that began before the weights
 * existed): the caller then keeps the equal-per-trade statistics until its next baseline capture.
 */
export function weightedTraderStats(c: CalibAccumulator | undefined, b: Record<string, number>, trades: number): { mean: number; se: number; sd?: number; groups: { n: number; sum: number }[]; clusters?: number } | null {
  const wTrades = (c?.wTrades ?? 0) - (b.wTrades ?? 0)
  const wN = (c?.wN ?? 0) - (b.wN ?? 0)
  if (trades <= 0 || wTrades !== trades || !(wN > 0)) return null
  const wSum = (c?.wSum ?? 0) - (b.wSum ?? 0)
  const wSq = (c?.wSq ?? 0) - (b.wSq ?? 0)
  const mean = wSum / wN
  const groups = Object.entries(c?.byDay ?? {})
    .map(([day, g]) => ({ n: (g.w ?? 0) - (b[`dayW:${day}`] ?? 0), sum: (g.wsum ?? 0) - (b[`dayWSum:${day}`] ?? 0) }))
    .filter((g) => g.n > 1e-9)
  const plain = wN > 1 ? Math.sqrt(Math.max(0, (wSq - wN * mean * mean) / (wN - 1)) / wN) : 0
  const covered = Math.abs(groups.reduce((a, g) => a + g.n, 0) - wN) < 1e-6
  let se = plain
  if (groups.length > 0 && covered) {
    const clustered = clusteredSe(groups, wN, mean)
    se = groups.length < 3 ? Math.max(clustered, plain) : clustered
  }
  const sd = wN > 1 ? Math.sqrt(Math.max(0, (wSq - wN * mean * mean) / (wN - 1))) : undefined
  return { mean, se, sd, groups, clusters: groups.length > 0 && covered ? groups.length : undefined }
}

/**
 * The 5-minute markout band behind the adverse-selection veto: plain until an arm has >= 30 markouts bucketed by day
 * over >= 3 days, then clustered by day - same-day markouts move together, and the plain band overstated how sure a
 * veto was (backlog 183).
 */
export function markoutBand(
  p: { markoutN?: number; markoutSum?: number; markoutSq?: number; markoutSqN?: number; markoutByDay?: Record<string, { n: number; sum: number }> } | undefined,
  z: number
): ReturnType<typeof statsBand> {
  const plain = statsBand(p?.markoutN ?? 0, p?.markoutSum ?? 0, p?.markoutSq, p?.markoutSqN, z)
  const days = Object.values(p?.markoutByDay ?? {}).filter((d) => d.n > 0)
  const n = days.reduce((a, d) => a + d.n, 0)
  if (!plain || n < 30 || days.length < 3) return plain
  const mean = days.reduce((a, d) => a + d.sum, 0) / n
  const se = dayClusteredSe(days, n, mean, 0)
  return { ...plain, n, mean, se, lo: mean - z * se, hi: mean + z * se }
}

export function dayClusteredSe(groups: { n: number; sum: number }[], n: number, mean: number, sq: number): number {
  const plain = n > 1 ? Math.sqrt(Math.max(0, (sq - n * mean * mean) / (n - 1)) / n) : 0
  if (groups.length === 0 || groups.reduce((a, g) => a + g.n, 0) !== n) return plain
  const clustered = clusteredSe(groups, n, mean)
  return groups.length < 3 ? Math.max(clustered, plain) : clustered
}

/**
 * Live-stage rule, on NET PROFIT AFTER FEES since the stage began:
 *   - hard stop at -$5 x size notch, checked every evaluation;
 *   - at every 20 settled trades (a checkpoint): making money with 80%
 *     confidence -> scale up (double size, up to x4); losing with 80%
 *     confidence -> stop; otherwise keep testing;
 *   - at 100 trades the sign of the net decides: positive -> scale up (a
 *     small win is a win), otherwise stop.
 * A checkpoint is judged once; between checkpoints only the hard stop acts.
 */
/**
 * Clusters required before a confidence band may STOP a live arm. On 2026-09-07 momentum was stopped on a
 * band of -2.93..-2.93 drawn from 21 fills that all landed on one day: one cluster, clustered SE exactly
 * zero, no width at all. Round 73 floored that SE at the plain one so a band can no longer be zero-width -
 * necessary, not sufficient, because a single day of correlated fills still draws a tight band around one
 * bad day. Twenty-one fills on one day is one observation of how the arm does on a day.
 *
 * Mirror image of the one-sided-sample guard: that refuses to SCALE UP on an unsampled downside, this
 * refuses to STOP on unsampled across-day variation. Neither acts on the half of the distribution the
 * sample has not seen. The hard -$5 stop is deliberately NOT gated by it - that is a money rule, and it is
 * what bounds the cost of waiting for a fourth cluster.
 */
export const MIN_STOP_CLUSTERS = 4
/**
 * How many times over an arm may lose its per-stage stop across its entire life before it is stopped regardless
 * of what the current cohort says. The per-stage stop is measured since `s.baseline`, and the baseline is
 * recaptured on every transition and every re-base (`captureBaseline`), so a stopped arm that is re-armed - by a
 * cool-down expiring, by a manual flip, or by having its evidence renamed for an unrelated reason - begins again
 * from zero and can lose the same stop indefinitely.
 *
 * Measured 2026-09-21: consensus stood at -$10.40 realized across `consensus` (-$3.00, 41 trades) and
 * `consensus:pre-matcher-20260919` (-$7.40, 116) while its ladder row read "41 settled since stage start, net
 * $-3.00" - and its own pre-registration carries a -$8 hard money stop "ungated by the cluster floor" that says
 * in terms that it "still counts every dollar". sports-anchor stood at -$7.31 on 3 wins in 19 trades, having
 * been stopped at -$5.14 on 09-11 and re-armed 52 minutes after the cool-down expired with no evidence read.
 *
 * Two, not one, on purpose: an arm whose first run was ruined by a defect that has since been fixed deserves a
 * second run. It does not deserve a third.
 */
export const LIFETIME_STOP_MULTIPLE = 2
/** When the v27 fee-model fix cleared every strategy's net-cents accumulator (main.log, 2026-09-18). */
export const CALIB_CLEARED_AT = Date.parse('2026-09-18T13:34:23Z')

export function decideStage(ev: StageEvidence, notch: number, lastCheckpoint: number): StageDecision {
  // Hard stop: -$5 per size notch, or three per-trade stakes, whichever is larger.
  const stop = Math.max((ev.stopDollars ?? LIVE_STOP_DOLLARS) * Math.max(1, notch), 3 * (ev.stake ?? 0))
  if (ev.netDollars <= -stop) return { kind: 'stop', checkpoint: lastCheckpoint, reason: `net $${ev.netDollars.toFixed(2)} hit the -$${stop} stop at size x${notch}` }
  // The lifetime floor. `netDollars` restarts at every re-base; this does not. Checked right after the per-stage
  // stop and before every other rule, including the cluster floor - the cluster floor exists to stop a BAND from
  // being read off one day, and this is not a band, it is money that has already left the account.
  const lifeStop = stop * LIFETIME_STOP_MULTIPLE
  if (ev.lifetimeDollars !== undefined && ev.lifetimeDollars <= -lifeStop) {
    return { kind: 'stop', checkpoint: lastCheckpoint, reason: `lifetime net $${ev.lifetimeDollars.toFixed(2)} across every cohort is past the -$${lifeStop} lifetime floor (${LIFETIME_STOP_MULTIPLE}x the -$${stop} stage stop); the stage ledger reads $${ev.netDollars.toFixed(2)} because the baseline was recaptured` }
  }
  // t on G-1 degrees of freedom when the SE is clustered; the normal quantile only when we do not know.
  const z = ev.clusters !== undefined && ev.clusters >= 2 ? clusterT(ev.clusters - 1) : CONFIDENCE_Z
  const lo = ev.mean - z * ev.se
  const hi = ev.mean + z * ev.se
  const checkpoint = Math.floor(ev.n / CHECKPOINT_TRADES)
  // The checkpoint cadence paces JUDGEMENT, and judgement used to include stopping. On 2026-09-21
  // volume-spike stood at 34 settled with an 80% band of -5.85..-1.01 - wholly below zero on enough
  // day-clusters to mean it - and the cadence held it unjudged until 40 while it kept taking entries a
  // shard rebalance had just refunded. Stopping is a money rule, like the -$5 hard stop above it, and money
  // rules are not rate-limited. A conclusively-negative band is therefore let through between checkpoints;
  // it can only reach the `hi < 0` branch below, never a scale-up, because hi < 0 fails every positive
  // branch. The cluster floor still applies there, so an unverifiable or single-day band is not a verdict.
  const conclusivelyLosing = hi < 0 && ev.clusters !== undefined && ev.clusters >= MIN_STOP_CLUSTERS
  if (checkpoint <= lastCheckpoint && !conclusivelyLosing) {
    return { kind: 'hold', checkpoint: lastCheckpoint, reason: `${ev.n} settled since stage start, net $${ev.netDollars.toFixed(2)}; next checkpoint at ${(lastCheckpoint + 1) * CHECKPOINT_TRADES}` }
  }
  // Scaling up needs the 95% band AND the same cluster floor a stop needs. Until 2026-09-19 the positive
  // branch had no cluster floor at all, so one correlated day could double an arm's size while the
  // handbook said "a one-cluster band is never a verdict, in any tool" (§127, F-01).
  const z95 = ev.clusters !== undefined && ev.clusters >= 2 ? clusterT95(ev.clusters - 1) : SCALE_Z
  const lo95 = ev.mean - z95 * ev.se
  const fewClusters = ev.clusters === undefined || ev.clusters < MIN_STOP_CLUSTERS
  const u = ev.unit ?? ''
  const at = `checkpoint ${ev.n} trades, net $${ev.netDollars.toFixed(2)}, mean ${ev.mean.toFixed(2)}${u} (80% band ${lo.toFixed(2)}..${hi.toFixed(2)})`
  const up = (why: string): StageDecision => {
    if (notch >= MAX_NOTCH) return { kind: 'hold', checkpoint, reason: `${why}; already at max size x${MAX_NOTCH}` }
    if (fewClusters) return { kind: 'hold', checkpoint: lastCheckpoint, reason: `${why}; but on ${ev.clusters ?? 'unverifiable'} day-cluster(s) - under ${MIN_STOP_CLUSTERS} the band measures one day, not the edge; held at this size` }
    return { kind: 'scale-up', checkpoint, reason: why }
  }
  // A band on the mean says nothing until the sample has observed its own downside. kalshi-fade buys NO
  // at 0.89-0.98, so a win pays 2-11c and a loss costs 89-98c; twenty straight wins is a 36% event at a
  // true rate of exactly the entry price, i.e. at zero edge. On 2026-09-09 that produced a band of
  // 4.73..5.72 measuring only how much the WINNERS won (sd 3.1c against a mean of 5.2c) and doubled the
  // size of an unproven arm. Dispersion below the mean is the signature; one real loss restores it (a
  // single -95c against nineteen +5c reads inconclusive, which is the truth). An arm that is genuinely
  // this steady still promotes at the THOROUGH_TRADES review on the sign of its net.
  //
  // Asymmetric on purpose: this gates scaling UP only. Stopping early costs time, not money.
  const oneSided = ev.sd !== undefined && ev.n > 1 && ev.n < THOROUGH_TRADES && ev.sd < Math.abs(ev.mean)
  // Adverse selection at entry, measured on the fast meter. Settlement net cents disperse ~50x wider than
  // the 5-minute markout on the same arm, so this reaches significance while the settlement band is still
  // shrugging. Both arms the ladder has killed on settlement evidence were adversely selected, and the
  // markout showed it on a fraction of the sample. A VETO on scaling up, never a stop: refusing to add risk
  // to an arm that pays the spread to get in costs nothing, whereas closing one that might be earning does.
  const adverse =
    ev.adverse !== undefined &&
    ev.adverse.n >= ADVERSE_MIN_N &&
    ev.adverse.hi < 0 &&
    (ev.adverse.coverage === undefined || ev.adverse.coverage >= ADVERSE_MIN_COVERAGE)
  if (ev.netDollars > 0 && lo > 0) {
    if (oneSided) {
      // lastCheckpoint, not checkpoint: this is a deferral, not a judgement. Leaving the checkpoint
      // unjudged re-runs it every pass (the same thing a shard-0-blocked scale-up does), so the decision
      // can be made the moment a real loss lands rather than waiting out another twenty trades.
      return {
        kind: 'hold',
        checkpoint: lastCheckpoint,
        reason: `${at}: every trade in this sample landed the same way (sd ${ev.sd!.toFixed(2)}${u} under a mean of ${ev.mean.toFixed(2)}${u}), so the band measures the winners, not the edge - the downside is unsampled, keep testing at this size`
      }
    }
    if (adverse) {
      return {
        kind: 'hold',
        checkpoint: lastCheckpoint,
        reason: `${at}: making money, but the price moves against us right after we enter (5-min markout ${ev.adverse!.mean.toFixed(2)}c, 80% band ${ev.adverse!.lo.toFixed(2)}..${ev.adverse!.hi.toFixed(2)} over ${ev.adverse!.n}) - not adding size to an arm that pays the spread to get in`
      }
    }
    if (lo95 <= 0) {
      return { kind: 'hold', checkpoint: lastCheckpoint, reason: `${at}: making money with 80% confidence but not 95% (lower ${lo95.toFixed(2)}${u}) - the screening band admits an arm, the confirmatory band adds size; keep testing at this size` }
    }
    return up(`${at}: making money with 95% confidence`)
  }
  if (hi < 0) {
    // Undefined fails this too: `clusters` is undefined exactly when the per-day buckets do not account for
    // every trade, and the SE then falls back to the plain one, which treats correlated same-day fills as
    // independent and biases toward stopping. Unverifiable accounting, unusable verdict.
    // Scoped to the checkpoint band ONLY. At THOROUGH_TRADES the sign rule below is the pre-registered
    // backstop and it is not clustered - a losing arm at 100+ trades must still stop. The 2026-09-12 review
    // proved this guard was swallowing that path (n=100, hi<0, 3 clusters -> hold, held until the -$5 stop),
    // and the regression test that claimed otherwise never entered the hi<0 branch.
    if (ev.n < THOROUGH_TRADES && (ev.clusters === undefined || ev.clusters < MIN_STOP_CLUSTERS)) {
      return {
        kind: 'hold',
        checkpoint: lastCheckpoint,
        reason: `${at}: losing with 80% confidence, but on ${ev.clusters ?? 'unverifiable'} day-cluster(s) - under ${MIN_STOP_CLUSTERS} the band measures one day, not the edge (momentum was stopped this way on 2026-09-07); the -$${stop} stop still applies`
      }
    }
    return { kind: 'stop', checkpoint, reason: `${at}: losing money with 80% confidence over ${ev.clusters} day-clusters` }
  }
  if (ev.n >= THOROUGH_TRADES) {
    if (ev.netDollars > 0 && adverse) {
      return {
        kind: 'hold',
        checkpoint: lastCheckpoint,
        reason: `${at}: ${THOROUGH_TRADES}+ trades and net positive, but the 5-min markout band (${ev.adverse!.lo.toFixed(2)}..${ev.adverse!.hi.toFixed(2)} over ${ev.adverse!.n}) is wholly negative - held at this size`
      }
    }
    // A small win keeps the arm ALIVE at 100 trades; adding size still needs the confirmatory band (§12.14). Before
    // 2026-09-19 a net of +$0.02 on 100 even-money trades doubled the notch (external review, Gemini Flash F-02).
    if (ev.netDollars > 0 && lo95 <= 0) {
      return { kind: 'hold', checkpoint, reason: `${at}: ${THOROUGH_TRADES}+ trades and net positive, but the 95% lower bound is ${lo95.toFixed(2)}${u} - a small win is a win, not a reason to add size` }
    }
    if (ev.netDollars > 0) return up(`${at}: ${THOROUGH_TRADES}+ trades, net positive and the 95% band clear of zero`)
    if (ev.signStopExempt) {
      return { kind: 'hold', checkpoint, reason: `${at}: ${THOROUGH_TRADES}+ trades and net not positive - held, not stopped: at this arm's variance the sign of the net cannot separate its measured edge from zero; the 80% band stop and the hard stop still apply` }
    }
    return { kind: 'stop', checkpoint, reason: `${at}: ${THOROUGH_TRADES}+ trades and net not positive` }
  }
  return { kind: 'hold', checkpoint, reason: `${at}: inconclusive, keep testing` }
}

/** Weather quoter entry: shadow/blocked → tiny-live on the allowed cohort's gate (live stages: decideStage). */
export function decideQuoter(stage: Stage, gate: GateEvidence | null): Decision | null {
  if (stage !== 'shadow' && stage !== 'blocked') return null
  if (gate && gate.n >= QUOTER_GATE.minFills && gate.events >= QUOTER_GATE.minEvents && gate.lo > 0) {
    return { to: 'tiny-live', reason: `allowed cohort ${gate.n} fills / ${gate.events} events, mean ${gate.mean.toFixed(2)}c, CI lower ${gate.lo.toFixed(2)}c > 0` }
  }
  return null
}

/** BTC convergence entry: shadow/blocked → tiny-live on the pre-registered gate (live stages: decideStage). */
export function decideConvergence(stage: Stage, gate: { pass: boolean; events: number; lb: number | null } | null): Decision | null {
  if (stage !== 'shadow' && stage !== 'blocked') return null
  if (gate?.pass) return { to: 'tiny-live', reason: `pre-registered gate PASS (${gate.events} events, corrected CI lower ${gate.lb?.toFixed(2)}c)` }
  return null
}

/** Settlement ratchet entry: paper/blocked → tiny-live on its clustered paper record (live stages: decideStage). */
export function decideSettlement(stage: Stage, calib: { netN: number; netCiLo?: number; netCents?: number } | null): Decision | null {
  if (stage !== 'paper' && stage !== 'blocked') return null
  if (calib && calib.netN >= 40 && calib.netCiLo !== undefined && calib.netCiLo > 0) {
    return { to: 'tiny-live', reason: `paper ${calib.netN} graded, net ${(calib.netCents ?? 0).toFixed(2)}c, event-clustered CI lower ${calib.netCiLo.toFixed(2)}c > 0` }
  }
  return null
}
export function isPromotion(from: Stage, to: Stage): boolean {
  const rank: Record<Stage, number> = { disabled: 0, blocked: 1, shadow: 1, paper: 1, 'tiny-live': 2, live: 3 }
  return rank[to] > rank[from]
}

export type LadderMode = 'prove-first' | 'trade-small'

/**
 * Trade-small mode: a recording-only (shadow/paper), blocked or demoted strategy
 * goes straight to a real-money micro test instead of waiting for its gate.
 * The live-loss rules (-$5 stop, significance demotion) still apply; the
 * demotion cool-down (3 days, then 14 days doubling after `maxDemotions`
 * stops) is respected, and a strategy the operator switched off by hand stays
 * off. Returns null when the ordinary gate decision should be used.
 */
export function tradeSmallEntry(
  mode: LadderMode | undefined,
  stage: Stage,
  demotions: number,
  maxDemotions: number,
  cooldownUntil: number | undefined,
  operatorHold: boolean,
  now: number,
  target: 'tiny-live' | 'live' = 'tiny-live',
  lifetimeDollars?: number,
  lifetimeFloor?: number,
  /** The stop this arm is held to at notch 1 (lead-lag's is $10, section 139); the reason must name it (backlog 23). */
  stopDollars: number = LIVE_STOP_DOLLARS
): Decision | null {
  if (mode !== 'trade-small') return null
  if (stage !== 'shadow' && stage !== 'paper' && stage !== 'blocked' && stage !== 'disabled') return null
  if (operatorHold) return null
  if (cooldownUntil && now < cooldownUntil) return null
  // An arm whose whole life has already lost the lifetime floor is not re-armed by a clock. Without this the floor
  // stopped an arm and the cool-down handed it straight back to real money (2026-09-22: momentum -$14.42 and
  // book-imbalance -$12.38 lifetime, re-arming on 09-27 and 09-25). A gate or the operator can still promote it.
  if (lifetimeDollars !== undefined && lifetimeFloor !== undefined && lifetimeDollars <= -lifetimeFloor) return null
  // Nor is an arm stopped maxDemotions times (backlog 220, section 163). The cap was discarded (`void maxDemotions`)
  // since the first commit, so a twice-stopped arm came back on its cool-down alone: sports-anchor on 09-14 after a
  // -$5.14 stop (3 wins in 19 after), and volume-spike was due back on 2026-10-05. A gate or the operator can still
  // promote it.
  if (demotions >= maxDemotions) return null
  return { to: target, reason: `trade-small mode: real-money micro test ${demotions + 1} (stop -$${stopDollars})` }
}

// ---- runner ----

interface QuoterGateJson {
  allowed: { n: number; events: number; mean: number; lo: number; hi: number } | null
  blocked: { n: number; events: number; mean: number; lo: number; hi: number } | null
}
interface BtcGateJson {
  pass: boolean
  events: number
  graded: number
  lbBonferroni: number | null
}

export class Ladder {
  private state: LadderState = { strategies: {} }
  private running = false
  private note = 'idle'

  constructor(
    private readonly engine: TradingEngine,
    private readonly autoTrader: AutoTrader,
    private readonly minis: Map<VenueId, MiniAuto>,
    private readonly appPath: string,
    private readonly userData: string,
    private readonly log: (s: string) => void = console.log
  ) {
    const loaded = loadJsonOrQuarantine<Partial<LadderState>>(this.statePath(), this.log)
    if (loaded) this.state = { ...this.state, ...loaded }
  }

  private statePath(): string {
    return join(this.userData, 'ladder.json')
  }

  private mode(): LadderMode {
    return this.autoTrader.getConfig().ladderMode ?? 'prove-first'
  }

  /** Trade-small entry for a strategy, or null to fall back to its gate. */
  private tradeSmall(s: LadderStrategy, target: 'tiny-live' | 'live' = 'tiny-live'): Decision | null {
    const cfg = this.autoTrader.getConfig()
    // The same floor decideStage applies at notch 1: max(stage stop, three stakes) x LIFETIME_STOP_MULTIPLE.
    const floor = Math.max(LIVE_STOP_DOLLARS, 3 * (cfg.amountPerTrade ?? 0)) * LIFETIME_STOP_MULTIPLE
    const stop = GENERIC_BY_ID.get(s.id)?.contracts ? LEADLAG_STOP_DOLLARS : LIVE_STOP_DOLLARS
    return tradeSmallEntry(this.mode(), s.stage, s.demotions ?? 0, cfg.ladderMaxDemotionsBeforeGate ?? 2, s.cooldownUntil, (s.operatorHold ?? false) || !!s.retired, Date.now(), target, this.lifetimeFor(s.id), floor, stop)
  }

  /** Realized dollars across every cohort an arm has traded under, or undefined for arms not on the trader's ledger. */
  private lifetimeFor(id: LadderStrategyId): number | undefined {
    const key = this.traderKey(id)
    if (!key) return undefined
    let total = 0
    for (const [k, v] of Object.entries(this.autoTrader.getStatus().perfByStrategy ?? {})) {
      if (k === key || k.startsWith(`${key}:`)) total += v?.realizedPnl ?? 0
    }
    return total
  }

  /** Why trade-small entry did not fire (prefix for the gate verdict). */
  private gateOnly(s: LadderStrategy): string {
    if (this.mode() !== 'trade-small') return ''
    if (s.operatorHold) return 'switched off in the panel (operator hold); '
    if (s.retired) return `retired by its registration (${s.retired.reason}); `
    if ((s.demotions ?? 0) >= (this.autoTrader.getConfig().ladderMaxDemotionsBeforeGate ?? 2)) return `stopped ${s.demotions} times: only its gate or the operator can re-arm it; `
    if (s.cooldownUntil && Date.now() < s.cooldownUntil) return `cool-down until ${new Date(s.cooldownUntil).toISOString().slice(0, 10)} after ${s.demotions ?? 0} stop(s); `
    return ''
  }

  private genericOn(g: GenericSpec): boolean {
    if (g.venue === 'kalshi') return !!(this.autoTrader.getConfig() as unknown as Record<string, unknown>)[g.flag]
    const m = this.minis.get('polymarket-us')?.getConfig() as unknown as Record<string, unknown> | undefined
    return !!m?.[g.flag]
  }

  /** perfByStrategy / calibration key for strategies judged on the Kalshi trader's own ledgers. */
  private traderKey(id: LadderStrategyId): string | undefined {
    if (id === 'settlement') return 'settlement'
    const g = GENERIC_BY_ID.get(id)
    return g && g.venue === 'kalshi' && !g.contracts ? g.key : undefined
  }

  status(): LadderStatus {
    return {
      enabled: this.autoTrader.getConfig().ladderEnabled ?? true,
      mode: this.mode(),
      lastRunAt: this.state.lastRunAt,
      lastPromotionAt: this.state.lastPromotionAt,
      strategies: Object.values(this.state.strategies).map((s) => ({ ...s, history: s.history.slice(-10) })),
      note: this.note
    }
  }

  private persist(): void {
    try {
      const p = this.statePath()
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p + '.tmp', JSON.stringify(this.state, null, 2), { encoding: 'utf8', flush: true })
      renameSync(p + '.tmp', p)
    } catch (e) {
      this.log('[ladder] persist failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /** Run a gate script with --json and parse its GATE_JSON line. */
  private runGate<T>(script: string, timeoutMs = 180_000): Promise<T | null> {
    return new Promise((resolve) => {
      let out = ''
      let done = false
      // Run the gate with the app's own binary as Node (ELECTRON_RUN_AS_NODE)
      // so evaluation never depends on a `node` being on the launcher's PATH.
      const child = spawn(process.execPath, [join(this.appPath, 'scripts', script), '--json'], {
        cwd: this.appPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true
      })
      const timer = setTimeout(() => {
        if (!done) {
          done = true
          child.kill()
          this.log(`[ladder] gate ${script} timed out`)
          resolve(null)
        }
      }, timeoutMs)
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr.on('data', () => undefined)
      child.on('error', (e) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.log(`[ladder] gate ${script} failed to start: ${e.message}`)
        resolve(null)
      })
      child.on('close', () => {
        if (done) return
        done = true
        clearTimeout(timer)
        const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith('GATE_JSON '))
        if (!line) {
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(line.slice('GATE_JSON '.length)) as T)
        } catch {
          resolve(null)
        }
      })
    })
  }

  /** Stage implied by the live config (the operator may flip switches by hand; the ladder follows). */
  private configDefaulted(id: LadderStrategyId): boolean {
    const g = GENERIC_BY_ID.get(id)
    const onMini = id === 'polyus-micro-maker' || g?.venue === 'polymarket-us'
    const src = onMini ? this.minis.get('polymarket-us') : this.autoTrader
    return !!(src as { configDefaulted?: () => boolean } | undefined)?.configDefaulted?.()
  }

  private configStage(id: LadderStrategyId): Stage {
    const k = this.autoTrader.getConfig()
    switch (id) {
      case 'quoter':
        return k.quoterEnabled ? 'tiny-live' : 'shadow'
      case 'convergence':
        return k.convergenceLiveEnabled ? 'tiny-live' : 'shadow'
      case 'settlement':
        return k.settleLiveEnabled ? 'tiny-live' : 'paper'
      case 'polyus-micro-maker': {
        const m = this.minis.get('polymarket-us')?.getConfig()
        return m?.microMakerEnabled ? 'live' : 'disabled'
      }
      default: {
        const g = GENERIC_BY_ID.get(id)
        return g && this.genericOn(g) ? 'tiny-live' : 'disabled'
      }
    }
  }

  private strategy(id: LadderStrategyId): LadderStrategy {
    let s = this.state.strategies[id]
    if (!s) {
      s = { id, stage: this.configStage(id), since: Date.now(), history: [] }
      this.state.strategies[id] = s
    } else {
      // Reconcile with a manual flip: the config is the truth for the current stage.
      const cfgStage = this.configStage(id)
      const liveish = (x: Stage): boolean => x === 'tiny-live' || x === 'live'
      // A strategy the operator switched on by hand while the ladder had it
      // 'blocked' must still get the live-loss demotion rules, so 'blocked'
      // re-syncs too whenever the config says it is live.
      if (liveish(cfgStage) !== liveish(s.stage)) {
        s.history.push({ at: Date.now(), from: s.stage, to: cfgStage, reason: 'manual change in the panel' })
        s.stage = cfgStage
        s.since = Date.now()
        s.baseline = this.captureBaseline(id)
        s.lastCheckpoint = 0 // the evidence restarts with the baseline (audit B-19)
        // A switch-off in the panel is the operator's call: trade-small entry
        // stays off until the operator switches it back on (a passing gate can
        // still promote). A switch-on clears the hold.
        // ...unless the config is defaults because its file was unreadable and set aside: a power loss zero-filled
        // kalshi-auto.json on 2026-09-21 and every arm read as switched off by hand (backlog 224). That is no
        // operator's call, so no hold is created (an existing one stays) and trade-small may re-arm by its own rules.
        if (!this.configDefaulted(id)) s.operatorHold = !liveish(cfgStage)
        if (liveish(cfgStage)) delete s.retired
      }
    }
    return s
  }

  /**
   * Stop an arm on its pre-registered read (section 163): off now, and never re-armed by trade-small's clock. It is
   * not an operator hold; switching it on in the panel still brings it back.
   */
  async retire(id: LadderStrategyId, reason: string): Promise<void> {
    const s = this.strategy(id)
    if (s.stage === 'tiny-live' || s.stage === 'live') await this.apply(s, { to: 'disabled', reason: `retired by its registration: ${reason}` })
    s.retired = { at: Date.now(), reason }
    s.lastVerdict = `retired by its registration: ${reason}`
    this.log(`[ladder] ${id}: retired by its registration - ${reason}`)
    this.persist()
  }

  private captureBaseline(id: LadderStrategyId): Record<string, number> {
    const key = this.traderKey(id)
    if (key) {
      const st = this.autoTrader.getStatus()
      const p = st.perfByStrategy?.[key]
      const c = st.calib?.byStrategy?.[key] as unknown as CalibAccumulator | undefined
      const b: Record<string, number> = { trades: p?.trades ?? 0, realizedPnl: p?.realizedPnl ?? 0, netN: c?.netN ?? 0, netSum: c?.netSum ?? 0, netSq: c?.netSq ?? 0,
        wN: c?.wN ?? 0, wSum: c?.wSum ?? 0, wSq: c?.wSq ?? 0, wTrades: c?.wTrades ?? 0 }
      // Per-day sums so the live evidence can be clustered by day since promotion.
      for (const [day, g] of Object.entries(c?.byDay ?? {})) {
        b[`dayN:${day}`] = g.n
        b[`daySum:${day}`] = g.sum
        b[`dayW:${day}`] = g.w ?? 0
        b[`dayWSum:${day}`] = g.wsum ?? 0
      }
      // Trades still open from the previous stage settle later and would land
      // in this stage's evidence (2026-09-08: two mean-reversion v2 losers
      // would have stopped v3 the moment they booked). Detach them: their
      // exits record under a side key the ladder never reads.
      const detached = this.autoTrader.detachOpenTrades(key, 'pre-' + new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-'))
      if (detached > 0) this.log(`[ladder] ${id}: ${detached} open trade(s)/rest(s) from the previous stage detached from the new evidence`)
      return b
    }
    return {}
  }

  /** Arm / live mode / kill / pause: the preconditions for spending, without the promotion stagger. */
  private liveAllowed(): string | null {
    const cfg = this.autoTrader.getConfig()
    const st = this.autoTrader.getStatus()
    if (!(cfg.ladderEnabled ?? true)) return 'ladder disabled'
    if (this.engine.getExecutionMode() !== 'live') return 'execution mode is paper'
    if (!cfg.liveArmed) return 'LIVE not armed by the operator'
    if (st.killSwitchTripped) return 'kill switch tripped today'
    if (st.exchangePaused) return 'exchange paused'
    return null
  }

  private promotionsAllowed(): string | null {
    const why = this.liveAllowed()
    if (why) return why
    if (this.state.lastPromotionAt && Date.now() - this.state.lastPromotionAt < PROMOTION_STAGGER_MS) return `another strategy was promoted within ${PROMOTION_STAGGER_MS / 3600_000}h`
    return null
  }

  /** Stage a strategy returns to when its live test stops. */
  private offStage(id: LadderStrategyId): Stage {
    if (id === 'settlement') return 'paper'
    if (id === 'quoter' || id === 'convergence') return 'shadow'
    return 'disabled'
  }

  /** Size knobs for a notch (1 = micro). The ladder owns these for the strategies it manages. */
  private sizesFor(id: LadderStrategyId, notch: number): Partial<AutoTraderConfig> {
    switch (id) {
      case 'quoter':
        return { quoterMaxContracts: notch, quoterMaxMarkets: 4, quoterMaxExposure: 4 * notch }
      case 'convergence':
        return { convergenceMaxContractsPerTrade: notch, convergenceMaxDailyTrades: 6 * notch }
      case 'settlement':
        return { strategySizeMult: { ...(this.autoTrader.getConfig().strategySizeMult ?? {}), settlement: notch } }
      default: {
        const g = GENERIC_BY_ID.get(id)
        if (!g || g.venue !== 'kalshi') return {}
        if (g.contracts) return { leadLagMaxContractsPerOrder: notch * (g.contractsPerNotch ?? 1) }
        return { strategySizeMult: { ...(this.autoTrader.getConfig().strategySizeMult ?? {}), [g.key]: notch } }
      }
    }
  }

  /** Polymarket US signal strategies: stake multiplier on the mini's config. */
  private miniSizes(g: GenericSpec, notch: number): Partial<MiniAutoConfig> {
    const cur = (this.minis.get('polymarket-us')?.getConfig().strategySizeMult ?? {}) as Record<string, number>
    return { strategySizeMult: { ...cur, [g.key]: notch } }
  }

  /** Apply the size for a notch to whichever venue owns the strategy. */
  private applySize(s: LadderStrategy, notch: number): void {
    const g = GENERIC_BY_ID.get(s.id)
    if (s.id === 'polyus-micro-maker') {
      const mini = this.minis.get('polymarket-us')
      if (mini) mini.setConfig({ microMakerMaxMarkets: this.microMarkets(notch) })
    } else if (g && g.venue === 'polymarket-us') {
      const mini = this.minis.get('polymarket-us')
      if (mini) mini.setConfig(this.miniSizes(g, notch))
    } else {
      this.autoTrader.setConfig(this.sizesFor(s.id, notch))
    }
  }

  private stageLabel(s: LadderStrategy): string {
    return (s.notch ?? 1) > 1 ? `live x${s.notch}` : s.stage
  }

  /** Micro-maker breadth per notch: one contract per market, 6 / 8 / 12 markets. */
  private microMarkets(notch: number): number {
    return Math.min(12, 6 + 2 * (notch - 1))
  }

  /** Apply the current size table to a live strategy once per SIZES_VERSION. */
  private ensureSizes(s: LadderStrategy): void {
    if (s.sizesVersion === SIZES_VERSION) return
    const notch = s.notch ?? 1
    this.applySize(s, notch)
    s.sizesVersion = SIZES_VERSION
    this.log(`[ladder] ${s.id}: size table v${SIZES_VERSION} applied at x${notch}`)
  }

  private async apply(s: LadderStrategy, d: Decision): Promise<void> {
    const promo = isPromotion(s.stage, d.to)
    if (promo) {
      const why = this.promotionsAllowed()
      if (why) {
        s.lastVerdict = `${d.reason}; promotion held: ${why}`
        return
      }
      if (s.cooldownUntil && Date.now() < s.cooldownUntil) {
        s.lastVerdict = `${d.reason}; cool-down until ${new Date(s.cooldownUntil).toISOString()}`
        return
      }
    }
    switch (s.id) {
      case 'quoter': {
        if (d.to === 'tiny-live') {
          // Weather settles on shard 0; a promotion into an unfunded shard is a
          // rejected-order loop, not a test. Top the shard up (bounded by the
          // operator's ladderAutoAllocateUsd) and block if that is not enough.
          if (!(await this.shard0Ready(s, d))) return
          this.autoTrader.setConfig({ quoterEnabled: true, ...this.sizesFor('quoter', 1) })
        } else {
          this.autoTrader.setConfig({ quoterEnabled: false, ...this.sizesFor('quoter', 1) })
        }
        break
      }
      case 'convergence':
        this.autoTrader.setConfig({ convergenceLiveEnabled: d.to === 'tiny-live', ...this.sizesFor('convergence', 1) })
        break
      case 'settlement':
        // The ratchet trades weather brackets, which also settle on shard 0.
        if (d.to === 'tiny-live' && !(await this.shard0Ready(s, d))) return
        this.autoTrader.setConfig({ settleLiveEnabled: d.to === 'tiny-live', ...this.sizesFor('settlement', 1) })
        break
      case 'polyus-micro-maker': {
        const mini = this.minis.get('polymarket-us')
        if (mini) mini.setConfig({ microMakerEnabled: d.to === 'live', microMakerMaxMarkets: this.microMarkets(1) })
        break
      }
      default: {
        const g = GENERIC_BY_ID.get(s.id)
        if (!g) break
        const on = d.to === 'tiny-live'
        if (g.venue === 'kalshi') {
          this.autoTrader.setConfig({ [g.flag]: on, ...(on ? g.also ?? {} : {}), ...this.sizesFor(s.id, 1) } as Partial<AutoTraderConfig>)
        } else {
          const mini = this.minis.get('polymarket-us')
          if (mini) mini.setConfig({ [g.flag]: on, ...this.miniSizes(g, 1) } as Partial<MiniAutoConfig>)
        }
        break
      }
    }
    this.transition(s, d.to, d.reason)
    s.notch = 1
    s.lastCheckpoint = 0
    s.sizesVersion = SIZES_VERSION
    if (promo) this.state.lastPromotionAt = Date.now()
    else s.cooldownUntil = Date.now() + cooldownAfter(s.demotions ?? 0, this.autoTrader.getConfig().ladderMaxDemotionsBeforeGate ?? 2)
  }

  /** Checkpoint win: double the size (x2, then x4) and measure again from here. False = held, retried next run. */
  private async scaleUp(s: LadderStrategy, reason: string): Promise<boolean> {
    const why = this.liveAllowed()
    if (why) {
      s.lastVerdict = `${reason}; scale-up held: ${why}`
      return false
    }
    const notch = Math.min(MAX_NOTCH, (s.notch ?? 1) * 2)
    if (s.id === 'quoter' || s.id === 'settlement') {
      // Weather collateral lives on shard 0: it must carry the bigger size first.
      const f = await this.fundShard0(SHARD0_MIN_DOLLARS * notch)
      if (f.shard0 < SHARD0_MIN_DOLLARS * notch) {
        s.lastVerdict = `${reason}; scale-up held: shard 0 holds $${f.shard0.toFixed(2)}, needs $${(SHARD0_MIN_DOLLARS * notch).toFixed(2)}${f.note ? ` (${f.note})` : ''}`
        return false
      }
    }
    this.applySize(s, notch)
    const from = this.stageLabel(s)
    s.notch = notch
    s.lastCheckpoint = 0
    s.sizesVersion = SIZES_VERSION
    s.since = Date.now()
    s.baseline = this.captureBaseline(s.id)
    s.history.push({ at: Date.now(), from: s.stage, to: 'live', reason: `${reason} -> size x${notch}` })
    s.stage = 'live'
    s.lastVerdict = `${from} -> live x${notch}: ${reason}`
    this.log(`[ladder] ${s.id}: ${from} -> live x${notch} — ${reason}`)
    const url = this.autoTrader.getConfig().alertWebhookUrl
    if (url) void sendAlert(url, `Oracle Trader — ladder: ${s.id} scaled to x${notch}`, reason)
    return true
  }

  /** Judge a live stage on its evidence: stop, scale up or hold. */
  private async judgeLive(s: LadderStrategy, ev: StageEvidence | null): Promise<void> {
    if (!ev) {
      s.lastVerdict = `${this.stageLabel(s)}: evidence unavailable this run`
      return
    }
    this.ensureSizes(s)
    const d = decideStage(ev, s.notch ?? 1, s.lastCheckpoint ?? 0)
    if (d.kind === 'stop') {
      s.lastCheckpoint = d.checkpoint
      await this.apply(s, { to: this.offStage(s.id), reason: d.reason })
    } else if (d.kind === 'scale-up') {
      // A held scale-up keeps the checkpoint unjudged so it is retried next run.
      await this.scaleUp(s, d.reason)
    } else {
      s.lastCheckpoint = d.checkpoint
      s.lastVerdict = `${this.stageLabel(s)}: ${d.reason}`
    }
  }

  private transition(s: LadderStrategy, to: Stage, reason: string): void {
    const from = s.stage
    const liveish = (x: Stage): boolean => x === 'tiny-live' || x === 'live'
    // Count real-money demotions (not blocked holds, not manual flips) so
    // trade-small mode hands the strategy back to its gate after the cap.
    if (liveish(from) && !liveish(to) && to !== 'blocked') s.demotions = (s.demotions ?? 0) + 1
    // The baseline being replaced goes into the history row: a stop used to overwrite the promotion's baseline with
    // nothing kept, so the evidence behind the stage just left could not be re-read (backlog 81a).
    s.history.push({ at: Date.now(), from, to, reason, ...(s.baseline ? { baseline: s.baseline } : {}) })
    s.stage = to
    s.since = Date.now()
    s.lastVerdict = `${from} → ${to}: ${reason}`
    s.baseline = this.captureBaseline(s.id)
    this.log(`[ladder] ${s.id}: ${from} → ${to} — ${reason}`)
    const url = this.autoTrader.getConfig().alertWebhookUrl
    if (url) void sendAlert(url, `Oracle Trader — ladder: ${s.id} ${from} → ${to}`, reason)
  }

  // ---- collateral ----

  /**
   * Weather contracts settle on Kalshi shard 0. Returns true when shard 0 can
   * carry a micro test, topping it up first (see fundShard0). Otherwise records
   * the block and returns false.
   */
  private async shard0Ready(s: LadderStrategy, d: Decision): Promise<boolean> {
    const f = await this.fundShard0(SHARD0_MIN_DOLLARS)
    if (f.shard0 >= SHARD0_MIN_DOLLARS) return true
    const why = `${d.reason}; shard 0 holds $${f.shard0.toFixed(2)}${f.note ? ` (${f.note})` : ''}; allocate collateral to shard 0 or raise the ladder top-up cap`
    // Already blocked for the same reason: refresh the verdict, do not append
    // a blocked-to-blocked transition every evaluation.
    if (s.stage === 'blocked') s.lastVerdict = `blocked: ${why}`
    else this.transition(s, 'blocked', why)
    return false
  }

  /**
   * Top shard 0 up to the operator's ladderAutoAllocateUsd from another shard
   * (shard 3, sports, preferred when it can cover the need; else the largest;
   * the source keeps $1). Moves nothing when the cap is 0, when the top-up
   * could not reach `need`, or when the venue cannot transfer. Never touches
   * the global arm, sizes or loss limits.
   */
  /** Per-UTC-day total moved by levelShards, and when each shard was last topped up. */
  private shardMovedDay: { date: string; dollars: number } = { date: '', dollars: 0 }
  private shardLastMove = new Map<number, number>()

  /**
   * Level EVERY shard the venue reports to SHARD_FLOOR_DOLLARS, drawing from the shard with the most to spare.
   * Intra-account only: this calls the venue's shard-to-shard transfer and can never move money off the account.
   * Returns what it moved so the caller can log it once.
   *
   * Refuses to act when: the venue cannot transfer; the operator has halted entries (a halt means stop moving
   * money around too); no shard has spare above the floor; the move would be under SHARD_MIN_MOVE; or the run or
   * day ceiling is reached. One move per target shard per 15 minutes, so a venue that reports stale balances
   * cannot be drained by repetition.
   */
  async levelShards(now = Date.now()): Promise<{ moved: number; moves: string[] }> {
    const moves: string[] = []
    if (this.engine.getExecutionMode() !== 'live') return { moved: 0, moves }
    const cfg = this.autoTrader.getConfig()
    if (cfg.stopEntry === true || cfg.dryRun === true) return { moved: 0, moves }
    const adapter = this.engine.getAdapter('kalshi') as (VenueAdapter & { transferBetweenShards?: (from: number, to: number, dollars: number) => Promise<string> }) | undefined
    if (!adapter?.transferBetweenShards) return { moved: 0, moves }
    const today = new Date(now).toISOString().slice(0, 10)
    if (this.shardMovedDay.date !== today) this.shardMovedDay = { date: today, dollars: 0 }
    let runMoved = 0
    for (let pass = 0; pass < 4; pass++) {
      const acct = await adapter.getAccount().catch(() => undefined)
      const byShard = (acct?.balanceByShard ?? {}) as Record<string, number>
      const rows = Object.entries(byShard).map(([k, v]) => ({ shard: Number(k), bal: Number(v) || 0 })).filter((x) => Number.isInteger(x.shard))
      if (rows.length < 2) break
      const short = rows.filter((x) => x.bal < SHARD_FLOOR_DOLLARS && (now - (this.shardLastMove.get(x.shard) ?? 0)) > 15 * 60_000).sort((a, b) => a.bal - b.bal)[0]
      if (!short) break
      const donor = rows.filter((x) => x.shard !== short.shard).map((x) => ({ shard: x.shard, free: x.bal - SHARD_FLOOR_DOLLARS })).sort((a, b) => b.free - a.free)[0]
      if (!donor || donor.free < SHARD_MIN_MOVE) { moves.push(`shard ${short.shard} is at $${short.bal.toFixed(2)} but no other shard holds more than the $${SHARD_FLOOR_DOLLARS} floor`); break }
      const room = Math.min(SHARD_MAX_MOVE_PER_RUN - runMoved, SHARD_MAX_MOVE_PER_DAY - this.shardMovedDay.dollars)
      const amount = Math.floor(Math.min(SHARD_FLOOR_DOLLARS - short.bal, donor.free, room) * 100 + 1e-9) / 100
      if (amount < SHARD_MIN_MOVE) { if (room < SHARD_MIN_MOVE) moves.push(`shard levelling has reached its ${room === SHARD_MAX_MOVE_PER_RUN - runMoved ? 'per-run' : 'daily'} ceiling`); break }
      try {
        const id = await adapter.transferBetweenShards(donor.shard, short.shard, amount)
        this.shardLastMove.set(short.shard, now)
        this.shardMovedDay.dollars += amount
        runMoved += amount
        const msg = `moved $${amount.toFixed(2)} from shard ${donor.shard} to shard ${short.shard} (was $${short.bal.toFixed(2)}, transfer ${id || 'n/a'})`
        this.log(`[ladder] ${msg}`)
        moves.push(msg)
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        this.log(`[ladder] shard transfer failed: ${m}`)
        moves.push(`transfer to shard ${short.shard} failed: ${m.slice(0, 120)}`)
        break
      }
    }
    if (runMoved > 0) {
      const url = this.autoTrader.getConfig().alertWebhookUrl
      if (url) void sendAlert(url, 'Oracle Trader - collateral levelled across shards', moves.join('; '))
    }
    return { moved: runMoved, moves }
  }

  private async fundShard0(need: number): Promise<{ shard0: number; moved: number; note: string }> {
    const adapter = this.engine.getAdapter('kalshi') as (VenueAdapter & { transferBetweenShards?: (from: number, to: number, dollars: number) => Promise<string> }) | undefined
    const read = async (): Promise<{ shard0: number; byShard: Record<string, number> }> => {
      const acct = await adapter?.getAccount().catch(() => undefined)
      const byShard = (acct?.balanceByShard ?? {}) as Record<string, number>
      return { shard0: byShard['0'] ?? acct?.balance ?? 0, byShard }
    }
    const before = await read()
    if (before.shard0 >= need) return { shard0: before.shard0, moved: 0, note: '' }
    const cap = Math.max(0, this.autoTrader.getConfig().ladderAutoAllocateUsd ?? 0)
    if (cap <= 0) return { shard0: before.shard0, moved: 0, note: 'shard-0 top-up is off' }
    if (!adapter?.transferBetweenShards) return { shard0: before.shard0, moved: 0, note: 'venue cannot move collateral' }
    const sources = Object.entries(before.byShard)
      .map(([k, v]) => ({ shard: Number(k), free: Math.max(0, (v ?? 0) - 1) }))
      .filter((x) => x.shard !== 0 && x.free >= 0.01)
    if (sources.length === 0) return { shard0: before.shard0, moved: 0, note: 'no other shard holds more than $1' }
    const needAmt = need - before.shard0
    const largest = sources.reduce((a, b) => (b.free > a.free ? b : a))
    const three = sources.find((x) => x.shard === 3)
    const src = three && three.free >= needAmt ? three : largest
    // Fill to the cap in one move (fewer transfers on a non-atomic API);
    // the hourly check only fires while shard 0 is below the stage's need.
    const amount = Math.floor(Math.min(Math.max(0, cap - before.shard0), src.free) * 100 + 1e-9) / 100
    if (amount < 0.01) return { shard0: before.shard0, moved: 0, note: `top-up cap $${cap.toFixed(2)} already reached` }
    if (before.shard0 + amount < need) return { shard0: before.shard0, moved: 0, note: `top-up of $${amount.toFixed(2)} would not reach $${need.toFixed(2)} (cap $${cap.toFixed(2)}, shard ${src.shard} free $${src.free.toFixed(2)})` }
    try {
      const id = await adapter.transferBetweenShards(src.shard, 0, amount)
      const after = await read()
      const msg = `moved $${amount.toFixed(2)} from shard ${src.shard} to shard 0 (transfer ${id || 'n/a'}); shard 0 now $${after.shard0.toFixed(2)}`
      this.log(`[ladder] ${msg}`)
      const url = this.autoTrader.getConfig().alertWebhookUrl
      if (url) void sendAlert(url, 'Oracle Trader - ladder moved collateral', msg)
      return { shard0: after.shard0, moved: amount, note: msg }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      this.log(`[ladder] shard transfer failed: ${m}`)
      return { shard0: before.shard0, moved: 0, note: `transfer failed: ${m.slice(0, 120)}` }
    }
  }

  /**
   * Deposits land on shard 0, but sports and crypto markets clear on other
   * shards and can only spend what sits there (2026-09-07: a $50 deposit
   * left the sports shard at $1.01 after it carried 46 of the last 98 fills).
   * Every run, top each already-used shard (balance above zero) up to
   * SHARD_WORKING_DOLLARS from shard 0's surplus above ladderAutoAllocateUsd.
   * Never touches the arm, sizes or loss limits; never funds an unused shard.
   */
  private async balanceShards(): Promise<void> {
    const adapter = this.engine.getAdapter('kalshi') as (VenueAdapter & { transferBetweenShards?: (from: number, to: number, dollars: number) => Promise<string> }) | undefined
    if (!adapter?.transferBetweenShards) return
    const cap = Math.max(0, this.autoTrader.getConfig().ladderAutoAllocateUsd ?? 0)
    if (cap <= 0) return
    const acct = await adapter.getAccount().catch(() => undefined)
    const byShard = (acct?.balanceByShard ?? {}) as Record<string, number>
    let spare = (byShard['0'] ?? 0) - cap
    if (spare < 1) return
    for (const [k, v] of Object.entries(byShard)) {
      const shard = Number(k)
      if (shard === 0 || !(v > 0)) continue
      const amount = Math.floor(Math.min(SHARD_WORKING_DOLLARS - v, spare) * 100 + 1e-9) / 100
      if (amount < 1) continue
      try {
        const id = await adapter.transferBetweenShards(0, shard, amount)
        spare -= amount
        const msg = `moved $${amount.toFixed(2)} from shard 0 to shard ${shard} (transfer ${id || 'n/a'}); shard ${shard} had $${v.toFixed(2)}`
        this.log(`[ladder] ${msg}`)
        const url = this.autoTrader.getConfig().alertWebhookUrl
        if (url) void sendAlert(url, 'Oracle Trader - ladder moved collateral', msg)
      } catch (e) {
        this.log(`[ladder] shard ${shard} top-up failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (spare < 1) break
    }
  }

  // ---- evidence ----

  private async quoterEvidence(since: number, notch: number): Promise<StageEvidence | null> {
    const pnl = await this.engine.getLivePnl('kalshi').catch(() => null)
    if (!pnl?.details) return null
    // Only markets the quoter itself filled on: the settlement ratchet and the weather-morning arms settle the
    // same KXHIGH/KXLOW tickers, and until 2026-09-19 every one of their rows was the quoter's evidence (audit
    // B-22). A market that another arm also filled on is excluded: Kalshi settles one net position per market.
    const mine = this.autoTrader.quoterFilledMarkets(since - 24 * 60 * 60_000)
    const others = this.autoTrader.otherArmMarkets('quoter', since - 24 * 60 * 60_000)
    const rows = pnl.details.filter((d) => d.timestamp >= since && /^KX(HIGH|LOW)/.test(d.marketId) && mine.has(d.marketId) && !others.has(d.marketId))
    // Cluster by city-day event (ticker without its strike): one day's brackets settle together.
    const obs = rows.filter((r) => r.shares > 0).map((r) => ({ v: (r.realizedPnl / r.shares) * 100, g: r.marketId.replace(/-[A-Z]?[\d.]+$/, '') }))
    const ci = clusteredMean(obs)
    // n is the rows the mean was taken over, not every row (a zero-share row counted before and was not averaged).
    return { n: obs.length, netDollars: rows.reduce((a, r) => a + r.realizedPnl, 0), mean: ci.mean, se: ci.se, sd: ci.sd, clusters: ci.groups, unit: 'c/contract', stake: 1 * notch }
  }

  private convergenceEvidence(since: number, notch: number): StageEvidence | null {
    try {
      const p = join(this.userData, 'crypto-convergence.json')
      if (!existsSync(p)) return { n: 0, netDollars: 0, mean: 0, se: 0, unit: 'c', stake: 0.88 * notch }
      const st = JSON.parse(readFileSync(p, 'utf8')) as { trades?: { ts: string; status: string; realizedPnlCents?: number; eventTicker?: string; marketTicker?: string }[] }
      const rows = (st.trades ?? []).filter((t) => t.status === 'settled' && Date.parse(t.ts) >= since)
      // Cluster by hourly event: strikes on the same close share one outcome.
      const ci = clusteredMean(rows.map((t) => ({ v: t.realizedPnlCents ?? 0, g: t.eventTicker ?? t.marketTicker ?? t.ts })))
      return { n: rows.length, netDollars: rows.reduce((a, t) => a + (t.realizedPnlCents ?? 0), 0) / 100, mean: ci.mean, se: ci.se, sd: ci.sd, clusters: ci.groups, unit: 'c', stake: 0.88 * notch }
    } catch {
      return null
    }
  }

  /** Kalshi trader strategies: per-contract net cents from the trader's own calibration ledger, as deltas since promotion. */
  private traderEvidence(s: LadderStrategy, key: string): StageEvidence {
    const st = this.autoTrader.getStatus()
    const p = st.perfByStrategy?.[key]
    const c = st.calib?.byStrategy?.[key] as unknown as CalibAccumulator | undefined
    const b = s.baseline ?? {}
    // A baseline captured before a calibration clear (v27, 2026-09-18) holds counts the accumulator no longer
    // has, so the delta clamps to zero and the arm can never reach a checkpoint (§127, M-04: fade 17,
    // volume-spike 23, sports-anchor 7 against post-clear counts of 19, 4, 0). Everything counted since the
    // clear belongs to the current stage: reset the baseline to zero once and say so.
    // The count test misses an arm whose accumulator has since overtaken its stale baseline (fade: 19 vs 17), so
    // a stage that began before the clear is re-baselined by date as well; a baseline recaptured after the
    // clear (any scale-up since) has since >= CALIB_CLEARED_AT and is left alone.
    if ((c?.netN ?? 0) < (b.netN ?? 0) || (s.since < CALIB_CLEARED_AT && (b.netN ?? 0) > 0)) {
      console.log(`[ladder] ${s.id}: baseline netN ${b.netN} predates the 2026-09-18 calibration clear (accumulator ${c?.netN ?? 0}); re-baselining to zero`)
      for (const k of Object.keys(b)) if (k === 'netN' || k === 'netSum' || k === 'netSq' || k === 'wN' || k === 'wSum' || k === 'wSq' || k === 'wTrades' || k.startsWith('dayN:') || k.startsWith('daySum:') || k.startsWith('dayW:') || k.startsWith('dayWSum:')) b[k] = 0
      s.baseline = b
    }
    const n = Math.max(0, (c?.netN ?? 0) - (b.netN ?? 0))
    // A checkpoint counter ahead of the evidence count is only possible when the evidence restarted under it (a
    // re-baseline, a clear, a hand re-base): the 20-trade band checks were being skipped until the count caught up
    // (audit B-19: fade, volume-spike and consensus were all in that state). Reset it.
    if ((s.lastCheckpoint ?? 0) > Math.floor(n / CHECKPOINT_TRADES)) {
      console.log(`[ladder] ${s.id}: checkpoint ${s.lastCheckpoint} is ahead of ${n} settled since the stage baseline; resetting to 0`)
      s.lastCheckpoint = 0
    }
    const w = weightedTraderStats(c, b, n)
    const sum = (c?.netSum ?? 0) - (b.netSum ?? 0)
    const sq = (c?.netSq ?? 0) - (b.netSq ?? 0)
    const mean = w ? w.mean : n > 0 ? sum / n : 0
    // Cluster by day since promotion when the per-day sums are available; else the plain SE.
    const groups = w ? w.groups : Object.entries(c?.byDay ?? {})
      .map(([day, g]) => ({ n: g.n - (b[`dayN:${day}`] ?? 0), sum: g.sum - (b[`daySum:${day}`] ?? 0) }))
      .filter((g) => g.n > 0)
    const se = w ? w.se : dayClusteredSe(groups, n, mean, sq)
    const sd = w ? w.sd : n > 1 ? Math.sqrt(Math.max(0, (sq - n * mean * mean) / (n - 1))) : undefined
    const clusters = w ? w.clusters : groups.length > 0 && groups.reduce((a, g) => a + g.n, 0) === n ? groups.length : undefined
    const stake = (this.autoTrader.getConfig().amountPerTrade ?? 0) * (s.notch ?? 1)
    // statsBand refuses whenever the sum of squares covers fewer observations than the sum (round 67), so a
    // half-accumulated series cannot produce a veto out of a band that was never computable.
    const mk = markoutBand(p, CONFIDENCE_Z)
    const missing = p?.markoutMissingN
    const adverse = mk
      ? { n: mk.n, mean: mk.mean, lo: mk.lo, hi: mk.hi, coverage: missing === undefined ? undefined : mk.n / (mk.n + missing) }
      : undefined
    // Sum every cohort this arm has ever traded under. Re-based evidence is renamed, never deleted, so the
    // `<key>:<label>` rows are the arm's own history: `consensus` + `consensus:pre-matcher-20260919`,
    // `sports-anchor` + `sports-anchor:pre-20260911-0105`. The stage ledger above is a delta and forgets them.
    const lifetimeDollars = this.lifetimeFor(s.id) ?? 0
    return { n, netDollars: (p?.realizedPnl ?? 0) - (b.realizedPnl ?? 0), lifetimeDollars, mean, se, sd, clusters, adverse, unit: 'c/contract', stake }
  }

  private microMakerEvidence(since: number): StageEvidence {
    const rows = this.miniRows('micro-maker', since)
    const ci = clusteredMean(rows)
    return { n: rows.length, netDollars: rows.reduce((a, r) => a + r.v, 0), mean: ci.mean, se: ci.se, sd: ci.sd, clusters: ci.groups, adverse: this.miniAdverse('micro-maker'), unit: '$', stake: 0.8 }
  }

  /** The 5-minute markout band for a Polymarket US arm, when it has enough of one to judge. */
  private miniAdverse(strategy: string): AdverseEvidence | undefined {
    const p = this.minis.get('polymarket-us')?.getStatus()?.perfByStrategy?.[strategy]
    if (!p) return undefined
    const b = markoutBand(p, CONFIDENCE_Z)
    const missing = p.markoutMissingN
    return b ? { n: b.n, mean: b.mean, lo: b.lo, hi: b.hi, coverage: missing === undefined ? undefined : b.n / (b.n + missing) } : undefined
  }

  /** Polymarket US signal strategies: per-trade P&L from the mini's research log (recordExit logs every close). */
  private miniEvidence(strategy: string, since: number, notch: number): StageEvidence {
    const rows = this.miniRows(strategy, since)
    const ci = clusteredMean(rows)
    const stake = ((this.minis.get('polymarket-us')?.getConfig().amountPerTrade ?? 1) as number) * notch
    return { n: rows.length, netDollars: rows.reduce((a, r) => a + r.v, 0), mean: ci.mean, se: ci.se, sd: ci.sd, clusters: ci.groups, adverse: this.miniAdverse(strategy), unit: '$', stake }
  }

  /** Lead-lag: the markets it swept since promotion, settled through the venue ledger. */
  private async leadLagEvidence(since: number, notch: number): Promise<StageEvidence | null> {
    const swept = new Set<string>()
    try {
      const p = join(this.userData, 'leadlag-dislocations.jsonl')
      if (existsSync(p)) {
        for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
          if (!line) continue
          try {
            const r = JSON.parse(line) as LeadLagRow
            if (leadLagRowCounts(r, since, this.autoTrader.getConfig().leadLagProvenCoins ?? LEADLAG_PROVEN_DEFAULT)) swept.add(r.kalshiTicker!)
          } catch {
            // skip bad line
          }
        }
      }
    } catch {
      return null
    }
    const stake = 0.5 * notch
    if (swept.size === 0) return { n: 0, netDollars: 0, mean: 0, se: 0, unit: '$', stake, signStopExempt: true, stopDollars: LEADLAG_STOP_DOLLARS }
    const pnl = await this.engine.getLivePnl('kalshi').catch(() => null)
    if (!pnl?.details) return null
    const rows = pnl.details.filter((d) => d.timestamp >= since && swept.has(d.marketId))
    const ci = clusteredMean(rows.map((r) => ({ v: r.realizedPnl, g: new Date(r.timestamp).toISOString().slice(0, 10) })))
    return { n: rows.length, netDollars: rows.reduce((a, r) => a + r.realizedPnl, 0), mean: ci.mean, se: ci.se, sd: ci.sd, clusters: ci.groups, unit: '$', stake, signStopExempt: true, stopDollars: LEADLAG_STOP_DOLLARS }
  }

  /** Closed trades of one mini strategy since `since`: value = P&L dollars, group = market. */
  private miniRows(strategy: string, since: number): { v: number; g: string }[] {
    try {
      const p = join(this.userData, 'mini-auto-polymarket-us.json-research.jsonl')
      if (!existsSync(p)) return []
      const out: { v: number; g: string }[] = []
      for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
        if (!line) continue
        try {
          const r = JSON.parse(line) as { type?: string; strategy?: string; ts?: string; pnl?: number; marketId?: string; mode?: string }
          // LIVE closes only. The mode switch is global, so a paper session's closes used to land in a live
          // arm's n, mean and netDollars with nothing to separate them (audit B-48). Rows written before the
          // mode field existed carry none and are skipped rather than guessed at: a stage that began before
          // this build re-baselines on its next capture, which costs evidence once instead of trusting it.
          if (r.type === 'closed' && r.mode === 'live' && r.strategy === strategy && typeof r.pnl === 'number' && Date.parse(r.ts ?? '') >= since) out.push({ v: r.pnl, g: r.marketId ?? r.ts ?? String(out.length) })
        } catch {
          // skip bad line
        }
      }
      return out
    } catch {
      return []
    }
  }

  async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const st = this.autoTrader.getStatus()
      const now = Date.now()

      // BTC convergence (shard 2 is funded, so it is first in line for trade-small)
      {
        const s = this.strategy('convergence')
        s.lastEval = now
        if (s.stage === 'tiny-live' || s.stage === 'live') {
          await this.judgeLive(s, this.convergenceEvidence(s.since, s.notch ?? 1))
        } else {
          const entry = this.tradeSmall(s)
          if (entry) {
            s.lastVerdict = entry.reason
            await this.apply(s, entry)
          } else {
            const g = await this.runGate<BtcGateJson>('btc-gate.mjs')
            const d = decideConvergence(s.stage, g ? { pass: g.pass, events: g.events, lb: g.lbBonferroni } : null)
            s.lastVerdict = d ? d.reason : this.gateOnly(s) + (g ? `shadow: gate ${g.pass ? 'PASS' : 'not yet'} (${g.events} events, corrected CI lower ${g.lbBonferroni === null ? 'n/a' : g.lbBonferroni.toFixed(2) + 'c'}; need 200 and > +1c)` : 'shadow: gate not evaluable')
            if (d) await this.apply(s, d)
          }
        }
      }
      // Weather quoter (shard 0)
      {
        const s = this.strategy('quoter')
        s.lastEval = now
        if (s.stage === 'tiny-live' || s.stage === 'live') {
          await this.judgeLive(s, await this.quoterEvidence(s.since, s.notch ?? 1))
          // Shard 0 is refilled from settlements only as they land; keep it at
          // the stage's working level every run (2026-09-07: it sat at $0.59
          // for a day because the top-up ran only at promotion and scale-up).
          if (s.stage === 'tiny-live' || s.stage === 'live') await this.fundShard0(SHARD0_MIN_DOLLARS * (s.notch ?? 1))
        } else {
          const entry = this.tradeSmall(s)
          if (entry) {
            s.lastVerdict = entry.reason
            await this.apply(s, entry)
          } else {
            const g = await this.runGate<QuoterGateJson>('quoter-shadow-gate.mjs')
            const gate = g?.allowed ? { n: g.allowed.n, events: g.allowed.events, mean: g.allowed.mean, lo: g.allowed.lo } : null
            const d = decideQuoter(s.stage, gate)
            s.lastVerdict = d ? d.reason : this.gateOnly(s) + (gate ? `shadow: allowed cohort ${gate.n} settled fills / ${gate.events} events, CI lower ${gate.lo.toFixed(2)}c (need ${QUOTER_GATE.minFills}/${QUOTER_GATE.minEvents}, lower > 0)` : 'shadow: no settled allowed-cohort fills yet')
            if (d) await this.apply(s, d)
          }
        }
      }
      // Spread deposits to the shards that trade (no-op below the weather cap).
      await this.balanceShards()
      // Settlement ratchet (paper; trades weather brackets on shard 0)
      {
        const s = this.strategy('settlement')
        s.lastEval = now
        if (s.stage === 'tiny-live' || s.stage === 'live') {
          await this.judgeLive(s, this.traderEvidence(s, 'settlement'))
        } else {
          const c = st.calib?.byStrategy?.['settlement'] as { netN?: number; netCiLo?: number; netCents?: number } | undefined
          const calib = c && c.netN !== undefined ? { netN: c.netN, netCiLo: c.netCiLo, netCents: c.netCents } : null
          const d = this.tradeSmall(s) ?? decideSettlement(s.stage, calib)
          s.lastVerdict = d ? d.reason : this.gateOnly(s) + (calib ? `paper: ${calib.netN} graded, CI lower ${calib.netCiLo === undefined ? 'n/a' : calib.netCiLo.toFixed(2) + 'c'} (need 40 and > 0)` : 'paper: no graded settlement trades yet')
          if (d) await this.apply(s, d)
        }
      }
      // Polymarket US micro-maker (live at one contract per market; checkpoints widen the market count)
      {
        const s = this.strategy('polyus-micro-maker')
        s.lastEval = now
        if (s.stage === 'live') {
          await this.judgeLive(s, this.microMakerEvidence(s.since))
        } else {
          const d = this.tradeSmall(s, 'live')
          s.lastVerdict = d ? d.reason : this.gateOnly(s) + `${s.stage}: waiting for the cool-down or the operator`
          if (d) await this.apply(s, d)
        }
      }
      // Signal strategies (Kalshi main trader + Polymarket US mini): same ladder, one flag + stake multiplier each
      for (const g of GENERIC_STRATEGIES) {
        const s = this.strategy(g.id)
        s.lastEval = now
        if (s.stage === 'tiny-live' || s.stage === 'live') {
          const notch = s.notch ?? 1
          const ev = g.venue === 'polymarket-us' ? this.miniEvidence(g.key, s.since, notch) : g.contracts ? await this.leadLagEvidence(s.since, notch) : this.traderEvidence(s, g.key)
          await this.judgeLive(s, ev)
        } else {
          const d = this.tradeSmall(s)
          s.lastVerdict = d ? d.reason : this.gateOnly(s) + `${s.stage}: waiting for the cool-down`
          if (d) await this.apply(s, d)
        }
      }
      this.state.lastRunAt = now
      this.note = Object.values(this.state.strategies).map((s) => `${s.id}=${s.stage}`).join(' ')
      this.log(`[ladder] ${this.note}`)
    } catch (e) {
      this.note = 'run failed: ' + (e instanceof Error ? e.message : String(e))
      this.log('[ladder] ' + this.note)
    } finally {
      this.persist()
      this.running = false
    }
  }
}
