/**
 * Grades the momentum CANDIDATE recorder (src/main/strategies/momentumCandidates.ts, round 90): the flat 3c
 * bar the live arm uses against log-odds bars, on the same recorded windows, priced at the executable side
 * ask with taker fees and settled from Kalshi's PUBLIC market endpoint. GET-only; never places anything.
 *
 * The question it is built to answer (REVIEW-CHANGES §76, backlog 67): a log-odds bar at the at-the-money
 * unit (0.12) is a strict superset of the flat bar, so the only way it can change the arm's P&L is through
 * the windows the flat bar REJECTED. Those are the "logit-only" population below, and this prints what they
 * would have earned, fee-inclusive, day-clustered - before anything is ever traded on them.
 *
 * Decision unit. The recorder writes a row per (ticker, slot) and re-records growth; this keeps the largest
 * |move| per (ticker, slot), then - because the live arm trades at most one momentum entry per event per
 * day - takes the FIRST qualifying slot per (event, UTC day) for each bar. Both bars get the same treatment.
 *
 * Confirmation rules (traded volume in >= 3 candles, direction held at mid-window) are applied identically
 * under every bar: the only thing varied is the move measure. That is the hypothesis, isolated.
 *
 *   node scripts/momentum-candidates-gate.mjs --interim   health only: rows, priceable, settled. No P&L.
 *   node scripts/momentum-candidates-gate.mjs --verdict   refuses before READ_AT; then the full comparison.
 *   node scripts/momentum-candidates-gate.mjs --selftest  synthetic rows through the pure functions.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DIR = process.env.MOMENTUM_CANDIDATES_DIR ?? join(process.env.APPDATA ?? '', 'oracle-trader', 'momentum-candidates')
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2'
const CACHE = join(DIR, 'settled-cache.json')

/** Pre-registered read date: seven full UTC days after the recorder went live (2026-09-13). */
export const READ_AT = '2026-09-21T00:00:00Z'
export const MIN_N_FOR_VERDICT = 100
export const MIN_DAYS_FOR_VERDICT = 5
/** Log-odds bars to compare. 0.12 is the at-the-money unit of the flat 3c bar (the strict superset). */
export const LOGIT_BARS = [0.12, 0.2, 0.3, 0.4, 0.6]
export const MIN_VOL_CANDLES = 3
/** 80% band, as the ladder's checkpoints use. */
const Z = 1.28
const MAX_FETCH_PER_RUN = 600
const FETCH_PACE_MS = 125

// ---- pure functions (self-tested) ----

/** Kalshi taker fee in whole cents per contract: ceil(0.07 × P × (1−P) × 100). Verbatim from leadLag.ts. */
export function takerFeeCents(p) {
  return Math.ceil(7 * p * (1 - p) - 1e-9)
}

/** Largest |movePoints| per (ticker, slot): the recorder's growth re-records collapse to one decision. */
export function dedupeSlots(rows) {
  const best = new Map()
  for (const r of rows) {
    const k = `${r.ticker}|${r.slot}`
    const prev = best.get(k)
    if (prev === undefined || Math.abs(r.movePoints) > Math.abs(prev.movePoints)) best.set(k, r)
  }
  return [...best.values()].sort((a, b) => a.ts - b.ts)
}

/** The live arm's confirmations, applied under every bar. */
export function confirmed(r) {
  return r.volCandles >= MIN_VOL_CANDLES && r.midHeld === true
}

export function passesFlat(r) {
  return confirmed(r) && Math.abs(r.movePoints) >= r.thrPoints
}

export function passesLogit(r, bar) {
  return confirmed(r) && typeof r.moveLogit === 'number' && Math.abs(r.moveLogit) >= bar
}

/** Executable side price at record time, or undefined when the book side is missing. */
export function sidePrice(r) {
  if (r.side === 'YES') return typeof r.ya === 'number' && r.ya > 0 && r.ya < 1 ? r.ya : undefined
  return typeof r.yb === 'number' && r.yb > 0 && r.yb < 1 ? 1 - r.yb : undefined
}

/** Net cents per contract at the side ask, taker fee included, given the market result ('yes'|'no'). */
export function netCents(r, result) {
  const p = sidePrice(r)
  if (p === undefined) return undefined
  const won = (result === 'yes') === (r.side === 'YES')
  const fee = takerFeeCents(p)
  // Integer cents: prices are cent-granular, and 100 * (1 - 0.99) in floating point is a hair above 1, which
  // turned an exactly fee-eaten win into a "win" by a femto-cent.
  const pc = Math.round(p * 100)
  return (won ? 100 - pc : -pc) - fee
}

export function dayOf(r) {
  return new Date(r.ts).toISOString().slice(0, 10)
}

/**
 * First qualifying slot per (event, UTC day) under `pass`, mirroring the arm's one-per-event-per-day cap,
 * skipping windows the arm could not have traded: an event already carrying another position (recorded raw
 * as `eventExposed`), a ticker already entered today, or one exited within the hour. `priorEntriesToday`
 * counts entries by ANY strategy - the trader's churn map is shared, and the live guard reads it the same
 * way - so excluding on it is the arm's own block, not a stricter one.
 */
export function tradeable(r) {
  if (r.eventExposed === true) return false
  if ((r.priorEntriesToday ?? 0) >= 1) return false
  if (typeof r.minutesSinceExit === 'number' && r.minutesSinceExit < 60) return false
  return true
}

export function decisions(rows, pass) {
  const taken = new Set()
  const out = []
  for (const r of rows) {
    if (!pass(r) || !tradeable(r)) continue
    const k = `${r.event ?? r.ticker}|${dayOf(r)}`
    if (taken.has(k)) continue
    taken.add(k)
    out.push(r)
  }
  return out
}

/**
 * Verbatim port of clusteredMean from src/main/ladder/ladder.ts, INCLUDING the G/(G-1) finite-cluster
 * correction and the floor-at-plain-SE guard under three clusters (a one-cluster band of -2.93..-2.93
 * stopped a strategy on no evidence on 2026-09-07). Do not re-derive.
 */
export function clusteredMean(rows) {
  const n = rows.length
  if (n === 0) return { n: 0, groups: 0, mean: 0, se: 0, sd: 0 }
  const mean = rows.reduce((a, r) => a + r.v, 0) / n
  const by = new Map()
  for (const r of rows) {
    const g = by.get(r.g) ?? { n: 0, sum: 0 }
    g.n++
    g.sum += r.v
    by.set(r.g, g)
  }
  const groups = [...by.values()]
  const G = groups.length
  const correction = G > 1 ? Math.sqrt(G / (G - 1)) : 1
  const clustered = (Math.sqrt(groups.reduce((a, x) => a + (x.sum - x.n * mean) ** 2, 0)) / n) * correction
  const plain = n > 1 ? Math.sqrt(rows.reduce((a, r) => a + (r.v - mean) ** 2, 0) / (n - 1) / n) : 0
  const sd = n > 1 ? Math.sqrt(rows.reduce((a, r) => a + (r.v - mean) ** 2, 0) / (n - 1)) : 0
  return { n, groups: G, mean, se: G < 3 ? Math.max(clustered, plain) : clustered, sd }
}

export function band(values) {
  const c = clusteredMean(values)
  return { ...c, lo: c.mean - Z * c.se, hi: c.mean + Z * c.se }
}

/** A band without width is not an interval; say so instead of printing one. */
export const fmtBand = (b) => (b.n < 2 || !(b.se > 0) ? `n=${b.n} - no width, not an interval` : `[${b.lo.toFixed(2)}, ${b.hi.toFixed(2)}]`)

/** Settled, priceable decisions -> {n, wins, losses, flat, band, unpriced, unsettled}. */
export function score(decs, results) {
  const vals = []
  let wins = 0
  let losses = 0
  // A win the fee ate exactly (YES at 99c: +1c - 1c fee): neither a win nor a loss, and it stays in the band.
  let flat = 0
  let unpriced = 0
  let unsettled = 0
  for (const r of decs) {
    const res = results.get(r.ticker)
    if (res !== 'yes' && res !== 'no') {
      unsettled++
      continue
    }
    const v = netCents(r, res)
    if (v === undefined) {
      unpriced++
      continue
    }
    if (v > 0) wins++
    else if (v < 0) losses++
    else flat++
    vals.push({ v, g: dayOf(r) })
  }
  return { n: vals.length, wins, losses, flat, band: band(vals), unpriced, unsettled }
}

// ---- I/O ----

function loadRows() {
  if (!existsSync(DIR)) return { rows: [], files: [] }
  const files = readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
  const rows = []
  let bad = 0
  for (const f of files) {
    for (const line of readFileSync(join(DIR, f), 'utf8').split(/\r?\n/)) {
      if (!line) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        bad++
      }
    }
  }
  if (bad > 0) console.log(`skipped ${bad} unparseable line(s)`)
  return { rows, files }
}

function loadCache() {
  try {
    return existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}
  } catch {
    return {}
  }
}

async function settle(ticker, cache) {
  const c = cache[ticker]
  if (c && typeof c === 'object' && c.blankAt !== undefined) {
    if (Date.now() - c.blankAt < 24 * 3600_000) return { res: null, fetched: false }
  } else if (c !== undefined) return { res: c, fetched: false }
  try {
    const r = await fetch(`${KALSHI}/markets/${encodeURIComponent(ticker)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
    if (!r.ok) return { res: undefined, fetched: true }
    const j = await r.json()
    const st = j.market?.status
    const res = j.market?.result
    if (st !== 'settled' && st !== 'finalized') return { res: undefined, fetched: true }
    if (res === 'yes' || res === 'no') cache[ticker] = res
    else cache[ticker] = { blankAt: Date.now() }
    return { res: res === 'yes' || res === 'no' ? res : null, fetched: true }
  } catch {
    return { res: undefined, fetched: true }
  }
}

function printHealth(rows, files) {
  const byDay = new Map()
  for (const r of rows) {
    const d = dayOf(r)
    const b = byDay.get(d) ?? { rows: 0, tickers: new Set(), priceable: 0, flat: 0 }
    b.rows++
    b.tickers.add(r.ticker)
    if (sidePrice(r) !== undefined) b.priceable++
    if (passesFlat(r)) b.flat++
    byDay.set(d, b)
  }
  console.log(`files ${files.length}; rows ${rows.length}`)
  console.log('day         rows  tickers  priceable  flat-bar rows')
  for (const [d, b] of [...byDay.entries()].sort()) console.log(`${d}  ${String(b.rows).padStart(5)}  ${String(b.tickers.size).padStart(7)}  ${String(b.priceable).padStart(9)}  ${String(b.flat).padStart(13)}`)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) return selftest()
  const { rows, files } = loadRows()
  if (rows.length === 0) {
    console.log(`no rows under ${DIR} yet - the recorder writes one row per moved window per scan`)
    process.exit(4)
  }
  printHealth(rows, files)
  if (argv.includes('--interim')) {
    console.log('\n--interim reads no P&L. The verdict is pre-registered for', READ_AT)
    return
  }
  if (!argv.includes('--verdict')) {
    console.log('\npass --interim for health or --verdict for the comparison (refused before the read date)')
    return
  }
  if (Date.now() < Date.parse(READ_AT)) {
    console.log(`\nREFUSED: the read date is ${READ_AT}; reading earlier is how a streak gets mistaken for a result`)
    process.exit(2)
  }
  const decs = dedupeSlots(rows)
  const cache = loadCache()
  const results = new Map()
  const tickers = [...new Set(decs.filter((r) => passesFlat(r) || passesLogit(r, LOGIT_BARS[0])).map((r) => r.ticker))]
  let fetched = 0
  let unresolved = 0
  for (const t of tickers) {
    if (fetched >= MAX_FETCH_PER_RUN && cache[t] === undefined) {
      unresolved++
      continue
    }
    const { res, fetched: f } = await settle(t, cache)
    if (f) {
      fetched++
      await new Promise((r) => setTimeout(r, FETCH_PACE_MS))
    }
    if (res === 'yes' || res === 'no') results.set(t, res)
  }
  writeFileSync(CACHE, JSON.stringify(cache))
  console.log(`\nsettlement: ${tickers.length} tickers in play, ${results.size} resolved, ${fetched} fetched this run, ${unresolved} deferred to the next run by the ${MAX_FETCH_PER_RUN}/run budget`)

  const capped = decs.filter((r) => passesFlat(r) && !tradeable(r)).length
  console.log(`capacity: ${capped} flat-bar windows fall to the arm's own caps (event exposed, entered today, exited within the hour) and are not decisions`)
  const flat = decisions(decs, passesFlat)
  const flatScore = score(flat, results)
  const days = new Set(flat.filter((r) => results.has(r.ticker)).map(dayOf)).size
  console.log(`\nFLAT ${flat[0]?.thrPoints ?? 3}c bar (the live arm's rule): decisions ${flat.length}, settled+priced ${flatScore.n}, W/L ${flatScore.wins}/${flatScore.losses}, mean ${flatScore.band.mean.toFixed(2)}c/contract, 80% band ${fmtBand(flatScore.band)}, ${flatScore.unpriced} unpriced, ${flatScore.unsettled} unsettled, ${days} settlement days`)
  const flatKeys = new Set(flat.map((r) => `${r.ticker}|${r.slot}`))
  for (const bar of LOGIT_BARS) {
    const all = decisions(decs, (r) => passesLogit(r, bar))
    const only = all.filter((r) => !flatKeys.has(`${r.ticker}|${r.slot}`))
    const s = score(all, results)
    const so = score(only, results)
    console.log(`LOGIT >= ${bar.toFixed(2)}: decisions ${all.length}, settled+priced ${s.n}, W/L ${s.wins}/${s.losses}, mean ${s.band.mean.toFixed(2)}c, band ${fmtBand(s.band)} | logit-only (rejected by the flat bar): ${only.length} decisions, settled ${so.n}, W/L ${so.wins}/${so.losses}, mean ${so.band.mean.toFixed(2)}c, band ${fmtBand(so.band)}`)
  }
  if (flatScore.n < MIN_N_FOR_VERDICT || days < MIN_DAYS_FOR_VERDICT) {
    console.log(`\nINCONCLUSIVE: ${flatScore.n} settled flat-bar decisions over ${days} days; a verdict needs ${MIN_N_FOR_VERDICT} and ${MIN_DAYS_FOR_VERDICT}`)
    process.exit(4)
  }
  console.log('\nRead the logit-only bands. A lower bound above zero there is the only thing that would make a log-odds bar worth a shadow test; anything else is the flat bar with more trades.')
}

function selftest() {
  let pass = 0
  let fail = 0
  const eq = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++
    else {
      fail++
      console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
    }
  }
  const row = (o) => ({ ts: Date.parse('2026-09-14T10:00:00Z'), ticker: 'T1', event: 'E1', slot: 1, windowMin: 10, candles: 10, volCandles: 3, from: 0.5, to: 0.53, movePoints: 3, moveLogit: 0.12, midHeld: true, thrPoints: 3, side: 'YES', yb: 0.52, ya: 0.54, ...o })
  eq('fee: 2c at 50c', takerFeeCents(0.5), 2)
  eq('fee: 93c side', takerFeeCents(0.93), 1)
  eq('fee: 0.2c rounds up to a cent', takerFeeCents(0.03), 1)
  eq('dedupe: largest move per ticker-slot survives', dedupeSlots([row({ movePoints: 3 }), row({ movePoints: 4.5 }), row({ movePoints: 2, slot: 2 })]).map((r) => [r.slot, r.movePoints]), [[1, 4.5], [2, 2]])
  // Re-review round 90c: decisions() relies on dedupeSlots returning rows in time order; feed them reversed.
  const t0 = Date.parse('2026-09-14T10:00:00Z')
  eq('dedupe: output is in time order whatever the input order', dedupeSlots([row({ slot: 3, ts: t0 + 1200_000 }), row({ slot: 1, ts: t0 }), row({ slot: 2, ts: t0 + 600_000 })]).map((r) => r.slot), [1, 2, 3])
  eq('decisions: the earliest slot wins even when offered last', decisions(dedupeSlots([row({ slot: 3, ts: t0 + 1200_000, movePoints: 5 }), row({ slot: 1, ts: t0, movePoints: 3 })]), passesFlat).map((r) => r.slot), [1])
  eq('flat: 3c with confirmations passes', passesFlat(row()), true)
  eq('flat: 2.9c fails', passesFlat(row({ movePoints: 2.9 })), false)
  eq('flat: two traded candles fails', passesFlat(row({ volCandles: 2 })), false)
  eq('flat: mid not held fails', passesFlat(row({ midHeld: false })), false)
  eq('logit: a 1c tick at 97c (0.35) clears 0.30 while the flat bar rejects it', [passesLogit(row({ movePoints: 1, moveLogit: 0.35 }), 0.3), passesFlat(row({ movePoints: 1, moveLogit: 0.35 }))], [true, false])
  eq('logit: missing field never passes', passesLogit(row({ moveLogit: undefined }), 0.12), false)
  eq('side price: YES buys the ask', sidePrice(row()), 0.54)
  eq('side price: NO buys 1 - bid', sidePrice(row({ side: 'NO' })), 0.48)
  eq('side price: no book is unpriced', sidePrice(row({ ya: undefined })), undefined)
  eq('net: YES at 54c wins 46 - 2 fee', netCents(row(), 'yes'), 44)
  eq('net: YES at 54c loses 54 + 2 fee', netCents(row(), 'no'), -56)
  eq('net: NO at 48c wins 52 - 2', netCents(row({ side: 'NO' }), 'no'), 50)
  eq('decisions: first qualifying slot per event-day only', decisions([row({ slot: 1 }), row({ slot: 2 }), row({ slot: 3, event: 'E2' }), row({ slot: 150, ts: Date.parse('2026-09-15T10:00:00Z') })], passesFlat).map((r) => r.slot), [1, 3, 150])
  eq('decisions: ticker stands in for a missing event', decisions([row({ event: undefined }), row({ event: undefined, ticker: 'T2' })], passesFlat).length, 2)
  eq('tradeable: the arm\'s caps are applied from the raw facts', [tradeable(row()), tradeable(row({ eventExposed: true })), tradeable(row({ priorEntriesToday: 1 })), tradeable(row({ minutesSinceExit: 59 })), tradeable(row({ minutesSinceExit: 60 }))], [true, false, false, false, true])
  eq('decisions: a capped window is not a decision', decisions([row({ eventExposed: true }), row({ slot: 2 })], passesFlat).map((r) => r.slot), [2])
  const s = score([row(), row({ ticker: 'T2', event: 'E2' }), row({ ticker: 'T3', event: 'E3', ya: undefined }), row({ ticker: 'T4', event: 'E4' })], new Map([['T1', 'yes'], ['T2', 'no'], ['T3', 'yes']]))
  eq('score: counts wins, losses, unpriced and unsettled exactly', [s.n, s.wins, s.losses, s.unpriced, s.unsettled], [2, 1, 1, 1, 1])
  const s0 = score([row({ ya: 0.99 })], new Map([['T1', 'yes']]))
  eq('score: a win the fee ate exactly is flat, not a loss', [s0.n, s0.wins, s0.losses, s0.flat], [1, 0, 0, 1])
  eq('band: one cluster of identical values is no interval', fmtBand(band([{ v: 3, g: 'd' }, { v: 3, g: 'd' }])), 'n=2 - no width, not an interval')
  const b = band([{ v: 10, g: 'a' }, { v: -10, g: 'b' }, { v: 4, g: 'c' }, { v: -4, g: 'd' }])
  eq('band: four clusters give a real width around zero', [b.n, b.groups, b.se > 0, b.lo < 0 && b.hi > 0], [4, 4, true, true])
  console.log(`momentum-candidates-gate selftest: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
