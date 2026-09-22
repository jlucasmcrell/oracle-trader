// Grades the spot-first shadow (scripts/spot-shadow.mjs) against the rule PRE-REGISTERED in
// docs/PREREGISTERED-spot-first-shadow.md before a single row existed. Offline: settlement is in the rows
// (the recorder harvests it), so this grader has no network of its own.
//
//   node scripts/spot-shadow-gate.mjs --interim    health only (rows, coverage, spot age); no P&L
//   node scripts/spot-shadow-gate.mjs --verdict    refused before READ_AT; PASS/FAIL against the rule
//   node scripts/spot-shadow-gate.mjs --selftest   pure functions on synthetic rows
//
// Decision unit: one per (coin, window, side) = the FIRST Kalshi poll in the window that qualifies.
// A poll qualifies when the spot tick is fresh (<= MAX_SPOT_AGE_MS), the window has >= MIN_TAU_S left, the
// fair value exists, the touch has size, and the edge net of Kalshi's taker fee is >= the threshold.
//   YES: edge = 100*fv - askC - fee(ask)      buy YES at the ask;   won <=> result 'yes'
//   NO:  edge = bidC - 100*fv - fee(1 - bid)  buy NO at 1 - bid;    won <=> result 'no'
// Net cents per contract = (won ? 100 - paidC : -paidC) - fee. Primary threshold 3c; 2c and 5c reported.
// Bands are day-clustered (UTC day), Z = 1.28 (80%). PASS = n >= MIN_N, clusters >= MIN_DAYS, lower band > 0
// at the PRIMARY threshold. PASS earns a SHADOW-to-tiny-live proposal through the ladder, nothing more.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DIR = process.env.SPOT_SHADOW_DIR ?? 'G:/PROJECTS/oracle-trader/data/spot-shadow'
export const READ_AT = '2026-09-21T00:00:00Z'
export const MIN_N = 300
export const MIN_DAYS = 5
export const PRIMARY_THR = 3
export const THRS = [2, 3, 5]
export const MAX_SPOT_AGE_MS = 3000
export const MIN_TAU_S = 90
export const Z = 1.28

export const feeCents = (p) => Math.ceil(7 * p * (1 - p) - 1e-9)
export const dayOf = (ts) => String(ts).slice(0, 10)

/** Both sides' edges in cents for one Kalshi poll row, or null when the row cannot be judged. */
export function edges(r) {
  if (r.fv === null || r.fv === undefined || !(r.spotAge <= MAX_SPOT_AGE_MS) || !(r.tauS >= MIN_TAU_S)) return null
  const out = {}
  if (r.ask !== null && r.ask !== undefined && r.askSz >= 1) {
    const askC = Math.round(r.ask * 100)
    out.YES = { edge: 100 * r.fv - askC - feeCents(r.ask), paidC: askC, fee: feeCents(r.ask) }
  }
  if (r.bid !== null && r.bid !== undefined && r.bidSz >= 1) {
    const bidC = Math.round(r.bid * 100)
    out.NO = { edge: bidC - 100 * r.fv - feeCents(1 - r.bid), paidC: 100 - bidC, fee: feeCents(1 - r.bid) }
  }
  return out
}

/** First qualifying poll per (coin, window, side) at a threshold; rows must be in time order. Also counts how
 *  many CONSECUTIVE later polls kept the same-side edge over the threshold (persistence, in polls). */
export function decisions(kRows, thr) {
  const first = new Map()
  const run = new Map()
  for (const r of kRows) {
    const e = edges(r)
    for (const side of ['YES', 'NO']) {
      const key = `${r.coin}|${r.win}|${side}`
      const q = e && e[side] && e[side].edge >= thr
      if (!first.has(key)) {
        if (q) { first.set(key, { key, coin: r.coin, win: r.win, t: r.t, side, ts: r.ts, tauS: r.tauS, fv: r.fv, ...e[side], persist: 1, done: false }) }
      } else {
        const d = first.get(key)
        if (!d.done) { if (q) d.persist++; else d.done = true }
      }
    }
    void run
  }
  return [...first.values()]
}

export function settle(decs, settles) {
  const res = new Map(settles.map((s) => [s.t, s.result]))
  return decs.map((d) => {
    const r = res.get(d.t)
    if (r !== 'yes' && r !== 'no') return { ...d, settled: false }
    const won = (d.side === 'YES') === (r === 'yes')
    return { ...d, settled: true, won, net: (won ? 100 - d.paidC : -d.paidC) - d.fee }
  })
}

/** Day-clustered mean and 80% band (cluster = UTC day of the decision). */
export function clusteredBand(nets, days) {
  const n = nets.length
  if (!n) return { n: 0, D: 0, mean: null, lo: null, hi: null }
  const m = nets.reduce((a, b) => a + b, 0) / n
  const g = new Map()
  nets.forEach((v, i) => g.set(days[i], (g.get(days[i]) ?? 0) + (v - m)))
  const se = Math.sqrt([...g.values()].reduce((s, x) => s + x * x, 0)) / n
  return { n, D: g.size, mean: m, lo: m - Z * se, hi: m + Z * se }
}

/** Only the row kinds the rule reads (`k`, `settle`, `win`); spot and Polymarket rows are ~70% of the file
 *  (~110 MB/day measured) and stay on disk for the ordering analysis, which is descriptive and separate. */
export function loadRows(dir = DIR, kinds = new Set(['k', 'settle', 'win'])) {
  const rows = []
  if (!fs.existsSync(dir)) return rows
  for (const f of fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue
      const m = /"v":"([a-z]+)"/.exec(line)
      if (m && !kinds.has(m[1])) continue
      try { rows.push(JSON.parse(line)) } catch { /* torn line at the tail */ }
    }
  }
  return rows
}

function fmt(b) { return b.mean === null ? 'n/a' : `${b.mean >= 0 ? '+' : ''}${b.mean.toFixed(2)}c [${b.lo.toFixed(2)}, ${b.hi.toFixed(2)}] n=${b.n} D=${b.D}` }

function interim(rows) {
  const by = {}
  for (const r of rows) by[r.v] = (by[r.v] ?? 0) + 1
  const k = rows.filter((r) => r.v === 'k')
  const days = new Set(k.map((r) => dayOf(r.ts)))
  const coins = new Set(k.map((r) => r.coin))
  const withFv = k.filter((r) => r.fv !== null && r.fv !== undefined).length
  const ages = k.map((r) => r.spotAge).filter((a) => a !== null && a !== undefined).sort((a, b) => a - b)
  const p = (q) => (ages.length ? ages[Math.min(ages.length - 1, Math.floor(q * ages.length))] : null)
  const settled = rows.filter((r) => r.v === 'settle').length
  const wins = new Set(k.map((r) => `${r.coin}|${r.win}`)).size
  const settledWins = new Set(rows.filter((r) => r.v === 'settle').map((r) => `${r.coin}|${r.win}`)).size
  console.log(`rows loaded by kind (k/settle/win only; spot and pm rows stay on disk): ${JSON.stringify(by)}`)
  console.log(`Kalshi polls ${k.length} over ${days.size} day(s), coins ${[...coins].join(',')}; with fair value ${withFv} (${k.length ? (100 * withFv / k.length).toFixed(1) : 0}%)`)
  console.log(`spot age at poll: p50 ${p(0.5)} ms, p90 ${p(0.9)} ms, p99 ${p(0.99)} ms; polls with stale spot (> ${MAX_SPOT_AGE_MS} ms): ${ages.filter((a) => a > MAX_SPOT_AGE_MS).length}`)
  console.log(`(coin, window) pairs polled ${wins}; settled ${settledWins} (${settled} settle rows)`)
  const cand = THRS.map((t) => `${t}c: ${decisions(k, t).length}`).join('  ')
  console.log(`candidate decisions by threshold (count only; P&L is read on/after ${READ_AT}): ${cand}`)
}

function verdict(rows, now = new Date()) {
  if (now < new Date(READ_AT)) { console.log(`REFUSED: pre-registered read date is ${READ_AT}; use --interim`); process.exitCode = 2; return }
  const k = rows.filter((r) => r.v === 'k')
  const settles = rows.filter((r) => r.v === 'settle')
  let pass = null
  for (const thr of THRS) {
    const decs = settle(decisions(k, thr), settles)
    const s = decs.filter((d) => d.settled)
    const band = clusteredBand(s.map((d) => d.net), s.map((d) => dayOf(d.ts)))
    const pers = s.map((d) => d.persist * 2).sort((a, b) => a - b)
    const med = pers.length ? pers[Math.floor(pers.length / 2)] : null
    const p90 = pers.length ? pers[Math.min(pers.length - 1, Math.floor(0.9 * pers.length))] : null
    console.log(`thr ${thr}c: ${fmt(band)}; unsettled ${decs.length - s.length}; wins ${s.filter((d) => d.won).length}/${s.length}; persistence median ${med}s p90 ${p90}s`)
    for (const coin of [...new Set(s.map((d) => d.coin))].sort()) {
      const c = s.filter((d) => d.coin === coin)
      console.log(`    ${coin}: ${fmt(clusteredBand(c.map((d) => d.net), c.map((d) => dayOf(d.ts))))}`)
    }
    for (const side of ['YES', 'NO']) {
      const c = s.filter((d) => d.side === side)
      console.log(`    ${side}: ${fmt(clusteredBand(c.map((d) => d.net), c.map((d) => dayOf(d.ts))))}`)
    }
    if (thr === PRIMARY_THR) pass = band.n >= MIN_N && band.D >= MIN_DAYS && band.lo > 0
  }
  // Does the fair value carry information the Kalshi mid does not? Brier on one row per (coin, window, minute).
  // Same freshness rule as the decisions above: a fair value priced off a spot tick older than MAX_SPOT_AGE_MS is
  // not the model, it is a stale input. Without this filter 18,955 of 52,229 samples (2026-09-22) carried a stale
  // spot and the line read fv 0.2600 vs mid 0.1565 - worse than guessing 50% - when the model on fresh ticks scores
  // 0.1587 vs 0.1539. The verdict was never affected; the line alone suggested a broken model (section 157).
  const res = new Map(settles.map((s) => [s.t, s.result]))
  const seen = new Set(); let bf = 0, bm = 0, n = 0
  for (const r of k) {
    if (r.fv === null || r.fv === undefined || r.bid === null || r.ask === null || !(r.tauS >= MIN_TAU_S)) continue
    if (!(r.spotAge <= MAX_SPOT_AGE_MS)) continue
    const key = `${r.coin}|${r.win}|${String(r.ts).slice(0, 16)}`
    if (seen.has(key) || !res.has(r.t)) continue
    seen.add(key)
    const y = res.get(r.t) === 'yes' ? 1 : 0
    bf += (r.fv - y) ** 2; bm += ((r.bid + r.ask) / 2 - y) ** 2; n++
  }
  if (n) console.log(`fair value vs Kalshi mid, Brier on ${n} minute-samples: fv ${(bf / n).toFixed(4)} mid ${(bm / n).toFixed(4)} (lower is better)`)
  console.log(pass ? `PASS at ${PRIMARY_THR}c: propose a tiny-live arm through the ladder (see the pre-registration).` : `FAIL at ${PRIMARY_THR}c (needs n >= ${MIN_N}, days >= ${MIN_DAYS}, lower band > 0).`)
}

function selftest() {
  let n = 0, fails = 0
  const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL ' + m) } }
  ok(feeCents(0.5) === 2 && feeCents(0.63) === 2 && feeCents(0.99) === 1 && feeCents(0.9) === 1, 'fee ceil to cent')
  const base = { v: 'k', coin: 'BTC', win: 1, t: 'T1', bid: 0.60, bidSz: 5, ask: 0.61, askSz: 5, spotAge: 500, tauS: 600, fv: 0.66 }
  const e = edges(base)
  ok(e.YES.edge === 66 - 61 - 2 && e.YES.paidC === 61, `YES edge ${e.YES.edge}`)
  ok(Math.abs(e.NO.edge - (60 - 66 - 2)) < 1e-9 && e.NO.paidC === 40, `NO edge ${e.NO.edge}`)
  ok(edges({ ...base, spotAge: 3001 }) === null, 'stale spot refused')
  ok(edges({ ...base, tauS: 89 }) === null, 'last 90 s refused')
  ok(edges({ ...base, fv: null }) === null, 'no fair value refused')
  ok(edges({ ...base, askSz: 0 }).YES === undefined, 'empty touch refused')
  const rows = [
    { ...base, ts: '2026-09-15T00:00:00Z', fv: 0.62 },          // YES edge -1: not yet
    { ...base, ts: '2026-09-15T00:00:02Z', fv: 0.66 },          // YES edge 3: first qualifying
    { ...base, ts: '2026-09-15T00:00:04Z', fv: 0.67 },          // still over -> persist 2
    { ...base, ts: '2026-09-15T00:00:06Z', fv: 0.62 },          // gone
    { ...base, ts: '2026-09-15T00:00:08Z', fv: 0.70 },          // back over, but the decision is already taken
    { ...base, ts: '2026-09-15T00:00:10Z', win: 2, t: 'T2', fv: 0.50, bid: 0.60 } // NO edge 60-50-2 = 8
  ]
  const d3 = decisions(rows, 3)
  ok(d3.length === 2 && d3[0].side === 'YES' && d3[0].ts === '2026-09-15T00:00:02Z' && d3[0].persist === 2, `first qualifying + persistence ${JSON.stringify(d3[0])}`)
  ok(d3[1].side === 'NO' && d3[1].t === 'T2' && d3[1].paidC === 40, 'NO decision on window 2')
  const d5 = decisions(rows, 5)
  ok(d5.length === 2 && d5[0].side === 'YES' && d5[0].ts === '2026-09-15T00:00:08Z' && d5[0].persist === 1 && d5[1].side === 'NO',
    `threshold 5 skips the 3c polls and takes the later 7c one ${JSON.stringify(d5.map((d) => [d.side, d.ts]))}`)
  const s = settle(d3, [{ t: 'T1', result: 'yes' }, { t: 'T2', result: 'yes' }])
  ok(s[0].settled && s[0].won && s[0].net === 100 - 61 - 2, `YES win net ${s[0].net}`)
  ok(s[1].settled && !s[1].won && s[1].net === -40 - 2, `NO loss net ${s[1].net}`)
  ok(settle(d3, [])[0].settled === false, 'unsettled stays unsettled')
  const b = clusteredBand([10, -10, 10, -10], ['a', 'a', 'b', 'b'])
  ok(b.n === 4 && b.D === 2 && b.mean === 0 && b.lo === 0 && b.hi === 0, `clustered band zero-variance across clusters ${JSON.stringify(b)}`)
  const b2 = clusteredBand([10, 10, -10, -10], ['a', 'a', 'b', 'b'])
  ok(b2.D === 2 && b2.lo < 0 && b2.hi > 0 && Math.abs(b2.hi - Z * Math.sqrt(800) / 4) < 1e-9, `clustered band with between-cluster variance ${JSON.stringify(b2)}`)
  const out = []; const orig = console.log; console.log = (m) => out.push(m)
  verdict([], new Date('2026-09-20T23:59:59Z')); console.log = orig
  ok(out.some((m) => String(m).startsWith('REFUSED')) && process.exitCode === 2, 'verdict refused before READ_AT')
  process.exitCode = fails ? 1 : 0
  console.log(`selftest: ${n} checks, ${fails} failed`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2)
  if (a.includes('--selftest')) selftest()
  else if (a.includes('--verdict')) verdict(loadRows())
  else interim(loadRows())
}
