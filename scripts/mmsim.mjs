// Zero-money market-making simulator for Kalshi. RECORDS ONLY - it never places, amends or cancels an
// order, never loads a credential, and uses only PUBLIC unauthenticated endpoints.
//
// WHAT QUESTION THIS ANSWERS, AND WHAT IT CANNOT
// ----------------------------------------------
// This is a FALSIFICATION test, not a discovery test, and the framing is forced by three numbers:
//
//  1. The live book cannot hold enough risk for a positive answer to matter. `quoterMaxExposure` is $4 and
//     `quoterMaxInventory` is 1, so the real book rests 1-contract clips over a handful of markets. Even a
//     large +1c/fill edge at 30 fills/day is ~$0.30/day. The only decision a PASS informs is whether to
//     raise that cap by 50-100x - it is not income at this size.
//  2. The resolvable dead zone is wider than the plausible edge. At ~20 day-clusters with a between-day SD
//     of day-mean net around 2c, SE is about 0.45c. Any true per-fill edge between roughly -0.1c and +1.1c
//     is unresolvable inside 35 days, and that band contains most realistic outcomes for a 2-3c book.
//  3. THE PRIOR IS ALREADY NEGATIVE, FROM THIS ACCOUNT'S OWN MONEY. The weather quoter took **653 maker
//     fills, 896 contracts, at -2.6c each** (docs/REVIEW-CHANGES-2026-09-06.md, the 2026-09-06 review
//     table), attributed to adverse selection. That ran on a FORECAST-based fair value - strictly better
//     information than the midpoint+/-1c rule simulated here. Naive spread capture should do worse.
//
// So the strongest claim this can support is "not refuted". A PASS authorises a small live confirmation
// run, never a scale-up. A KILL is the outcome with real power, and a clean non-peekable kill costs $0.
//
//   node scripts/mmsim.mjs             # run until the pre-registered stop date
//   node scripts/mmsim.mjs --once      # one cycle, smoke test
//   node scripts/mmsim.mjs --selftest  # assert the fill model against hand-built cases
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { acquireRecorderLock } from './recorder-lock.mjs'

const BASE = 'https://api.elections.kalshi.com/trade-api/v2'
const DIR = path.join(process.env.APPDATA ?? '.', 'oracle-trader', 'mmsim')
const LIVE_DIR = path.join(process.env.APPDATA ?? '.', 'oracle-trader')

// ---- pre-registered parameters. Changing ANY of these mints a new runId and restarts the clock. ----
const P = {
  runDays: 35,
  trackedMarkets: 8,
  cycleMs: 60_000,
  universeMs: 10 * 60_000,
  reqGapMs: 300,
  // 24, not 20: 16 baseline + 3 universe + due markouts oversubscribed 20 exactly when fills clustered, and
  // the markouts were the ones dropped. Still ~2% of the venue's ~1,200/min ceiling and a separate client
  // from the live trader's 120/min window.
  maxReqPerMin: 24,
  // selection
  minSpreadC: 2,
  maxSpreadC: 12,
  minTouchSize: 10,
  maxTouchSize: 60,
  minYes: 0.1,
  maxYes: 0.9,
  minPrints60m: 3,
  minMinutesToClose: 90,
  minMinutesSinceOpen: 20,
  // quoting
  maxInv: 20,
  amendMoveC: 3,
  cancelMinutesToClose: 60,
  // fee
  makerCoef: 0.0175,
  // gate
  minFills: 400,
  minDayClusters: 20,
  minCoverage: 0.8,
  minMarkoutCoverage: 0.8,
  passLowerC: 0.75,
  killUpperC: 0.25,
  markoutMin: [5, 15]
}

const ONCE = process.argv.includes('--once')
const SELFTEST = process.argv.includes('--selftest')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const iso = (ms) => new Date(ms).toISOString()
const num = (v) => {
  if (v === null || v === undefined) return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}
const cents = (d) => Math.round(d * 100)

/**
 * THE FILL MODEL. Bias direction: CONSERVATIVE, deliberately.
 *
 * A quote holds {price, side, queueAhead}. Aggressive prints at or through our price consume the queue
 * ahead of us, and we fill only once that queue is STRICTLY exhausted (`queueAhead < 0`, not `<= 0`).
 *
 * Conservative on purpose, in three places:
 *  - JOIN (we rest at an existing level): queueAhead = the whole displayed size. No credit for any of it
 *    being stale. IMPROVE (we create a new level inside the touch): queueAhead = 0, and size arriving at
 *    our price afterwards is NEVER added back - those joiners are behind us in time priority.
 *  - Cancellations ahead of us are invisible in a public print feed and are NOT credited. Real fills caused
 *    by someone ahead pulling are therefore missed. This is the single largest conservative lever.
 *  - The fill test uses the PRICE, not `taker_side`. This repo has not verified which of taker_side /
 *    taker_book_side / taker_outcome_side means what, and building the primary metric on an unverified
 *    field is how a study measures its own misreading. `taker_side` agreement is logged as a cross-check.
 *
 * The one place it must NOT be conservative is book-cross fills: if the market traded clean through our
 * resting price between snapshots, we WERE filled, and those are exactly the adverse ones. Excluding them
 * would quietly delete the losses and make the whole study optimistic.
 */
export function consumeQueue(quote, prints) {
  let q = quote.queueAhead
  for (const t of prints) {
    if (t.block) continue
    // A print from before this quote existed cannot have hit it. Without this, a failed prints() fetch
    // leaves lastTradeTs stale, the next fetch re-includes pre-placement prints, and they consume a queue
    // that was not there yet - a fill manufactured from ordering, not from the market.
    if (quote.placedAt !== undefined && t.ts < quote.placedAt) continue
    const hits = quote.side === 'bid' ? t.yesPrice <= quote.yesPrice + 1e-9 : t.yesPrice >= quote.yesPrice - 1e-9
    if (!hits) continue
    q -= t.size
    if (q < 0) return { filled: true, at: t.ts, tradeId: t.tradeId, source: 'print', queueLeft: q }
  }
  return { filled: false, queueLeft: q }
}

/** Kalshi maker fee in cents for a clip of `n` contracts, billed on the order total and rounded UP. */
export const makerFeeCents = (yesPrice, n) => Math.ceil(P.makerCoef * n * yesPrice * (1 - yesPrice) * 100) / n

if (SELFTEST) {
  let bad = 0
  const ok = (name, got, want) => {
    const good = JSON.stringify(got) === JSON.stringify(want)
    if (!good) bad++
    console.log(`  ${good ? 'ok  ' : 'FAIL'} ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
  }
  const pr = (yesPrice, size, block = false, ts = 1, tradeId = 't') => ({ yesPrice, size, block, ts, tradeId })
  // JOIN: 40 ahead. 39 of aggressive volume is NOT enough; the queue must be strictly exceeded.
  ok('join: 39 against 40 ahead does not fill', consumeQueue({ side: 'bid', yesPrice: 0.5, queueAhead: 40 }, [pr(0.5, 39)]).filled, false)
  ok('join: 41 against 40 ahead fills', consumeQueue({ side: 'bid', yesPrice: 0.5, queueAhead: 40 }, [pr(0.5, 41)]).filled, true)
  ok('join: exactly 40 does NOT fill (strict)', consumeQueue({ side: 'bid', yesPrice: 0.5, queueAhead: 40 }, [pr(0.5, 40)]).filled, false)
  // IMPROVE: front of queue, any aggressive print fills us.
  ok('improve: any size fills', consumeQueue({ side: 'bid', yesPrice: 0.5, queueAhead: 0 }, [pr(0.5, 1)]).filled, true)
  // Price test, both sides.
  ok('bid not hit by a print above it', consumeQueue({ side: 'bid', yesPrice: 0.5, queueAhead: 0 }, [pr(0.51, 99)]).filled, false)
  ok('bid hit by a print below it', consumeQueue({ side: 'bid', yesPrice: 0.5, queueAhead: 0 }, [pr(0.49, 1)]).filled, true)
  ok('ask not hit by a print below it', consumeQueue({ side: 'ask', yesPrice: 0.5, queueAhead: 0 }, [pr(0.49, 99)]).filled, false)
  ok('ask hit by a print above it', consumeQueue({ side: 'ask', yesPrice: 0.5, queueAhead: 0 }, [pr(0.51, 1)]).filled, true)
  // Block trades never touch the continuous book.
  ok('block trades are ignored', consumeQueue({ side: 'bid', yesPrice: 0.5, queueAhead: 0 }, [pr(0.5, 999, true)]).filled, false)
  // H5: a print from BEFORE the quote existed cannot fill it, however aggressive.
  ok('pre-placement print cannot fill', consumeQueue({ side: 'bid', yesPrice: 0.5, queueAhead: 0, placedAt: 1000 }, [pr(0.5, 999, false, 999)]).filled, false)
  ok('post-placement print does fill', consumeQueue({ side: 'bid', yesPrice: 0.5, queueAhead: 0, placedAt: 1000 }, [pr(0.5, 1, false, 1001)]).filled, true)
  // H4: the loss-lock must never fire on a plain two-sided quote at any price level. In dollars the sum was
  // algebraically 0.98 and the strict compare tripped on float noise for 12 of 97 levels.
  let lockFires = 0
  for (let resC = 2; resC <= 98; resC++) {
    const bidP = (resC - 1) / 100
    const askP = (resC + 1) / 100
    if (cents(bidP) + (100 - cents(askP)) > 98) lockFires++
  }
  ok('loss-lock never fires on a 2c two-sided quote across all 97 levels', lockFires, 0)
  // Fee: at a 1-contract clip the ceiling rounds a fraction of a cent up to a FULL cent - a flat 1c tax
  // that alone eats a 2c half-spread. This is the number that decides whether fee-bearing series are
  // quotable at all, so it is asserted rather than trusted.
  ok('maker fee at 1 contract, P=0.5, rounds up to 1c', makerFeeCents(0.5, 1), 1)
  ok('maker fee amortises at 50 contracts', Math.round(makerFeeCents(0.5, 50) * 100) / 100, 0.44)
  console.log(`\nmmsim selftest: ${bad === 0 ? 'PASSED' : bad + ' FAILED'}`)
  process.exit(bad ? 1 : 0)
}

// ---- run identity and pre-registration ----
const statePath = path.join(DIR, 'state.json')
let state = { runId: null, seq: 0, markets: {}, seenTrades: {}, quotes: {}, fills: [], pending: [] }
function initializeRun() {
fs.mkdirSync(DIR, { recursive: true })
try {
  if (fs.existsSync(statePath)) state = { ...state, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }
} catch {
  /* fresh start */
}
if (!state.runId) {
  state.runId = crypto.randomBytes(6).toString('hex')
  state.startedAt = Date.now()
  state.stopAt = Date.now() + P.runDays * 86400_000
  const prereg = {
    event: 'prereg',
    runId: state.runId,
    startedAtIso: iso(state.startedAt),
    stopAtIso: iso(state.stopAt),
    params: P,
    note: 'Falsification test. PASS authorises a small live confirmation run, never a scale-up. Prior from this account: 653 maker fills at -2.6c each.'
  }
  prereg.sha256 = crypto.createHash('sha256').update(JSON.stringify(prereg)).digest('hex')
  fs.writeFileSync(path.join(DIR, `prereg-${state.runId}.json`), JSON.stringify(prereg, null, 1))
  console.log(`[mmsim] new run ${state.runId}; stops ${prereg.stopAtIso} (fixed, no early stop, no extension)`)
}
}
const rowPath = () => path.join(DIR, `${state.runId}-${new Date().toISOString().slice(0, 10)}.jsonl`)
const rows = []
const emit = (o) => rows.push({ ts: iso(Date.now()), runId: state.runId, seq: ++state.seq, ...o })
function flush() {
  if (rows.length === 0) return
  try {
    fs.appendFileSync(rowPath(), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    rows.length = 0
  } catch {
    /* retried next cycle */
  }
  try {
    const tmp = statePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state))
    fs.renameSync(tmp, statePath)
  } catch {
    /* best effort */
  }
}

// ---- request budget and 429 policy ----
let reqTimes = []
let halted = false
// Set when get() declines a request for the LOCAL budget, so callers can say 'throttled' rather than
// blaming the venue. Cleared by the next get() that actually goes out.
let lastNullWasThrottle = false
let throttleEvents = []
async function get(url, marketId) {
  if (halted) return null
  const now = Date.now()
  reqTimes = reqTimes.filter((t) => now - t < 60_000)
  if (reqTimes.length >= P.maxReqPerMin) {
    lastNullWasThrottle = true
    return null
  }
  lastNullWasThrottle = false
  reqTimes.push(now)
  try {
    const r = await fetch(BASE + url, { headers: { accept: 'application/json', 'User-Agent': 'oracle-mmsim/1.0' }, signal: AbortSignal.timeout(20_000) })
    if (r.status === 429) {
      // Never retry. A 429 is a threat to the live trader, which shares this venue-side budget.
      throttleEvents.push(Date.now())
      throttleEvents = throttleEvents.filter((t) => Date.now() - t < 3600_000)
      emit({ event: 'http429', url: url.slice(0, 100), marketId, consecutive: throttleEvents.length })
      if (throttleEvents.length >= 3) {
        halted = true
        emit({ event: 'halt', reason: '429-storm', detail: '3 throttles within an hour; exiting rather than competing with live trading' })
      }
      await sleep(60_000)
      return null
    }
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

// ---- own-flow exclusion: our live quoter's fills can never have crossed our own resting order ----
let ownFills = []
function loadOwnFills() {
  const out = []
  for (const f of ['quoter-kalshi-fills.jsonl', 'quoter-kalshi.json-fills.jsonl']) {
    try {
      const p = path.join(LIVE_DIR, f)
      if (!fs.existsSync(p)) continue
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line)
          if (r.marketId && r.ts) out.push({ marketId: r.marketId, ts: Date.parse(r.ts), yesPrice: num(r.yesPrice), count: num(r.count) })
        } catch {
          /* torn */
        }
      }
    } catch {
      /* absent */
    }
  }
  ownFills = out
}
const isOwnFlow = (ticker, t) =>
  ownFills.some((o) => o.marketId === ticker && Math.abs(o.ts - t.ts) < 2000 && Math.abs((o.yesPrice ?? -1) - t.yesPrice) < 1e-6)

// ---- venue reads ----
async function book(ticker) {
  const j = await get(`/markets/${encodeURIComponent(ticker)}/orderbook?depth=10`, ticker)
  const ob = j?.orderbook_fp
  if (!ob) return null
  // yes_dollars is the YES bid ladder; no_dollars is the NO bid ladder. A NO bid at price x is a YES ask
  // at 1-x, which is how the ask side is recovered without a separate call.
  const yes = (ob.yes_dollars ?? []).map(([p, s]) => [num(p), num(s)]).filter(([p, s]) => p !== undefined && s !== undefined)
  const no = (ob.no_dollars ?? []).map(([p, s]) => [num(p), num(s)]).filter(([p, s]) => p !== undefined && s !== undefined)
  // A one-sided or crossed book is a VALID observation of an unquotable market, not a fetch failure.
  // Returning null here was logged as a coverage miss and did so at 45-80% on specific MLB-prop markets.
  if (yes.length === 0 || no.length === 0) return { oneSided: true }
  const bestBid = Math.max(...yes.map(([p]) => p))
  const bestAskNo = Math.max(...no.map(([p]) => p))
  const bestAsk = 1 - bestAskNo
  if (!(bestBid > 0 && bestAsk < 1 && bestAsk > bestBid)) return { oneSided: true }
  const bidSize = yes.find(([p]) => Math.abs(p - bestBid) < 1e-9)?.[1] ?? 0
  const askSize = no.find(([p]) => Math.abs(p - bestAskNo) < 1e-9)?.[1] ?? 0
  return { bestBid, bestAsk, bidSize, askSize, spreadC: cents(bestAsk - bestBid) }
}

async function prints(ticker, sinceSec) {
  const j = await get(`/markets/trades?ticker=${encodeURIComponent(ticker)}&min_ts=${sinceSec}&limit=100`, ticker)
  // null means the FETCH failed; [] means it succeeded and there were no prints. Conflating them left
  // lastTradeTs stale on a failure and marked the cycle ok when half of it had not happened.
  if (!j) return null
  const seen = (state.seenTrades[ticker] = state.seenTrades[ticker] ?? [])
  const out = []
  for (const t of j?.trades ?? []) {
    if (seen.includes(t.trade_id)) continue
    seen.push(t.trade_id)
    const yesPrice = num(t.yes_price_dollars)
    const size = num(t.count_fp) ?? 0
    if (yesPrice === undefined) continue
    const p = { tradeId: t.trade_id, yesPrice, size, ts: Date.parse(t.created_time), block: Boolean(t.is_block_trade), takerSide: t.taker_side }
    if (isOwnFlow(ticker, p)) continue
    out.push(p)
  }
  if (seen.length > 500) state.seenTrades[ticker] = seen.slice(-500)
  return out.sort((a, b) => a.ts - b.ts)
}

// ---- universe ----
async function refreshUniverse() {
  const all = []
  let cursor
  for (let i = 0; i < 3; i++) {
    const j = await get(`/markets?status=open&limit=1000&mve_filter=exclude${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (!j) break
    all.push(...(j.markets ?? []))
    cursor = j.cursor
    if (!cursor) break
    await sleep(P.reqGapMs)
  }
  const now = Date.now()
  const seenEvents = new Set()
  const cand = []
  // Count every rejection by its own clause. `eligible N` with no funnel is how the hunch collector's
  // `eligible 0` cost a live probe to diagnose - a filter that cannot say WHY it rejected is a filter
  // nobody can debug.
  const cut = { noBook: 0, tooTight: 0, tooWide: 0, priceBand: 0, horizon: 0, tooNew: 0, dupEvent: 0, volume: 0, pass: 0 }
  for (const m of all) {
    const yb = num(m.yes_bid_dollars)
    const ya = num(m.yes_ask_dollars)
    if (yb === undefined || ya === undefined || !(yb > 0) || !(ya < 1) || !(ya > yb)) { cut.noBook++; continue }
    const sc = cents(ya - yb)
    // Split deliberately: too TIGHT means there is no spread left to capture (the market is already
    // efficiently quoted by someone faster); too WIDE means nobody trusts a two-sided price. They are
    // opposite diagnoses about whether this venue is makeable at all, and one counter hides that.
    if (sc < P.minSpreadC) { cut.tooTight++; continue }
    if (sc > P.maxSpreadC) { cut.tooWide++; continue }
    const mid = (yb + ya) / 2
    if (mid < P.minYes || mid > P.maxYes) { cut.priceBand++; continue }
    const close = m.close_time ? Date.parse(m.close_time) : NaN
    if (!Number.isFinite(close) || (close - now) / 60000 < P.minMinutesToClose) { cut.horizon++; continue }
    const open = m.open_time ? Date.parse(m.open_time) : undefined
    if (open !== undefined && (now - open) / 60000 < P.minMinutesSinceOpen) { cut.tooNew++; continue }
    const ev = m.event_ticker ?? m.ticker
    if (seenEvents.has(ev)) { cut.dupEvent++; continue }
    seenEvents.add(ev)
    const vol = num(m.volume_24h_fp) ?? 0
    if (vol < 50) { cut.volume++; continue }
    cut.pass++
    cand.push({ ticker: m.ticker, event: ev, series: (m.ticker ?? '').split(/-\d/)[0], close: m.close_time, spreadC: sc, vol, feeType: m.fee_type ?? 'unknown' })
  }
  // Rank is a diagnostic only and may never be used to re-slice the primary metric.
  cand.sort((a, b) => b.spreadC * Math.log(1 + b.vol) - a.spreadC * Math.log(1 + a.vol))
  const keep = cand.slice(0, P.trackedMarkets)
  const next = {}
  for (const c of keep) next[c.ticker] = state.markets[c.ticker] ?? { ...c, inv: 0, quotes: {} }
  state.markets = next
  // Prune the print-dedup sets to tracked tickers. Left alone, they held 117 orphaned tickers and 5,246
  // ids after six hours and grew without bound for the whole run, rewritten atomically every cycle.
  for (const k of Object.keys(state.seenTrades)) if (!next[k]) delete state.seenTrades[k]
  emit({ event: 'universe', scanned: all.length, eligible: cand.length, tracked: keep.length, cut, tickers: keep.map((k) => k.ticker) })
  console.log(`[mmsim] universe: scanned ${all.length} -> eligible ${cand.length} -> tracked ${keep.length}  cut: ${Object.entries(cut).filter(([k]) => k !== 'pass').map(([k, v]) => `${k} ${v}`).join(', ')}`)
}

// ---- the quoting rule, mirroring the live midpoint path ----
function desiredQuotes(m, b) {
  const inv = m.inv ?? 0
  const leanC = Math.max(-3, Math.min(3, Math.round((3 * inv) / P.maxInv)))
  const midC = Math.round((b.bestBid + b.bestAsk) * 50)
  const bidC = cents(b.bestBid)
  const askC = cents(b.bestAsk)
  const resC = Math.max(bidC + 1, Math.min(askC - 1, midC - leanC))
  const out = []
  const bidPrice = (resC - 1) / 100
  const askPrice = (resC + 1) / 100
  if (bidPrice > 0.01 && bidPrice < b.bestAsk && inv < P.maxInv) {
    // JOIN if we land on the existing touch, IMPROVE if we create a level inside it.
    const join = Math.abs(bidPrice - b.bestBid) < 1e-9
    out.push({ side: 'bid', yesPrice: bidPrice, cohort: join ? 'JOIN' : 'IMPROVE', queueAhead: join ? b.bidSize : 0 })
  }
  if (askPrice < 0.99 && askPrice > b.bestBid && inv > -P.maxInv) {
    const join = Math.abs(askPrice - b.bestAsk) < 1e-9
    out.push({ side: 'ask', yesPrice: askPrice, cohort: join ? 'JOIN' : 'IMPROVE', queueAhead: join ? b.askSize : 0 })
  }
  // Loss lock: never hold both legs at a combined cost above 98c.
  // Integer cents. In dollars this sum is algebraically 0.98 for every resC - the +/-1 cancel - so the
  // old `> 0.98` fired purely on float representation for 12 of 97 price levels and suppressed both sides.
  if (out.length === 2 && cents(out[0].yesPrice) + (100 - cents(out[1].yesPrice)) > 98) return []
  return out.map((q) => ({ ...q, leanC, inv }))
}

async function cycle() {
  const now = Date.now()
  // Reserve the market loop's certain need before markouts spend anything. Unreserved, a burst of due
  // markouts starved the whole loop (24 due -> all 8 markets ok:false) - the mirror image of the starvation
  // the first-claim ordering was meant to fix. Deferred markouts keep their 10-minute grace.
  const refreshDue = !state.lastUniverse || now - state.lastUniverse > P.universeMs
  const reserved = Object.keys(state.markets).length * 2 + (refreshDue ? 3 : 0)
  await runMarkouts(Math.max(0, P.maxReqPerMin - reserved))
  if (refreshDue) {
    await refreshUniverse()
    state.lastUniverse = now
  }
  for (const [ticker, m] of Object.entries(state.markets)) {
    if (halted) break
    const b = await book(ticker)
    await sleep(P.reqGapMs)
    if (!b) {
      emit({ event: 'cycle', marketId: ticker, ok: false, why: lastNullWasThrottle ? 'throttled' : 'book' })
      continue
    }
    if (b.oneSided) {
      // Observed, not missed: nothing to quote into. Pull anything resting; it could not fill honestly.
      for (const qid of Object.keys(m.quotes)) {
        emit({ event: 'pulled', qid, marketId: ticker, reason: 'oneSided' })
        delete m.quotes[qid]
      }
      emit({ event: 'cycle', marketId: ticker, ok: true, oneSided: true, prints: 0 })
      continue
    }
    const since = Math.floor((m.lastTradeTs ?? now - 120_000) / 1000) - 1
    const ps = await prints(ticker, since)
    await sleep(P.reqGapMs)
    if (ps === null) {
      // Half a cycle is not a cycle. Quotes stay resting (they are guarded by placedAt), but nothing is
      // resolved against an unknown print stream and the cycle does not count as covered.
      emit({ event: 'cycle', marketId: ticker, bid: b.bestBid, ask: b.bestAsk, spreadC: b.spreadC, ok: false, why: lastNullWasThrottle ? 'throttled' : 'prints' })
      continue
    }
    if (ps.length) m.lastTradeTs = ps[ps.length - 1].ts
    emit({ event: 'cycle', marketId: ticker, bid: b.bestBid, ask: b.bestAsk, spreadC: b.spreadC, bidSz: b.bidSize, askSz: b.askSize, prints: ps.length, ok: true })

    const closeMs = m.close ? Date.parse(m.close) : NaN
    const nearClose = Number.isFinite(closeMs) && (closeMs - now) / 60000 < P.cancelMinutesToClose
    // The depth gate, applied HERE because top-of-book sizes exist only in the orderbook, not in /markets.
    // Below the floor is the dust population - the first live cycle tracked a market with an ask size of
    // 0.24 contracts, and a fill there could never have happened at any real size. Above the ceiling the
    // JOIN queue never clears, so the market yields no data while still costing two requests a cycle.
    const touch = Math.min(b.bidSize, b.askSize)
    const depthOk = touch >= P.minTouchSize && touch <= P.maxTouchSize
    if (!depthOk) {
      for (const qid of Object.keys(m.quotes)) {
        emit({ event: 'pulled', qid, marketId: ticker, reason: `depth:${touch.toFixed(2)}` })
        delete m.quotes[qid]
      }
    }

    // 1) resolve existing quotes against this interval's prints and the new book
    for (const [qid, q] of Object.entries(m.quotes)) {
      const r = consumeQueue(q, ps)
      let fill = null
      if (r.filled) fill = { at: r.at, source: 'print', tradeId: r.tradeId }
      else {
        // Book-cross: the market traded clean through us between snapshots. These are the ADVERSE fills;
        // dropping them would delete the losses. Stamped at the START of the interval - the earliest
        // plausible moment - so the markout captures more of the drift against us.
        const crossed = q.side === 'bid' ? b.bestAsk <= q.yesPrice + 1e-9 : b.bestBid >= q.yesPrice - 1e-9
        if (crossed) fill = { at: q.lastSeen ?? now, source: 'book', tradeId: null }
      }
      q.queueAhead = r.queueLeft
      q.lastSeen = now
      if (fill) {
        const signed = q.side === 'bid' ? 1 : -1
        m.inv = (m.inv ?? 0) + signed
        const fillId = crypto.createHash('sha1').update(`${qid}|${fill.tradeId ?? 'book'}`).digest('hex').slice(0, 16)
        emit({
          event: 'fill',
          fillId,
          qid,
          marketId: ticker,
          series: m.series,
          feeType: m.feeType,
          side: q.side,
          cohortQueue: q.cohort,
          yesPrice: q.yesPrice,
          queueAheadAtPlace: q.queueAtPlace,
          invAtFill: m.inv,
          fillSource: fill.source,
          fillTsIso: iso(fill.at),
          feeCents1: makerFeeCents(q.yesPrice, 1),
          feeCents10: makerFeeCents(q.yesPrice, 10),
          feeCents50: makerFeeCents(q.yesPrice, 50)
        })
        // side mid at fill, and the pending markouts
        const sideMid = q.side === 'bid' ? (b.bestBid + b.bestAsk) / 2 : 1 - (b.bestBid + b.bestAsk) / 2
        // The fill price, on OUR side. This is the term the primary metric is measured from: a maker earns
        // the half-spread by transacting away from mid, and a markout taken from the mid instead of from
        // the fill deletes that edge from every observation - the exact bug the review found.
        const sideEntry = q.side === 'bid' ? q.yesPrice : 1 - q.yesPrice
        for (const mins of P.markoutMin) state.pending.push({ fillId, marketId: ticker, side: q.side, sideEntry, sideMidAtFill: sideMid, dueAt: fill.at + mins * 60_000, mins })
        delete m.quotes[qid]
        continue
      }
      // 2) the live cancel/amend machine, simulated - a quote stops accruing the moment the real logic
      // would have pulled or repriced it. Not doing this over-counts fills AND over-samples toxic flow.
      const midC = Math.round((b.bestBid + b.bestAsk) * 50)
      if (nearClose) {
        emit({ event: 'pulled', qid, marketId: ticker, reason: 'nearClose' })
        delete m.quotes[qid]
      } else if (Math.abs(midC - q.midAtPlace) >= P.amendMoveC) {
        // An amend is a new order: back of the queue at the new price.
        emit({ event: 'requote', qid, marketId: ticker, oldYesPrice: q.yesPrice, midMoveC: midC - q.midAtPlace })
        delete m.quotes[qid]
      }
    }

    // 3) place what the rule wants that is not already resting
    if (!nearClose && depthOk) {
      for (const d of desiredQuotes(m, b)) {
        const already = Object.values(m.quotes).some((q) => q.side === d.side && Math.abs(q.yesPrice - d.yesPrice) < 1e-9)
        if (already) continue
        const qid = crypto.randomBytes(8).toString('hex')
        m.quotes[qid] = { ...d, queueAtPlace: d.queueAhead, midAtPlace: Math.round((b.bestBid + b.bestAsk) * 50), lastSeen: now, placedAt: Date.now() }
        emit({ event: 'quote', qid, marketId: ticker, series: m.series, feeType: m.feeType, side: d.side, yesPrice: d.yesPrice, cohortQueue: d.cohort, queueAhead: d.queueAhead, inv: d.inv, leanC: d.leanC, bid: b.bestBid, ask: b.bestAsk, spreadC: b.spreadC })
      }
    }
  }

  flush()
}

/**
 * Due markouts. Runs BEFORE the market loop so it has first claim on the request budget: a markout is
 * time-critical and gate-bearing (coverage < 80% fails the run), whereas a market cycle is retried a minute
 * later at no cost. Running it last starved exactly the observations the gate depends on.
 */
async function runMarkouts(budget) {
  const stillPending = []
  let spent = 0
  for (const p of state.pending) {
    const now = Date.now()
    if (now < p.dueAt) {
      stillPending.push(p)
      continue
    }
    if (spent >= budget) {
      // Over this cycle's share: defer, do not drop. The staleness cutoff below still bounds the wait.
      stillPending.push(p)
      continue
    }
    if (now - p.dueAt > 10 * 60_000) {
      // Too stale to be a clean markout. Dropped, and it counts against coverage - the honest outcome.
      emit({ event: 'markout-dropped', fillId: p.fillId, marketId: p.marketId, mins: p.mins, lateBySec: Math.round((now - p.dueAt) / 1000) })
      continue
    }
    spent++
    const b = await book(p.marketId)
    await sleep(P.reqGapMs)
    if (!b || b.oneSided) {
      // Not this cycle - but not never. It stays due until the staleness cutoff above.
      stillPending.push(p)
      continue
    }
    const sideMid = p.side === 'bid' ? (b.bestBid + b.bestAsk) / 2 : 1 - (b.bestBid + b.bestAsk) / 2
    emit({
      event: `markout${p.mins}`,
      fillId: p.fillId,
      marketId: p.marketId,
      sideEntry: p.sideEntry,
      sideMidAtFill: p.sideMidAtFill,
      sideMidNow: sideMid,
      // Fill-to-now on our side: includes the half-spread captured at t=0. The mid-to-mid drift the
      // review caught is kept alongside as a diagnostic only.
      markoutC: +((sideMid - p.sideEntry) * 100).toFixed(3),
      midDriftC: +((sideMid - p.sideMidAtFill) * 100).toFixed(3)
    })
  }
  state.pending = stillPending
}

async function main() {
  if (!acquireRecorderLock(process.argv[1], DIR)) return
  initializeRun()
  loadOwnFills()
  console.log(`[mmsim] run ${state.runId}; stops ${iso(state.stopAt)}; tracking up to ${P.trackedMarkets} markets at <= ${P.maxReqPerMin} req/min`)
  if (ONCE) {
    await cycle()
    console.log(`[mmsim] one cycle: ${Object.keys(state.markets).length} tracked, ${state.pending.length} markouts pending`)
    return
  }
  for (;;) {
    if (Date.now() > state.stopAt) {
      emit({ event: 'halt', reason: 'stop-date-reached', detail: `pre-registered stop ${iso(state.stopAt)}` })
      flush()
      console.log('[mmsim] pre-registered stop date reached; run complete')
      return
    }
    if (halted) {
      flush()
      console.log('[mmsim] halted')
      return
    }
    try {
      await cycle()
    } catch (e) {
      emit({ event: 'halt', reason: 'error', detail: e instanceof Error ? e.message : String(e) })
      flush()
    }
    await sleep(P.cycleMs)
  }
}

// Guarded: importing this module (a reviewer did, to test makerFeeCents) must not start a second live
// polling loop against the venue. It did, once.
import { pathToFileURL } from 'node:url'
if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
