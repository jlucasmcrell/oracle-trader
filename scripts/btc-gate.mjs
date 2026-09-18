// Gate checker for docs/PREREGISTERED-btc-convergence.md.
// Reads the collector's JSONL (data/btc-collector/*.jsonl) and grades the
// pre-registered rule exactly as written: T-5 book snapshot, Coinbase spot,
// margin 0.1-0.6% of spot, side = sign(spot - strike), lift the live ask from
// the snapshot, Kalshi taker fee, graded at settlement. Reports event- and
// day-clustered intervals at z=3.02 (Bonferroni, 20 cells) and the
// Coinbase-vs-BRTI basis. Prints PASS/FAIL against the fixed gate.
//
//   node scripts/btc-gate.mjs              full report
//   node scripts/btc-gate.mjs --since ISO  only events closing after ISO
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.BTC_COLLECTOR_DIR || 'G:/PROJECTS/oracle-trader/data/btc-collector'
const REGISTERED_AT = Date.parse('2026-09-02T12:45:00Z')   // rule fixed here; only later closes count
const argSince = process.argv.indexOf('--since')
const SINCE = argSince > -1 ? Date.parse(process.argv[argSince + 1]) : REGISTERED_AT
const SERIES = process.env.GATE_SERIES || 'KXBTCD'   // v1 records carry no series field and are KXBTCD
const WINDOW = 5, M_LO = 0.001, M_HI = 0.006, Z_BONF = 3.02, Z_NAIVE = 1.96
const MIN_EVENTS = 200, MIN_LB_CENTS = 1.0

// ---- load ----
const books = new Map()      // ev -> { ts, mtc, spot, strikes: Map(ticker -> book) }
const settled = new Map()    // ticker -> { result, brti, close, ev }
const lastLadder = new Map() // ev -> latest ladder tick (for spot at close)
let lines = 0
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(DIR, f), 'utf8').split('\n')) {
    if (!line) continue
    let j; try { j = JSON.parse(line) } catch { continue }
    lines++
    // The collector now records nine series; the pre-registered hourly rule is
    // graded on its own series only (15-minute T-5 books must not leak in).
    if ((j.series ?? 'KXBTCD') !== SERIES) continue
    if (j.kind === 'book' && j.w === WINDOW) {
      const e = books.get(j.ev) ?? { ev: j.ev, close: Date.parse(j.close), ts: j.ts, spot: j.spot, strikes: new Map() }
      e.strikes.set(j.t, j); books.set(j.ev, e)
    } else if (j.kind === 'settled') {
      settled.set(j.t, { result: j.result, brti: j.expiration_value, close: Date.parse(j.close), ev: j.ev })
    } else if (j.kind === 'ladder') {
      const prev = lastLadder.get(j.ev)
      if (!prev || j.mtc < prev.mtc) lastLadder.set(j.ev, j)
    }
  }
}

// ---- grade the rule ----
// Kalshi orderbook_fp lists resting YES bids and resting NO bids. Lifting the
// YES ask means taking the best resting NO bid: yes_ask = 1 - max(no price).
// Buying NO lifts the NO ask = 1 - max(yes bid price).
const best = (levels) => levels && levels.length ? levels.reduce((m, [p, q]) => (p > m[0] ? [p, q] : m), [0, 0]) : [0, 0]
const fee = (px, C) => Math.ceil(0.07 * C * px * (1 - px) * 100 - 1e-9) / 100 / C * 100   // cents per contract
const rows = [], skipped = { noSpot: 0, noAsk: 0, unsettled: 0, beforeRegistration: 0 }
for (const e of books.values()) {
  if (e.close < SINCE) { skipped.beforeRegistration++; continue }
  const spot = e.spot && e.spot.cb
  if (!spot) { skipped.noSpot++; continue }
  for (const b of e.strikes.values()) {
    const m = Math.abs(spot - b.strike) / spot
    if (m < M_LO || m > M_HI) continue
    const side = spot > b.strike ? 'YES' : 'NO'
    const [restPx, restQty] = side === 'YES' ? best(b.no) : best(b.yes)
    if (!(restPx > 0) || !(restQty > 0)) { skipped.noAsk++; continue }
    const cost = +(1 - restPx).toFixed(4)            // what we pay per contract on our side
    const s = settled.get(b.t)
    if (!s) { skipped.unsettled++; continue }
    const win = (side === 'YES' && s.result === 'yes') || (side === 'NO' && s.result === 'no')
    const C = Math.max(1, Math.floor(10 / Math.max(cost, 0.01)))
    const net = (win ? (1 - cost) : -cost) * 100 - fee(cost, C)
    rows.push({ ev: e.ev, day: new Date(e.close).toISOString().slice(0, 10), t: b.t, side, margin: m, cost, qty: restQty, win, net, spotT5: spot, brti: s.brti, strike: b.strike })
  }
}

// ---- stats ----
const mu = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN
const clusterSE = (vals, keys) => {
  const g = new Map(); vals.forEach((v, i) => g.set(keys[i], (g.get(keys[i]) ?? []).concat(v)))
  const m = mu(vals), G = [...g.values()]
  return [Math.sqrt(G.reduce((s, arr) => s + Math.pow(arr.reduce((x, y) => x + y, 0) - arr.length * m, 2), 0) / (vals.length ** 2)), G.length]
}
console.log(`collector lines ${lines}; T-${WINDOW} book snapshots for ${books.size} events; settled tickers ${settled.size}`)
console.log(`skipped: ${JSON.stringify(skipped)}`)
if (!rows.length) {
  console.log('\nGRADED TRADES: 0 - nothing to score yet (need T-5 books AND settled results for the same events).\nGATE: NOT EVALUABLE')
  if (process.argv.includes('--json')) console.log('GATE_JSON ' + JSON.stringify({ pass: false, events: 0, days: 0, graded: 0, meanCents: null, lbBonferroni: null, dayLb: null, adverse: null }))
  process.exit(0)
}

const nets = rows.map((r) => r.net)
const [seEv, nEv] = clusterSE(nets, rows.map((r) => r.ev))
const [seDay, nDay] = clusterSE(nets, rows.map((r) => r.day))
const m = mu(nets)
const adverse = rows.filter((r) => !r.win).length / rows.length
console.log(`\nGRADED: ${rows.length} strike-trades over ${nEv} events, ${nDay} days | P(adverse)=${(100 * adverse).toFixed(2)}% | mean cost ${(100 * mu(rows.map((r) => r.cost))).toFixed(1)}c | mean resting size at ask ${mu(rows.map((r) => r.qty)).toFixed(0)}`)
console.log(`NET TAKER: ${m.toFixed(2)}c/contract`)
console.log(`  event-clustered: SE ${seEv.toFixed(2)}  CI95 [${(m - Z_NAIVE * seEv).toFixed(2)}, ${(m + Z_NAIVE * seEv).toFixed(2)}]  Bonferroni z=${Z_BONF}: [${(m - Z_BONF * seEv).toFixed(2)}, ${(m + Z_BONF * seEv).toFixed(2)}]`)
console.log(`  day-clustered:   SE ${seDay.toFixed(2)}  CI95 [${(m - Z_NAIVE * seDay).toFixed(2)}, ${(m + Z_NAIVE * seDay).toFixed(2)}]`)

// basis: Coinbase spot at the last ladder tick before close vs BRTI
const basis = []
for (const [ev, lad] of lastLadder) {
  const anyT = [...settled.values()].find((s) => s.ev === ev)
  if (!anyT || !lad.spot || !lad.spot.cb || !anyT.brti || lad.mtc > 1.5) continue
  basis.push({ ev, cb: lad.spot.cb, brti: anyT.brti, diff: lad.spot.cb - anyT.brti, mtc: lad.mtc })
}
const flips = rows.filter((r) => Math.sign(r.spotT5 - r.strike) !== Math.sign(r.brti - r.strike)).length
if (basis.length) {
  const ad = basis.map((b) => Math.abs(b.diff))
  console.log(`\nBASIS (Coinbase at last tick <=1.5min before close vs BRTI): n=${basis.length} mean|diff| $${mu(ad).toFixed(1)} median $${ad.sort((a, b) => a - b)[Math.floor(ad.length / 2)].toFixed(1)} (${(100 * mu(ad) / mu(basis.map((b) => b.cb))).toFixed(3)}% of spot)`)
}
console.log(`SIGN FLIPS spot(T-5) vs BRTI at traded strikes: ${flips}/${rows.length} (${(100 * flips / rows.length).toFixed(1)}%) - this is the realized adverse rate's floor`)

// per-margin bucket, for the record (NOT for re-selecting the rule)
const bk = new Map()
for (const r of rows) { const k = r.margin < 0.002 ? '0.10-0.20%' : r.margin < 0.004 ? '0.20-0.40%' : '0.40-0.60%'; const v = bk.get(k) ?? { n: 0, net: 0, adv: 0 }; v.n++; v.net += r.net; if (!r.win) v.adv++; bk.set(k, v) }
console.log('\nby margin bucket (descriptive only):')
for (const [k, v] of [...bk.entries()].sort()) console.log(`  ${k}  n=${String(v.n).padStart(4)}  net ${(v.net / v.n).toFixed(2)}c  adverse ${(100 * v.adv / v.n).toFixed(1)}%`)

// ---- baseline decomposition (from the repo review): did we beat the market, or just hold the side that won?
// 'opposite' = buying the OTHER side at ITS ask from the same snapshot; if ours ~ opposite ~ negative, the
// market was efficient and fees decided it; if ours >> opposite, the side selection carried information.
{
  const opp = rows.map((r) => {
    const b = books.get(r.ev)?.strikes.get(r.t); if (!b) return null
    const [px, qty] = r.side === 'YES' ? best(b.yes) : best(b.no)   // other side's ask = 1 - our side's best bid
    if (!(px > 0) || !(qty > 0)) return null
    const cost = +(1 - px).toFixed(4), win = !r.win
    const C = Math.max(1, Math.floor(10 / Math.max(cost, 0.01)))
    return (win ? (1 - cost) : -cost) * 100 - fee(cost, C)
  }).filter((x) => x !== null)
  if (opp.length) console.log(`
BASELINE: our side ${m.toFixed(2)}c vs opposite side at its ask ${mu(opp).toFixed(2)}c (n=${opp.length}); coin-flip of the two ${((m + mu(opp)) / 2).toFixed(2)}c`)
}

// ---- the gate ----
const lb = m - Z_BONF * seEv
const c1 = nEv >= MIN_EVENTS, c2 = lb > MIN_LB_CENTS, c3 = (m - Z_NAIVE * seDay) > 0
console.log(`\nGATE (pre-registered):`)
console.log(`  [${c1 ? 'x' : ' '}] >= ${MIN_EVENTS} new events            (${nEv})`)
console.log(`  [${c2 ? 'x' : ' '}] event-clustered LB > +${MIN_LB_CENTS}c @z=${Z_BONF}  (${lb.toFixed(2)}c)`)
console.log(`  [${c3 ? 'x' : ' '}] day-clustered CI excludes zero    (LB ${(m - Z_NAIVE * seDay).toFixed(2)}c)`)
console.log(`  [ ] basis <= 1c implied-prob          (report above; judged when n>=50 settled events)`)
console.log(`RESULT: ${c1 && c2 && c3 ? 'PASS (pending basis clause)' : 'FAIL / NOT YET'}`)
// Machine-readable verdict for the in-app promotion ladder (last line, prefixed).
if (process.argv.includes('--json')) {
  console.log('GATE_JSON ' + JSON.stringify({ pass: c1 && c2 && c3, events: nEv, days: nDay, graded: rows.length, meanCents: +m.toFixed(3), lbBonferroni: +lb.toFixed(3), dayLb: +(m - Z_NAIVE * seDay).toFixed(3), adverse: +adverse.toFixed(4) }))
}
