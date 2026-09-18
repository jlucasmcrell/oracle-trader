// Lead-lag analysis over data/leadlag/*.jsonl (see leadlag-recorder.mjs).
// Question: when Polymarket.com's mid moves by >= THRESH within a short burst,
// how long until Kalshi's mid follows, and would lifting the stale Kalshi ask at
// that moment have profited, graded against Kalshi's own mid LOOKAHEAD seconds
// later (a proxy for settlement direction) and net of the taker fee?
// Also reports the reverse direction (Kalshi leads Polymarket), so the claim is
// tested symmetrically. Windows are clustered (all strikes/coins in one window
// share a BTC path).
//
//   node scripts/leadlag-analyze.mjs            (defaults: THRESH=0.04, LOOKAHEAD=60s)
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.LEADLAG_DIR || 'G:/PROJECTS/oracle-trader/data/leadlag'
const THRESH = +(process.env.THRESH || 0.04)
const BURST_MS = +(process.env.BURST_MS || 5000)          // the move must occur within this span on the leader
const LOOKAHEAD_S = +(process.env.LOOKAHEAD || 60)         // grade at the follower's mid this far after the trigger
const FEE = (px) => { const C = Math.max(1, Math.floor(10 / Math.max(px, 0.01))); return Math.ceil(0.07 * C * px * (1 - px) * 100 - 1e-9) / C }   // cents/contract

const series = new Map()   // key `${coin}|${win}|${venue}` -> [{t, bid, ask, mid}]
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(DIR, f), 'utf8').split('\n')) {
    if (!line) continue
    let j; try { j = JSON.parse(line) } catch { continue }
    if (j.bid === null || j.ask === null || j.bid === undefined || j.ask === undefined) continue
    if (!(j.bid > 0 && j.ask > 0 && j.ask >= j.bid && j.ask - j.bid <= 0.2)) continue
    const key = `${j.coin}|${j.win}|${j.v}`
    ;(series.get(key) ?? series.set(key, []).get(key)).push({ t: Date.parse(j.ts), bid: j.bid, ask: j.ask, mid: (j.bid + j.ask) / 2 })
  }
}
for (const arr of series.values()) arr.sort((a, b) => a.t - b.t)
const wins = new Set([...series.keys()].map((k) => k.split('|').slice(0, 2).join('|')))
console.log(`series ${series.size}, coin-windows ${wins.size}`)

const at = (arr, t) => { let lo = 0, hi = arr.length - 1, best = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { best = arr[m]; lo = m + 1 } else hi = m - 1 } return best }   // last record at or before t

function analyze(leaderV, followerV) {
  const events = []
  for (const cw of wins) {
    const L = series.get(`${cw}|${leaderV}`), F = series.get(`${cw}|${followerV}`)
    if (!L || !F || L.length < 5 || F.length < 5) continue
    let lastTrigger = -Infinity
    for (let i = 1; i < L.length; i++) {
      // burst: compare with the leader record BURST_MS earlier
      const prev = at(L, L[i].t - BURST_MS); if (!prev) continue
      const d = L[i].mid - prev.mid
      if (Math.abs(d) < THRESH) continue
      if (L[i].t - lastTrigger < LOOKAHEAD_S * 1000) continue      // one trigger per lookahead span
      lastTrigger = L[i].t
      const f0 = at(F, L[i].t); if (!f0) continue                     // follower's stale book at the trigger
      // has the follower already moved? (skip if it already reflects the move)
      const fPrev = at(F, L[i].t - BURST_MS)
      if (fPrev && Math.sign(f0.mid - fPrev.mid) === Math.sign(d) && Math.abs(f0.mid - fPrev.mid) >= THRESH / 2) continue
      const f1 = at(F, L[i].t + LOOKAHEAD_S * 1000); if (!f1 || f1.t <= f0.t) continue
      // time until the follower moves >= THRESH/2 in the leader's direction
      let followMs = null
      for (const r of F) { if (r.t <= L[i].t) continue; if (Math.sign(r.mid - f0.mid) === Math.sign(d) && Math.abs(r.mid - f0.mid) >= THRESH / 2) { followMs = r.t - L[i].t; break } if (r.t - L[i].t > 600e3) break }
      // trade the follower toward the leader: buy YES at follower ask if d>0, else buy NO at 1-bid; grade at follower mid LOOKAHEAD later (mark-to-mid, cents)
      const side = d > 0 ? 'YES' : 'NO'
      const cost = side === 'YES' ? f0.ask : 1 - f0.bid
      const exitMid = side === 'YES' ? f1.mid : 1 - f1.mid
      const net = (exitMid - cost) * 100 - FEE(cost)
      events.push({ cw, t: L[i].t, d, cost, net, followMs, gap: side === 'YES' ? (L[i].mid - f0.ask) : ((1 - L[i].mid) - (1 - f0.bid)) })
    }
  }
  const mu = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN
  const clusterSE = (vals, keys) => { const g = new Map(); vals.forEach((v, i) => g.set(keys[i], (g.get(keys[i]) ?? []).concat(v))); const m = mu(vals), G = [...g.values()]; return [Math.sqrt(G.reduce((s, arr) => s + Math.pow(arr.reduce((x, y) => x + y, 0) - arr.length * m, 2), 0) / (vals.length ** 2)), G.length] }
  console.log(`\n=== ${leaderV} leads -> trade ${followerV} toward it | moves >= ${THRESH} within ${BURST_MS / 1000}s, graded at ${followerV} mid +${LOOKAHEAD_S}s ===`)
  if (!events.length) { console.log('  no trigger events'); return }
  const v = events.map((e) => e.net), [se, G] = clusterSE(v, events.map((e) => e.cw)), m = mu(v)
  const followed = events.filter((e) => e.followMs !== null), fm = followed.map((e) => e.followMs / 1000).sort((a, b) => a - b)
  console.log(`  triggers ${events.length} over ${G} windows | follower moved within 10 min: ${followed.length} (${(100 * followed.length / events.length).toFixed(0)}%) | median follow time ${fm.length ? fm[Math.floor(fm.length / 2)].toFixed(0) : '-'}s (p25 ${fm.length ? fm[Math.floor(fm.length / 4)].toFixed(0) : '-'}, p75 ${fm.length ? fm[Math.floor(3 * fm.length / 4)].toFixed(0) : '-'})`)
  console.log(`  mean gap at trigger (leader mid - follower ask on our side) ${(100 * mu(events.map((e) => e.gap))).toFixed(1)}c | NET mark-to-mid ${m.toFixed(2)}c/contract  window-clustered CI95 [${(m - 1.96 * se).toFixed(2)}, ${(m + 1.96 * se).toFixed(2)}]`)
  const big = events.filter((e) => e.gap >= 0.03)
  if (big.length) { const bv = big.map((e) => e.net), [bse] = clusterSE(bv, big.map((e) => e.cw)); console.log(`  subset gap >= 3c: n=${big.length} NET ${mu(bv).toFixed(2)}c CI95 [${(mu(bv) - 1.96 * bse).toFixed(2)}, ${(mu(bv) + 1.96 * bse).toFixed(2)}]`) }
}
analyze('pm', 'kalshi')
analyze('kalshi', 'pm')
console.log('\nCaveats: Kalshi is sampled every ~2-16s (REST), Polymarket on every update; mark-to-mid is a proxy for settlement; fee assumes multiplier 1; one trigger per lookahead span per window.')
