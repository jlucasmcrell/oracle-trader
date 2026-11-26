/**
 * Lead-lag streak sizer (src/main/strategies/leadLagStreak.ts): windows, not gaps, move the level; three in a row
 * double or halve it inside 1..4; weekends trade at the level and weekdays at half; a persisted state survives a
 * corrupt file. Pure functions, no network.
 */
import assert from 'node:assert/strict'
import {
  dropStale, dueWindows, gradeWindow, loadStreakState, newStreakState, observeGap, streakContracts,
  STREAK_GIVE_UP_MS, STREAK_SETTLE_DELAY_MS, windowNetCents
} from '../../src/main/strategies/leadLagStreak'
import { LEADLAG_MAX_QUOTE_AGE_MS, streakCountsGap } from '../../src/main/strategies/leadLag'

let passed = 0
const test = (name: string, fn: () => void): void => { fn(); passed++; console.log(`ok - ${name}`) }

const W = 900_000
const T0 = Date.parse('2026-11-22T12:00:00Z')
const gap = (i: number, coin: string, side: 'yes' | 'no', cost = 0.4) => ({ ticker: `KX${coin}15M-W${i}`, side, cost, coin, close: T0 + i * W })
/** Feed window i with one gap and settle it as a win or a loss. */
function settle(s: ReturnType<typeof newStreakState>, i: number, win: boolean) {
  observeGap(s, gap(i, 'BTC', 'yes'))
  return gradeWindow(s, T0 + i * W, new Map([[`KXBTC15M-W${i}`, win ? 'yes' : 'no']]))
}

test('first sighting per ticker and side only', () => {
  const s = newStreakState()
  assert.equal(observeGap(s, gap(0, 'BTC', 'yes')), true)
  assert.equal(observeGap(s, gap(0, 'BTC', 'yes', 0.5)), false)
  assert.equal(observeGap(s, gap(0, 'BTC', 'no')), true)
  assert.equal(s.pending.length, 2)
})

test('a window is netted into one result, fee included', () => {
  const s = newStreakState()
  observeGap(s, gap(0, 'BTC', 'yes', 0.4))
  observeGap(s, { ...gap(0, 'ETH', 'no', 0.4), ticker: 'KXETH15M-W0' })
  // BTC wins (+60 - fee), ETH loses (-40 - fee): net about +20 - 2 fees > 0
  const net = windowNetCents(s.pending, new Map([['KXBTC15M-W0', 'yes'], ['KXETH15M-W0', 'yes']]))
  assert.ok(net !== null && net > 15 && net < 20, `net ${net}`)
  const r = gradeWindow(s, T0, new Map([['KXBTC15M-W0', 'yes'], ['KXETH15M-W0', 'yes']]))
  assert.equal(r.graded, true)
  assert.equal(r.window?.win, true)
  assert.equal(r.window?.gaps, 2)
  assert.equal(s.pending.length, 0)
})

test('an unsettled gap holds the whole window', () => {
  const s = newStreakState()
  observeGap(s, gap(0, 'BTC', 'yes'))
  observeGap(s, { ...gap(0, 'SOL', 'yes'), ticker: 'KXSOL15M-W0' })
  const r = gradeWindow(s, T0, new Map([['KXBTC15M-W0', 'yes']]))
  assert.equal(r.graded, false)
  assert.equal(s.pending.length, 2)
  assert.equal(s.winRun, 0)
})

test('three wins in a row double, capped at 4', () => {
  const s = newStreakState(2)
  assert.equal(settle(s, 0, true).change, undefined)
  assert.equal(settle(s, 1, true).change, undefined)
  assert.deepEqual(settle(s, 2, true).change?.to, 4)
  assert.equal(s.level, 4)
  for (let i = 3; i < 6; i++) settle(s, i, true)
  assert.equal(s.level, 4, 'never above 4')
})

test('three losses in a row halve, floored at 1', () => {
  const s = newStreakState(2)
  settle(s, 0, false); settle(s, 1, false)
  assert.equal(settle(s, 2, false).change?.to, 1)
  for (let i = 3; i < 6; i++) settle(s, i, false)
  assert.equal(s.level, 1, 'never below 1')
})

test('a loss breaks a win run and vice versa', () => {
  const s = newStreakState(2)
  settle(s, 0, true); settle(s, 1, true); settle(s, 2, false); settle(s, 3, true); settle(s, 4, true)
  assert.equal(s.level, 2)
  assert.equal(s.winRun, 2)
  assert.equal(s.lossRun, 0)
})

test('a graded window takes no late gaps', () => {
  const s = newStreakState()
  settle(s, 0, true)
  assert.equal(observeGap(s, gap(0, 'BTC', 'no')), false)
})

test('due only after the settle delay, oldest first', () => {
  const s = newStreakState()
  observeGap(s, gap(1, 'BTC', 'yes')); observeGap(s, gap(0, 'BTC', 'yes'))
  assert.deepEqual(dueWindows(s, T0 + STREAK_SETTLE_DELAY_MS - 1), [])
  assert.deepEqual(dueWindows(s, T0 + W), [T0])
  assert.deepEqual(dueWindows(s, T0 + W + STREAK_SETTLE_DELAY_MS), [T0, T0 + W])
})

test('stale windows are dropped, not counted', () => {
  const s = newStreakState()
  observeGap(s, gap(0, 'BTC', 'yes'))
  assert.deepEqual(dropStale(s, T0 + STREAK_GIVE_UP_MS), [T0])
  assert.equal(s.pending.length, 0)
  assert.equal(s.winRun + s.lossRun, 0)
})

test('weekends trade at the level, weekdays at half, within the caps', () => {
  assert.equal(streakContracts(1, true, {}), 1)
  assert.equal(streakContracts(2, true, {}), 2)
  assert.equal(streakContracts(4, true, {}), 4)
  assert.equal(streakContracts(1, false, {}), 1)
  assert.equal(streakContracts(2, false, {}), 1)
  assert.equal(streakContracts(4, false, {}), 2)
  assert.equal(streakContracts(4, true, { leadLagStreakWeekendMax: 3 }), 3)
  assert.equal(streakContracts(4, false, { leadLagStreakWeekdayMax: 1 }), 1)
})

test('custom run length', () => {
  const s = newStreakState(2)
  observeGap(s, gap(0, 'BTC', 'yes'))
  assert.equal(gradeWindow(s, T0, new Map([['KXBTC15M-W0', 'yes']]), 1).change?.to, 4)
})

test('a corrupt or missing persisted state starts fresh at x2', () => {
  assert.deepEqual(loadStreakState(undefined).level, 2)
  assert.deepEqual(loadStreakState({ level: 3 }).level, 2)
  const s = loadStreakState({ level: 4, winRun: 1, lossRun: -2, pending: [{ key: 'a|yes', ticker: 'a', side: 'yes', cost: 0.4, coin: 'BTC', close: T0 }, { bad: true }], recent: [] })
  assert.equal(s.level, 4)
  assert.equal(s.lossRun, 0)
  assert.equal(s.pending.length, 1)
})

test('only gaps the sweep would take are graded', () => {
  const cfg = {
    leadLagStreakSizing: true, leadLagProvenCoins: ['BTC', 'ETH', 'SOL'], leadLagMaxDislocationCents: 12,
    leadLagNoTradeCoins: ['ETH', 'XRP'], leadLagWeekendNoTradeCoins: ['XRP']
  }
  const now = T0
  const g = (over: Partial<{ underlying: string; dislocationCents: number; clearsFees: boolean; polyAt: number }> = {}) =>
    ({ kalshiTicker: 'KXBTC15M-W0', underlying: 'BTC', dislocationCents: 7, clearsFees: true, polyAt: now - 100, ...over })
  assert.equal(streakCountsGap(g(), cfg, false, now), true, 'a plain BTC gap counts')
  assert.equal(streakCountsGap(g({ dislocationCents: 16.5 }), cfg, false, now), false, 'at or above the 12c cap: not traded, not graded')
  assert.equal(streakCountsGap(g({ dislocationCents: 11.9 }), cfg, false, now), true)
  assert.equal(streakCountsGap(g({ underlying: 'ETH' }), cfg, false, now), false, 'weekday ETH is recorded, not traded')
  assert.equal(streakCountsGap(g({ underlying: 'ETH' }), cfg, true, now), true, 'weekend ETH is traded')
  assert.equal(streakCountsGap(g({ underlying: 'XRP' }), cfg, true, now), false, 'unproven coin')
  assert.equal(streakCountsGap(g({ clearsFees: false }), cfg, false, now), false)
  assert.equal(streakCountsGap(g({ polyAt: now - LEADLAG_MAX_QUOTE_AGE_MS - 1 }), cfg, false, now), false, 'stale quote is skipped by the sweep')
  assert.equal(streakCountsGap(g(), { ...cfg, leadLagStreakSizing: false }, false, now), false, 'sizer off')
})

console.log(`\n${passed} passed`)
