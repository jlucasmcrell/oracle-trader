// Dutch-book scanner: measures how often, and by how much, Kalshi's
// mutually-exclusive multi-outcome events are priced incoherently.
//   buy-all-YES  : sum(yes_ask) + basket taker fee < 1.00  -> guaranteed $1 payout
//   buy-all-NO   : sum(yes_bid) - basket taker fee > 1.00  -> n-1 payout on n legs
// Public data only; records nothing but prices. Every 60 s, pages the open
// events feed with nested markets, logs a per-scan summary plus every event
// within 5c of a violation (so the distribution is visible, not just hits).
//
//   node scripts/dutchbook-scanner.mjs          run forever
//   node scripts/dutchbook-scanner.mjs --once   one scan
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const K = 'https://api.elections.kalshi.com/trade-api/v2'
const OUT = process.env.DUTCH_DIR || 'G:/PROJECTS/oracle-trader/data/dutchbook'
const ONCE = process.argv.includes('--once')
const NEAR = 0.05          // log events within this of a violation
const MIN_LEGS = 3
mkdirSync(OUT, { recursive: true })
const LOG = join(OUT, 'scanner.log')
const log = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); try { appendFileSync(LOG, l + '\n') } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }
const emit = (o) => appendFileSync(join(OUT, new Date().toISOString().slice(0, 10) + '.jsonl'), JSON.stringify(o) + '\n')
let scans = 0, errors = 0

async function get(u, tries = 4) {
  for (let a = 0; a < tries; a++) {
    let r
    try { r = await fetch(u, { signal: AbortSignal.timeout(20000) }) } catch (e) { if (a === tries - 1) throw e; await sleep(500); continue }
    if (r.ok) return r.json()
    if (r.status === 429 || r.status >= 500) { await sleep(600 * Math.pow(1.8, a)); continue }
    throw new Error(`HTTP ${r.status}`)
  }
  throw new Error('exhausted')
}

// Taker fee per contract for one leg at price p (cents), Kalshi quadratic, multiplier 1 assumed.
const legFee = (p) => 7 * p * (1 - p)

async function scan() {
  scans++
  const ts = new Date().toISOString()
  let cursor, pages = 0, events = 0, checked = 0, buyViol = 0, sellViol = 0, near = 0
  let minSumAsk = Infinity, maxSumBid = -Infinity, minEv = '', maxEv = ''
  for (let p = 0; p < 20; p++) {
    let j
    try { j = await get(`${K}/events?status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`) } catch (e) { errors++; log(`events page ${p}: ${e.message}`); break }
    pages++
    for (const e of j.events ?? []) {
      events++
      if (e.mutually_exclusive !== true) continue
      const ms = (e.markets ?? []).filter((m) => m.status === 'active' || m.status === 'open' || !m.status)
      if (ms.length < MIN_LEGS) continue
      let sumAsk = 0, sumBid = 0, feeAsk = 0, feeBid = 0, minAskSz = Infinity, minBidSz = Infinity, complete = true
      for (const m of ms) {
        const ya = num(m.yes_ask_dollars), yb = num(m.yes_bid_dollars)
        if (ya === null || yb === null || ya <= 0 || ya >= 1) { complete = false; break }
        sumAsk += ya; sumBid += yb
        feeAsk += legFee(ya); feeBid += legFee(1 - yb)
        minAskSz = Math.min(minAskSz, num(m.yes_ask_size_fp) ?? 0)
        minBidSz = Math.min(minBidSz, num(m.yes_bid_size_fp) ?? 0)
      }
      if (!complete) continue
      checked++
      // Mutually exclusive is NOT exhaustive: slates without an Other/None leg
      // (next Pope, 51st state, ...) legitimately sum far below $1 because no
      // listed leg may win. The analysis must restrict to hasOther === true or
      // to events whose sum of asks has been >= 0.98 at some point.
      const hasOther = ms.some((m) => /\b(other|none|another|else|no one|nobody)\b/i.test(`${m.yes_sub_title ?? ''} ${m.subtitle ?? ''} ${m.title ?? ''}`))
      const buyEdge = 1 - sumAsk - feeAsk / 100      // dollars per basket, after fees
      const sellEdge = sumBid - 1 - feeBid / 100
      if (sumAsk < minSumAsk) { minSumAsk = sumAsk; minEv = e.event_ticker }
      if (sumBid > maxSumBid) { maxSumBid = sumBid; maxEv = e.event_ticker }
      const isBuy = buyEdge > 0, isSell = sellEdge > 0
      if (isBuy) buyViol++
      if (isSell) sellViol++
      if (isBuy || isSell || sumAsk < 1 + NEAR || sumBid > 1 - NEAR) {
        near++
        emit({ ts, ev: e.event_ticker, series: e.series_ticker, category: e.category, hasOther, title: (e.title ?? '').slice(0, 80), n: ms.length, sumAsk: +sumAsk.toFixed(4), sumBid: +sumBid.toFixed(4), feeAskCents: +feeAsk.toFixed(2), feeBidCents: +feeBid.toFixed(2), buyEdge: +buyEdge.toFixed(4), sellEdge: +sellEdge.toFixed(4), minAskSize: minAskSz, minBidSize: minBidSz, violation: isBuy ? 'buy-all-yes' : isSell ? 'buy-all-no' : null })
      }
    }
    cursor = j.cursor
    if (!cursor) break
    await sleep(120)
  }
  emit({ ts, kind: 'summary', pages, events, mutuallyExclusiveChecked: checked, buyViolations: buyViol, sellViolations: sellViol, nearLogged: near, minSumAsk: Number.isFinite(minSumAsk) ? +minSumAsk.toFixed(4) : null, minSumAskEvent: minEv, maxSumBid: Number.isFinite(maxSumBid) ? +maxSumBid.toFixed(4) : null, maxSumBidEvent: maxEv })
  if (scans % 5 === 1 || buyViol || sellViol) log(`scan ${scans}: ${events} events / ${checked} exclusive checked | violations buy ${buyViol} sell ${sellViol} | min sumAsk ${Number.isFinite(minSumAsk) ? minSumAsk.toFixed(3) : '-'} (${minEv}) max sumBid ${Number.isFinite(maxSumBid) ? maxSumBid.toFixed(3) : '-'} (${maxEv}) | errors ${errors}`)
}

process.on('unhandledRejection', (e) => { errors++; log('unhandledRejection ' + (e && e.message)) })
log(`dutch-book scanner start (${ONCE ? 'once' : 'loop'}) -> ${OUT}`)
;(async () => {
  for (;;) {
    try { await scan() } catch (e) { errors++; log('scan: ' + e.message) }
    if (ONCE) process.exit(0)
    await sleep(60000 - (Date.now() % 60000) + 5000)
  }
})()
