// Shadow recorder for MOMENTUM on Kalshi's 15-minute crypto ladders. RECORDS ONLY — it never places, amends
// or cancels an order, never reads a credential, and uses only Kalshi's PUBLIC endpoints (no key, no auth).
//
// WHY THIS EXISTS
// ---------------
// `minMinutesToClose: 15` (autoTrader.ts buildUniverse) excludes every market closing inside 15 minutes.
// Kalshi lists exactly one open window per 15-minute series at a time, so a 15-minute contract can only
// clear that floor in the first seconds of its life: the whole KX{BTC,ETH,XRP,SOL,DOGE,BNB}15M family is
// STRUCTURALLY invisible to every arm that runs off buildUniverse — not thinned, excluded.
//
// leadLag bypasses buildUniverse and fetches these series directly, and it is the only arm at ladder stage
// `live`: all 200 15M-family fills in history.json are its. That proves the venue is tradeable and that this
// account can win there. It does NOT prove momentum would. Nobody has ever measured it, because a market the
// universe never emits leaves no trace — no candidate, no veto row, nothing.
//
// This leaves a trace, for nothing, on ~576 windows a day.
//
// SCOPE — momentum ONLY, and this is deliberate
// ---------------------------------------------
//   momentum        IN.  Blocked by minMinutesToClose alone. Its own gates (>=5 candles, >=3 traded
//                        candles, 3c point move, direction held at mid-window) are all satisfiable in the
//                        back half of a 15-minute window.
//   mean-reversion  OUT. `meanReversionMinHoursToClose` is 6h; max hoursToClose here is 0.25h. Null for the
//                        market's entire life. That is a strategy-defining horizon, not a liquidity floor —
//                        15-minute mean-reversion is a different strategy, not this one turned down.
//   fade            OUT. `fadeMinHorizonMinutes` likewise makes it structurally null, AND the fade-on-15m
//                        question already has its own instrument in scripts/ladder15-shadow.mjs. Two
//                        instruments on one question confuse two different decisions.
//
// Recording `signal: null` columns for arms that CANNOT fire would manufacture a null that reads as
// "no edge" when it is really "no signal". The row shape is nonetheless rule-agnostic (raw candles, raw
// quotes, settlement), so a separately-justified 15-minute variant can be graded off the same file later
// without re-collecting — cullRecorder's doctrine: the recorder observes, the grader judges.
//
// HONEST PRIOR, STATED BEFORE COLLECTION
// --------------------------------------
// A 15-minute at-the-money binary's probability path is close to a martingale, and the 3c threshold is
// trivially cleared here (a sampled window travelled 0.52 -> 0.82 -> 0.76 in 13 minutes). Expect a high
// signal rate and an expected value near minus the spread and fee. The most likely pre-registered outcome
// is FLOOR STAYS. That is worth buying at this price, and §7 of docs makes a decisive negative actionable.
//
//   node scripts/crypto15-shadow.mjs            # run forever (Startup entry keeps it alive)
//   node scripts/crypto15-shadow.mjs --once     # one cycle, smoke test
//   node scripts/crypto15-shadow.mjs --selftest # assert the momentum port against a captured real window
import fs from 'node:fs'
import path from 'node:path'
import { acquireRecorderLock } from './recorder-lock.mjs'

const REPO = 'G:/PROJECTS/oracle-trader'
const DIR = path.join(REPO, 'data/crypto15-shadow')
const HEARTBEAT = path.join(DIR, 'heartbeat.json')
const SKIPPED = path.join(DIR, 'skipped.jsonl')
const BASE = 'https://api.elections.kalshi.com/trade-api/v2'
const SERIES = ['KXBTC15M', 'KXETH15M', 'KXXRP15M', 'KXSOL15M', 'KXDOGE15M', 'KXBNB15M']
const REV = 'crypto15-shadow/1.0'

// Momentum's live parameters. Mirrors of the deployed config; the port below must match autoTrader.ts.
const MOMENTUM_WINDOW_MIN = 10
const MOMENTUM_MIN_MOVE = 0.03
const AMOUNT_PER_TRADE = 5

// Snapshot offsets in seconds before close. T-180 is THE decision point and the only one that enters the
// primary sample; 300 and 60 are exploratory columns (entry timing, quote drift) and never enter `n`.
const SNAP_AT = [300, 180, 60]
const DECISION_AT = 180
const CANDLE_AT = new Set([300, 180])

const REQ_GAP_MS = 300
const TICK_MS = 5000
const ONCE = process.argv.includes('--once')
const SELFTEST = process.argv.includes('--selftest')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const iso = (ms) => new Date(ms).toISOString()
const numOrUndef = (v) => {
  if (v === null || v === undefined) return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * PORTED FROM: src/main/strategies/autoTrader.ts momentumSignals (the `private momentumSignals` method).
 * A hand port into .mjs WILL drift from the TypeScript silently, so `--selftest` asserts it against a real
 * window captured from the venue. Any port that cannot reproduce that is not measuring the deployed engine,
 * and its nulls are not the engine's nulls.
 *
 * `candles` are the same shape KalshiAdapter.getCandles produces: {endTs, close, bidClose, askClose, volume}.
 */
const midOf = (a, b) => (a !== undefined && b !== undefined ? (a + b) / 2 : a !== undefined ? a : b)
export function replayMomentum(allCandles, nowSec) {
  const windowSec = MOMENTUM_WINDOW_MIN * 60
  const cutoff = nowSec - windowSec
  const candles = allCandles.filter((c) => c.endTs >= cutoff)
  if (candles.length < Math.max(2, Math.floor(MOMENTUM_WINDOW_MIN / 2))) return { signal: false, vetoReason: 'candles', candleCount: candles.length }
  const priceAt = (c) => c.close ?? midOf(c.bidClose, c.askClose)
  const newest = priceAt(candles[candles.length - 1])
  const oldest = priceAt(candles[0])
  if (newest === undefined || oldest === undefined) return { signal: false, vetoReason: 'price', candleCount: candles.length }
  // Point move, not relative — mirrors the engine's comment and its arithmetic.
  const move = newest - oldest
  if (Math.abs(move) < MOMENTUM_MIN_MOVE) return { signal: false, vetoReason: 'move', candleCount: candles.length, movePoints: +(move * 100).toFixed(2) }
  const volCandleCount = candles.filter((c) => (c.volume ?? 0) > 0).length
  if (volCandleCount < 3) return { signal: false, vetoReason: 'volume', candleCount: candles.length, volCandleCount }
  const mid = priceAt(candles[Math.floor(candles.length / 2)])
  if (mid === undefined || (move > 0 ? mid <= oldest : mid >= oldest)) return { signal: false, vetoReason: 'hold', candleCount: candles.length, volCandleCount }
  const side = move > 0 ? 'YES' : 'NO'
  return {
    signal: true,
    side,
    movePoints: +(move * 100).toFixed(2),
    // RECORDED, NEVER ACTED ON. The engine's threshold is a flat 3c point move at every price, but a 3c move
    // is not the same amount of information everywhere: in log-odds, 0.95->0.98 is 7.9x the move that
    // 0.50->0.53 is, and 0.045->0.075 is 4.5x. So the flat bar is most permissive at the money and most
    // restrictive in the tails, and momentum's signal population is biased toward mid-priced markets by
    // construction. (It also explains the engine's own comment rejecting RELATIVE moves as noise at low
    // prices: relative is wrong, but logit is the middle ground that comment was reaching for - a 4.5c->5c
    // tick is 0.111 in log-odds, near-identical to 3c at the money.)
    // This column costs nothing and lets that hypothesis be tested later on data already being collected.
    // It deliberately does NOT gate anything: momentum is mid-re-test under a pre-registered rule, and
    // changing its threshold now would contaminate it.
    moveLogit: +(Math.log(newest / (1 - newest)) - Math.log(oldest / (1 - oldest))).toFixed(4),
    priceFrom: +oldest.toFixed(2),
    priceTo: +newest.toFixed(2),
    candleCount: candles.length,
    volCandleCount,
    newestCandleEndTs: candles[candles.length - 1].endTs,
    score: Math.min(100, Math.round(50 + (Math.abs(move) / MOMENTUM_MIN_MOVE) * 30)),
    confidence: Math.min(1, Math.abs(move) / (2 * MOMENTUM_MIN_MOVE))
  }
}

// ---- selftest: the real window captured 2026-09-12, whose settlement is known ----
if (SELFTEST) {
  const prices = [0.52, 0.53, 0.56, 0.58, 0.6, 0.65, 0.71, 0.77, 0.76, 0.82, 0.74, 0.71, 0.76]
  const base = 1789222320
  const candles = prices.map((p, i) => ({ endTs: base - (prices.length - 1 - i) * 60, close: p, volume: 100 }))
  const r = replayMomentum(candles, base)
  // movePoints is +20, not the +18 you get by eyeballing the series: the 10-minute cutoff drops the two
  // OLDEST of the thirteen 1-minute candles, so the window's oldest price is 0.56 (index 2), not 0.58.
  // 0.76 - 0.56 = 0.20. Asserted rather than printed, because this arithmetic is the whole signal — an
  // off-by-one in the cutoff would shift every movePoints in the study and still look plausible.
  const want = { signal: true, side: 'YES', candleCount: 11, volCandleCount: 11, movePoints: 20, priceFrom: 0.56, priceTo: 0.76 }
  let bad = 0
  for (const [k, v] of Object.entries(want)) {
    const ok = r[k] === v
    if (!ok) bad++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k}: got ${JSON.stringify(r[k])} want ${JSON.stringify(v)}`)
  }
  // Negative controls: the port must also decline for the engine's stated reasons.
  const flat = Array.from({ length: 11 }, (_, i) => ({ endTs: base - (10 - i) * 60, close: 0.5, volume: 100 }))
  const noVol = prices.slice(2).map((p, i) => ({ endTs: base - (10 - i) * 60, close: p, volume: 0 }))
  const short = flat.slice(0, 4)
  for (const [name, cs, reason] of [['flat series vetoes on move', flat, 'move'], ['untraded candles veto on volume', noVol, 'volume'], ['too few candles veto', short, 'candles']]) {
    const g = replayMomentum(cs, base)
    const ok = g.signal === false && g.vetoReason === reason
    if (!ok) bad++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}: signal=${g.signal} reason=${g.vetoReason} want reason=${reason}`)
  }
  console.log(`\nselftest: ${bad === 0 ? 'PASSED' : bad + ' FAILED'}`)
  process.exit(bad === 0 ? 0 : 1)
}

fs.mkdirSync(DIR, { recursive: true })

const obsPath = () => path.join(DIR, `observations-${new Date().toISOString().slice(0, 7)}.jsonl`)

/** ticker -> { series, closeTs, snaps, emitted } */
const tracked = new Map()
const emitted = new Set()
let written = 0
let signalled = 0
let snapsQuoted = 0
let snapsUnquoted = 0
let dropped = 0
// Windows that had ALREADY settled when this process started. They never had a T-180 snapshot and never
// could have — counting them as drops would poison the pre-registered "settlement drop rate < 2%" sample
// bar, and would do it afresh on every restart. A drop only means something if we were watching.
let preexisting = 0
const startedAt = Date.now()
let throttleStreak = 0
let cooldownUntil = 0
let lastPollSlot = -1

/**
 * Restart-safe dedup. cullRecorder deliberately avoids an on-disk cache because one silently starved the
 * hunch collector — that hazard does not apply here: the key is a ticker that can settle exactly once, so
 * re-reading it can only ever prevent a double-write, never suppress a new observation.
 */
function seedEmitted() {
  const now = new Date()
  for (const d of [now, new Date(now.getFullYear(), now.getMonth() - 1, 1)]) {
    const p = path.join(DIR, `observations-${d.toISOString().slice(0, 7)}.jsonl`)
    try {
      if (!fs.existsSync(p)) continue
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          emitted.add(JSON.parse(line).ticker)
        } catch {
          /* torn line */
        }
      }
    } catch {
      /* unreadable month */
    }
  }
}

function note(reason, extra) {
  try {
    fs.appendFileSync(SKIPPED, JSON.stringify({ ts: iso(Date.now()), reason, ...extra }) + '\n')
  } catch {
    /* best effort */
  }
}

/**
 * Public GET. The 429 policy is the OPPOSITE of ladder15-shadow's retry-with-backoff, on purpose: a shadow
 * recorder has nothing time-critical to protect and the live trader shares this venue-side budget. On a 429
 * we abandon the cycle and back off; a missed snapshot is a lost window out of 576 a day, which is free.
 * Competing with live trading for the rate budget is not.
 */
let cycleThrottled = false
async function get(url) {
  if (cycleThrottled) return null
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'oracle-crypto15-shadow/1.0', accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
    if (r.status === 429 || r.status >= 500) {
      cycleThrottled = true
      note('throttled', { url: url.slice(0, 120), status: r.status })
      return null
    }
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

/** Window discovery AND settlement harvest in one call per series. */
async function poll() {
  const now = Date.now()
  const sec = Math.floor(now / 1000)
  for (const s of SERIES) {
    const j = await get(`${BASE}/markets?limit=100&series_ticker=${encodeURIComponent(s)}&min_close_ts=${sec - 3600}&max_close_ts=${sec + 1800}`)
    if (cycleThrottled) return
    for (const m of j?.markets ?? []) {
      const ct = m.close_time ? Date.parse(m.close_time) : NaN
      if (!Number.isFinite(ct)) continue
      const rec = tracked.get(m.ticker) ?? { ticker: m.ticker, series: s, closeTs: ct, snaps: {} }
      rec.closeTs = ct
      const result = typeof m.result === 'string' ? m.result.toLowerCase() : ''
      if ((result === 'yes' || result === 'no') && !emitted.has(m.ticker)) {
        rec.result = result
        emit(rec)
      }
      tracked.set(m.ticker, rec)
    }
    await sleep(REQ_GAP_MS)
  }
  // Ninety minutes past close the venue is not going to publish anything new.
  for (const [k, v] of tracked) if (now - v.closeTs > 90 * 60_000) tracked.delete(k)
}

async function snapshot() {
  const now = Date.now()
  const due = []
  for (const rec of tracked.values()) {
    if (emitted.has(rec.ticker)) continue
    const left = (rec.closeTs - now) / 1000
    for (const at of SNAP_AT) if (rec.snaps[at] === undefined && left <= at + 5 && left > at - 5) due.push({ rec, at })
  }
  if (due.length === 0) return
  // Candles are batched across every ticker due at this offset: one request for six markets, not six.
  const wantCandles = due.filter((d) => CANDLE_AT.has(d.at))
  let candlesBy = {}
  if (wantCandles.length > 0) {
    const nowSec = Math.floor(now / 1000)
    const tickers = [...new Set(wantCandles.map((d) => d.ticker ?? d.rec.ticker))]
    const j = await get(
      `${BASE}/markets/candlesticks?market_tickers=${encodeURIComponent(tickers.join(','))}&start_ts=${nowSec - 900}&end_ts=${nowSec}&period_interval=1`
    )
    for (const m of j?.markets ?? []) {
      if (!m.market_ticker) continue
      candlesBy[m.market_ticker] = (m.candlesticks ?? []).map((c) => ({
        endTs: c.end_period_ts ?? 0,
        close: numOrUndef((c.price ?? {}).close_dollars),
        bidClose: numOrUndef((c.yes_bid ?? {}).close_dollars),
        askClose: numOrUndef((c.yes_ask ?? {}).close_dollars),
        volume: numOrUndef(c.volume_fp) ?? 0
      }))
    }
    await sleep(REQ_GAP_MS)
    if (cycleThrottled) return
  }
  for (const { rec, at } of due) {
    const j = await get(`${BASE}/markets/${encodeURIComponent(rec.ticker)}`)
    if (cycleThrottled) return
    const m = j?.market
    if (!m) continue
    const yb = numOrUndef(m.yes_bid_dollars)
    const ya = numOrUndef(m.yes_ask_dollars)
    if (yb === undefined || ya === undefined || !(yb > 0) || !(ya > 0)) {
      snapsUnquoted++
      rec.snaps[at] = { quoted: false }
      await sleep(REQ_GAP_MS)
      continue
    }
    snapsQuoted++
    const snap = {
      quoted: true,
      at: iso(Date.now()),
      secondsToClose: Math.round((rec.closeTs - Date.now()) / 1000),
      yesBid: yb,
      yesAsk: ya,
      spreadCents: +((ya - yb) * 100).toFixed(1),
      yesBidSizeFp: numOrUndef(m.yes_bid_size_fp) ?? 0,
      yesAskSizeFp: numOrUndef(m.yes_ask_size_fp) ?? 0,
      volumeFp: numOrUndef(m.volume_fp) ?? 0,
      openInterestFp: numOrUndef(m.open_interest_fp) ?? 0
    }
    if (CANDLE_AT.has(at)) snap.momentum = replayMomentum(candlesBy[rec.ticker] ?? [], Math.floor(Date.now() / 1000))
    rec.snaps[at] = snap
    await sleep(REQ_GAP_MS)
  }
}

/** Kalshi taker fee, the exact quadratic. The engine also bills a whole-cent ceiling; both are recorded. */
const feeCents = (p) => 100 * 0.07 * p * (1 - p)

/** One row per window, at the moment the venue publishes a result. */
function emit(rec) {
  if (emitted.has(rec.ticker)) return
  const d = rec.snaps[DECISION_AT]
  if (!d || !d.quoted || !d.momentum) {
    emitted.add(rec.ticker)
    // Was its decision moment before we existed? Then this is not a miss, it is history.
    if (rec.closeTs - DECISION_AT * 1000 < startedAt) {
      preexisting++
      note('pre-existing-window', { ticker: rec.ticker, closeTs: iso(rec.closeTs) })
    } else {
      dropped++
      note('no-decision-snapshot', { ticker: rec.ticker, haveSnaps: Object.keys(rec.snaps) })
    }
    return
  }
  const mo = d.momentum
  const closeIso = iso(rec.closeTs)
  const row = {
    ts: iso(Date.now()),
    ticker: rec.ticker,
    series: rec.series,
    coin: rec.series.replace(/^KX|15M$/g, ''),
    closeTs: closeIso,
    // PRIMARY cluster key. 96 windows/day x 6 series is not 576 independent observations: the six coins
    // close together and move with BTC beta, and consecutive windows are serially correlated. The effective
    // sample accrues at ONE per day.
    day: closeIso.slice(0, 10),
    windowKey: closeIso,
    result: rec.result,
    ...mo,
    secondsToClose: d.secondsToClose,
    yesBid: d.yesBid,
    yesAsk: d.yesAsk,
    spreadCents: d.spreadCents,
    volumeFp: d.volumeFp,
    openInterestFp: d.openInterestFp,
    rev: REV
  }
  if (mo.signal) {
    const entryAsk = mo.side === 'YES' ? d.yesAsk : 1 - d.yesBid
    const win = mo.side === 'YES' ? rec.result === 'yes' : rec.result === 'no'
    const f = feeCents(entryAsk)
    row.entryAsk = +entryAsk.toFixed(4)
    row.entrySizeFp = mo.side === 'YES' ? d.yesAskSizeFp : d.yesBidSizeFp
    row.wantContracts = Math.max(1, Math.floor(AMOUNT_PER_TRADE / Math.max(0.01, entryAsk)))
    row.win = win
    row.feeCents = +f.toFixed(2)
    row.feeCentsCeil = Math.ceil(f)
    row.netCents = +(((win ? 1 - entryAsk : -entryAsk) * 100) - f).toFixed(2)
    // The mirror pays the spread in ITS OWN direction: this is deliberately not -netCents, and anyone
    // reasoning about it from a sign flip is wrong by roughly the full spread.
    const mAsk = mo.side === 'YES' ? 1 - d.yesBid : d.yesAsk
    const mWin = !win
    const mf = feeCents(mAsk)
    row.mirrorEntryAsk = +mAsk.toFixed(4)
    row.mirrorNetCents = +(((mWin ? 1 - mAsk : -mAsk) * 100) - mf).toFixed(2)
    signalled++
  }
  const s60 = rec.snaps[60]
  if (s60?.quoted) {
    row.quotedAt60 = true
    row.askAt60 = mo.side === 'NO' ? +(1 - s60.yesBid).toFixed(4) : s60.yesAsk
    row.spreadCentsAt60 = s60.spreadCents
    if (row.entryAsk !== undefined) row.askDriftCents = +((row.askAt60 - row.entryAsk) * 100).toFixed(1)
  }
  const s300 = rec.snaps[300]
  if (s300?.quoted) row.askAt300 = mo.side === 'NO' ? +(1 - s300.yesBid).toFixed(4) : s300.yesAsk
  try {
    fs.appendFileSync(obsPath(), JSON.stringify(row) + '\n')
    emitted.add(rec.ticker)
    written++
  } catch {
    /* retried on the next poll, since `emitted` is only set on success */
  }
}

function heartbeat(extra) {
  // Health, not just liveness. ladder15-shadow reported a fresh heartbeat and `written: 0` for its entire
  // life while a dead field name made every quote unreadable; the operator had no way to see it.
  const snaps = snapsQuoted + snapsUnquoted
  const health =
    snaps >= 10 && snapsQuoted === 0
      ? 'BROKEN: snapshots taken but NONE quoted - check venue field names'
      : written >= 20 && signalled === 0
        ? 'SUSPECT: rows written but momentum never fired - check the port with --selftest'
        : 'ok'
  try {
    fs.writeFileSync(
      HEARTBEAT,
      JSON.stringify(
        {
          at: iso(Date.now()),
          tracked: tracked.size,
          written,
          signalled,
          snapsQuoted,
          snapsUnquoted,
          dropped,
          preexisting,
          dropRate: written + dropped > 0 ? +(dropped / (written + dropped)).toFixed(4) : 0,
          cooldownUntil: cooldownUntil ? iso(cooldownUntil) : null,
          health,
          ...extra
        },
        null,
        1
      )
    )
  } catch {
    /* best effort */
  }
}

async function cycle() {
  cycleThrottled = false
  const now = Date.now()
  if (now < cooldownUntil) return
  // Window boundaries are deterministic at :00/:15/:30/:45, so poll shortly after each one rather than
  // every minute — 15x cheaper for zero information loss.
  const slot = Math.floor(now / (15 * 60_000))
  const intoSlot = now - slot * 15 * 60_000
  if (slot !== lastPollSlot && intoSlot > 45_000) {
    await poll()
    // Stamped AFTER, and only on a clean poll. Stamping first meant a 429 on series 2 of 6 silently dropped
    // series 3-6 for the entire window - no discovery, no snapshots, no rows, no error.
    if (!cycleThrottled) lastPollSlot = slot
  }
  if (!cycleThrottled) await snapshot()
  if (cycleThrottled) {
    throttleStreak++
    if (throttleStreak >= 2) {
      const mins = Math.min(15, 2 ** (throttleStreak - 2))
      cooldownUntil = Date.now() + mins * 60_000
      note('cooldown', { minutes: mins, streak: throttleStreak })
    }
  } else {
    throttleStreak = 0
  }
}

async function main() {
  if (!acquireRecorderLock(process.argv[1], DIR)) return
  seedEmitted()
  console.log(`[crypto15] start; ${emitted.size} tickers already recorded; series ${SERIES.join(' ')}`)
  if (ONCE) {
    lastPollSlot = -1
    await poll()
    await snapshot()
    heartbeat({ note: 'one cycle' })
    console.log(`[crypto15] one cycle: ${tracked.size} tracked, ${written} written, ${signalled} signalled`)
    return
  }
  for (;;) {
    try {
      await cycle()
      const next = [...tracked.values()].filter((r) => r.closeTs > Date.now()).sort((a, b) => a.closeTs - b.closeTs)[0]
      heartbeat({ note: next ? `next close in ${Math.round((next.closeTs - Date.now()) / 1000)}s (${next.ticker})` : 'no open window tracked' })
    } catch (e) {
      heartbeat({ note: `error: ${e instanceof Error ? e.message : String(e)}` })
    }
    await sleep(TICK_MS)
  }
}

main()
