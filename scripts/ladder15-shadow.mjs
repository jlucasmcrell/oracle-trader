// Shadow recorder for the 15-minute commodity ladder fade. RECORDS ONLY — it never places, amends or
// cancels an order, and it uses only Kalshi's PUBLIC market endpoint (no key, no auth).
//
// WHY THIS EXISTS
// ---------------
// The fade arm makes 88% of its money on short-dated quantitative ladders, and `fadeMinHorizonMinutes: 360`
// blinds it to everything closing inside six hours — which is every 15-minute ladder Kalshi runs. A 7-day
// backtest of the fade's own rule applied to KX{GOLD,SILVER,WTI,NATGAS,COPPER}15M, buying the expensive
// side at its displayed ASK three minutes before close and holding to settlement, returns +1.33c/contract
// over 923 observations with an 80% day-clustered band of [+1.00, +1.65] and a 96.6% win rate, at roughly
// 200 opportunities a day against the live fade's 13.
//
// The backtest cannot answer the only question that decides it: WOULD WE ACTUALLY GET THAT ASK? It reads a
// 1-minute candle's closing quote and assumes our size is there. Two of the five series carry the entire
// edge (natgas +3.51c, copper +3.52c; gold, silver and WTI are flat to negative) and those two are the
// THINNEST books — so the apparent edge is largest exactly where that assumption is weakest. That is also
// what a stale-quote artifact would look like.
//
// So this records, for every window, the live top of book at the decision moment and again at T-1, plus the
// depth available at the price we would have paid. Three trading days answers it for nothing.
//
//   node scripts/ladder15-shadow.mjs          # run forever (a scheduled task keeps it alive)
//   node scripts/ladder15-shadow.mjs --once   # one pass, for a smoke test
import fs from 'node:fs'
import path from 'node:path'
import { acquireRecorderLock } from './recorder-lock.mjs'

const REPO = 'G:/PROJECTS/oracle-trader'
const DIR = path.join(REPO, 'data/ladder15-shadow')
const OBS = path.join(DIR, 'observations.jsonl')
const HEARTBEAT = path.join(DIR, 'heartbeat.json')
const BASE = 'https://api.elections.kalshi.com/trade-api/v2'
const SERIES = ['KXGOLD15M', 'KXSILVER15M', 'KXWTI15M', 'KXNATGAS15M', 'KXCOPPER15M']

// The rule under test, identical to the backtested one.
const SNAP_AT = [180, 60] // seconds before close to snapshot: the decision moment, then one minute later
const ASK_LO = 0.89
const ASK_HI = 0.98
const MAX_SPREAD = 0.04
const WANT_CONTRACTS = 3 // depth we would need; recorded, never traded

const ONCE = process.argv.includes('--once')
const SCHEDULE_MS = 5 * 60_000
const TICK_MS = 10_000

fs.mkdirSync(DIR, { recursive: true })

/** Public GET with backoff. A 429 here would also hurt the live trader, which shares this endpoint. */
async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'oracle-ladder15-shadow/1.0' }, signal: AbortSignal.timeout(20_000) })
      if (r.status === 429) {
        await sleep(4000 * (i + 1))
        continue
      }
      if (!r.ok) return null
      return await r.json()
    } catch {
      await sleep(1500 * (i + 1))
    }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const iso = (ms) => new Date(ms).toISOString()

/** Everything we have seen this process life: ticker -> { closeTs, series, snaps, graded } */
const tracked = new Map()
let lastSchedule = 0
let written = 0
// Snapshot outcomes, so the heartbeat can report HEALTH and not merely liveness. A run that is taking
// snapshots but finding none of them quoted is the exact signature of the 2026-09-12 field-name bug, which
// hid behind a fresh heartbeat and `written: 0` for the recorder's entire life.
let snapsQuoted = 0
let snapsUnquoted = 0
let graded = 0

/** Refresh upcoming closes AND harvest results for windows that have settled. One request per series. */
async function refreshSchedule() {
  const now = Date.now()
  const sec = (ms) => Math.floor(ms / 1000)
  for (const s of SERIES) {
    // Two bounded requests rather than one unbounded page: a single `limit=100` mixes settled windows in
    // with upcoming ones, and once a series carries more than 100 rows the upcoming ones can fall off the
    // end entirely. Ask for exactly the two ranges that matter.
    const upcoming = await get(`${BASE}/markets?limit=100&series_ticker=${encodeURIComponent(s)}&min_close_ts=${sec(now)}&max_close_ts=${sec(now + 48 * 3600_000)}`)
    await sleep(300)
    const recent = await get(`${BASE}/markets?limit=100&series_ticker=${encodeURIComponent(s)}&min_close_ts=${sec(now - 3 * 3600_000)}&max_close_ts=${sec(now)}`)
    for (const m of [...(upcoming?.markets ?? []), ...(recent?.markets ?? [])]) {
      const ct = m.close_time ? Date.parse(m.close_time) : NaN
      if (!Number.isFinite(ct)) continue
      const rec = tracked.get(m.ticker) ?? { ticker: m.ticker, series: s, closeTs: ct, snaps: {}, graded: false }
      rec.closeTs = ct
      // The venue's own result is the grade. Anything but an explicit yes/no means keep waiting.
      const result = typeof m.result === 'string' ? m.result.toLowerCase() : ''
      if (!rec.graded && (result === 'yes' || result === 'no') && Object.keys(rec.snaps).length > 0) {
        rec.graded = true
        rec.result = result
        emit(rec)
      }
      tracked.set(m.ticker, rec)
    }
    await sleep(400)
  }
  // Forget windows that closed over three hours ago and never graded - the venue will not revisit them.
  for (const [k, v] of tracked) if (now - v.closeTs > 3 * 3600_000) tracked.delete(k)
  lastSchedule = now
}

/**
 * Top-of-book plus the depth behind it, from the public market row.
 *
 * 2026-09-12: this read `m.yes_bid` / `m.yes_ask` as integer cents. Those fields DO NOT EXIST in Kalshi's
 * public payload — `typeof m.yes_bid` is `undefined`, verified with a live GET on both KXGOLD15M and
 * KXBTC15M. The `typeof === 'number'` test therefore always failed, `readQuote` always returned undefined,
 * every snapshot recorded `quoted: false`, and `emit()` returned early on `if (!entry?.quoted)`. The
 * recorder produced a healthy heartbeat and ZERO observations for its entire life: `written: 0` and no
 * `observations.jsonl` on disk at all.
 *
 * The weekend stand-down note in the heartbeat made that look expected. It was not: the bug is independent
 * of the stand-down and would have recorded nothing on a busy weekday too. A heartbeat that reports liveness
 * without reporting output is a liveness check, not a health check.
 *
 * The live fields are `*_dollars` STRINGS (e.g. "0.5300"), and `volume`/`open_interest`/`liquidity` are
 * likewise `volume_fp` / `open_interest_fp` / `liquidity_dollars`.
 */
const dollars = (v) => {
  if (v === null || v === undefined) return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}
function readQuote(m) {
  const yb = dollars(m.yes_bid_dollars)
  const ya = dollars(m.yes_ask_dollars)
  if (yb === undefined || ya === undefined || yb <= 0 || ya <= 0) return undefined
  return {
    yesBid: yb,
    yesAsk: ya,
    spread: ya - yb,
    volume: dollars(m.volume_fp) ?? 0,
    openInterest: dollars(m.open_interest_fp) ?? 0,
    liquidity: dollars(m.liquidity_dollars) ?? 0
  }
}

/** The decision the live rule would make from this quote. Recorded; never acted on. */
function decide(q) {
  const mid = (q.yesBid + q.yesAsk) / 2
  const side = mid >= 0.5 ? 'yes' : 'no'
  // Buying NO means lifting the NO ask, which is 1 - yes_bid.
  const ask = side === 'yes' ? q.yesAsk : 1 - q.yesBid
  const qualifies = q.spread <= MAX_SPREAD && ask >= ASK_LO && ask <= ASK_HI
  return { side, ask: Math.round(ask * 10000) / 10000, spreadCents: Math.round(q.spread * 1000) / 10, qualifies }
}

async function snapshotDue() {
  const now = Date.now()
  const due = []
  for (const rec of tracked.values()) {
    if (rec.graded) continue
    const left = (rec.closeTs - now) / 1000
    for (const at of SNAP_AT) {
      // A 10s tick against a 15s window: each snapshot point fires at most once per market.
      if (rec.snaps[at] === undefined && left <= at + 7 && left > at - 8) due.push({ rec, at })
    }
  }
  for (const { rec, at } of due) {
    const j = await get(`${BASE}/markets/${encodeURIComponent(rec.ticker)}`)
    const m = j?.market
    if (!m) continue
    const q = readQuote(m)
    if (!q) {
      snapsUnquoted++
      rec.snaps[at] = { at: iso(Date.now()), quoted: false }
      continue
    }
    snapsQuoted++
    rec.snaps[at] = { at: iso(Date.now()), quoted: true, secondsToClose: Math.round((rec.closeTs - Date.now()) / 1000), ...q, decision: decide(q) }
    await sleep(300)
  }
}

/** One observation per window, written when the venue grades it. */
function emit(rec) {
  const entry = rec.snaps[SNAP_AT[0]]
  if (!entry?.quoted) return
  const later = rec.snaps[SNAP_AT[1]]
  const d = entry.decision
  const win = rec.result === d.side
  // Fee is Kalshi's exact quadratic, NOT rounded up to a cent: 93 one-contract fills in our own billing
  // paid $1.3074 against $1.3036 for the formula and $1.7300 for a whole-cent ceiling.
  const fee = 0.07 * d.ask * (1 - d.ask)
  const netCents = ((win ? 1 - d.ask : -d.ask) - fee) * 100
  const row = {
    ts: iso(Date.now()),
    ticker: rec.ticker,
    series: rec.series,
    closeTs: iso(rec.closeTs),
    result: rec.result,
    qualifies: d.qualifies,
    side: d.side,
    ask: d.ask,
    spreadCents: d.spreadCents,
    win,
    netCents: Math.round(netCents * 100) / 100,
    volumeAtEntry: entry.volume,
    liquidityAtEntry: entry.liquidity,
    openInterestAtEntry: entry.openInterest,
    wantContracts: WANT_CONTRACTS,
    // The question the backtest could not answer: was the price we aimed at still there a minute later?
    askAtT1: later?.quoted ? later.decision.ask : null,
    askDriftCents: later?.quoted ? Math.round((later.decision.ask - d.ask) * 1000) / 10 : null,
    spreadCentsAtT1: later?.quoted ? later.decision.spreadCents : null,
    quotedAtT1: later ? later.quoted : null
  }
  fs.appendFileSync(OBS, JSON.stringify(row) + '\n')
  written++
  if (row.qualifies) graded++
}

function heartbeat(note) {
  // Every snapshot coming back unquoted is not a quiet market, it is a broken reader. Say so in the file the
  // operator actually looks at, rather than leaving a healthy-looking heartbeat over an empty ledger.
  const snaps = snapsQuoted + snapsUnquoted
  const health = snaps >= 30 && snapsQuoted === 0 ? `BROKEN: ${snaps} snapshots taken, NONE quoted - check the venue field names in readQuote()` : 'ok'
  fs.writeFileSync(
    HEARTBEAT,
    JSON.stringify(
      { at: iso(Date.now()), tracked: tracked.size, written, qualifying: graded, snapsQuoted, snapsUnquoted, health, note },
      null,
      1
    )
  )
}

async function main() {
  if (!acquireRecorderLock(process.argv[1], DIR)) return
  console.log(`[ladder15] shadow recorder starting — RECORDS ONLY, no orders, public endpoint only`)
  for (;;) {
    try {
      if (Date.now() - lastSchedule > SCHEDULE_MS) await refreshSchedule()
      await snapshotDue()
      const pending = [...tracked.values()].filter((r) => !r.graded && r.closeTs > Date.now())
      const next = pending.length ? Math.min(...pending.map((r) => r.closeTs)) : 0
      const hrs = next ? (next - Date.now()) / 3600_000 : 0
      heartbeat(
        pending.length === 0
          ? 'no upcoming 15M windows at all'
          : hrs > 1
            ? `${pending.length} pending; next closes in ${hrs.toFixed(1)}h (the commodity ladders stand down at weekends)`
            : `${pending.length} pending; next closes in ${(hrs * 60).toFixed(0)} min`
      )
    } catch (e) {
      heartbeat(`error: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (ONCE) {
      console.log(`[ladder15] one pass: ${tracked.size} tracked, ${written} observations written`)
      return
    }
    await sleep(TICK_MS)
  }
}

await main()
