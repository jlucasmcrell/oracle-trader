/**
 * What the live-stage rule does to an arm whose TRUE edge is known (external review GLM 5.3, F-02 and F-09; the
 * synthetic-edge half of BACKLOG 156). Runs the production `decideStage` and `clusteredMean` on simulated
 * lead-lag-shaped evidence: one row per settled 15-minute market, dollars, day-clustered, judged every 20 rows.
 *
 *   node scripts/tests/run.cjs scripts/ladder-power-sim.ts [rowsPerDay=60] [days=30] [paths=600]
 *
 * Row model: entry price p ~ U(0.25, 0.75); taker fee 0.07 p(1-p); the side wins with probability p + fee + edge,
 * so the expected net per contract is exactly `edge`. Rows in one 15-minute window share a draw with probability
 * 0.5 (the coins move together), which is what makes day-clustering matter. A scale-up doubles the contracts and
 * restarts the evidence, as production does; a stop ends the path. Nothing here reads or writes app state.
 */
import { CHECKPOINT_TRADES, clusteredMean, decideStage } from '../src/main/ladder/ladder'

const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number) // the runner passes this file's path first
const rowsPerDay = nums[0] ?? 60
const days = nums[1] ?? 30
const paths = nums[2] ?? 600
const NO_SIGN_STOP = process.argv.includes('nosign')

let seed = 20260919
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}

interface Out { stopped: boolean; stopDay: number; scaled: number; dollars: number; reason: string }

function onePath(edgeCents: number): Out {
  let notch = 1
  let lastCheckpoint = 0
  let rows: { v: number; g: string }[] = []
  let dollars = 0
  let scaled = 0
  for (let d = 0; d < days; d++) {
    for (let w = 0; w < rowsPerDay / 3; w++) {
      const common = rnd()
      for (let k = 0; k < 3; k++) {
        const p = 0.25 + 0.5 * rnd()
        const fee = 0.07 * p * (1 - p)
        const q = Math.min(0.999, Math.max(0.001, p + fee + edgeCents / 100))
        const u = rnd() < 0.5 ? common : rnd()
        const net = (u < q ? 1 - p : -p) - fee
        const v = net * notch
        dollars += v
        rows.push({ v, g: 'd' + d })
        if (rows.length % CHECKPOINT_TRADES !== 0) continue
        const ci = clusteredMean(rows)
        const dec = decideStage({ n: rows.length, netDollars: rows.reduce((a, r) => a + r.v, 0), mean: ci.mean, se: ci.se, sd: ci.sd, clusters: ci.groups, unit: '$', stake: 0.5 * notch }, notch, lastCheckpoint)
        lastCheckpoint = dec.checkpoint
        // Variant `nosign`: what the rule would do WITHOUT the unclustered 100-trade sign stop (band and hard stop only).
        if (dec.kind === 'stop' && NO_SIGN_STOP && /trades and net not positive/.test(dec.reason)) continue
        if (dec.kind === 'stop') return { stopped: true, stopDay: d + 1, scaled, dollars, reason: /hit the -\$/.test(dec.reason) ? 'hard stop' : /trades and net not positive/.test(dec.reason) ? '100-trade rule' : 'band' }
        if (dec.kind === 'scale-up') { notch *= 2; scaled++; rows = []; lastCheckpoint = 0 }
      }
    }
  }
  return { stopped: false, stopDay: days, scaled, dollars, reason: '' }
}

const pct = (x: number): string => (100 * x).toFixed(0).padStart(3) + '%'
console.log(`ladder power${NO_SIGN_STOP ? ' (variant: no 100-trade sign stop)' : ''}: ${rowsPerDay} settled rows/day, ${days} days, ${paths} paths per edge, judged every ${CHECKPOINT_TRADES} rows`)
console.log('true edge   stopped<=7d  <=14d  <=' + days + 'd   by: hard/100-rule/band   ever scaled up   mean $ at end   mean $ | stopped')
for (const edge of [-2, 0, 1.5, 3, 5, 9]) {
  const out = Array.from({ length: paths }, () => onePath(edge))
  const st = out.filter((o) => o.stopped)
  const by = (r: string): number => st.filter((o) => o.reason === r).length / paths
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  console.log(
    `${(edge >= 0 ? '+' : '') + edge.toFixed(1)}c`.padEnd(10) +
      `  ${pct(st.filter((o) => o.stopDay <= 7).length / paths)}       ${pct(st.filter((o) => o.stopDay <= 14).length / paths)}   ${pct(st.length / paths)}     ` +
      `${pct(by('hard stop'))} /${pct(by('100-trade rule'))} /${pct(by('band'))}        ${pct(out.filter((o) => o.scaled > 0).length / paths)}            ` +
      `${mean(out.map((o) => o.dollars)).toFixed(2).padStart(7)}        ${mean(st.map((o) => o.dollars)).toFixed(2).padStart(7)}`
  )
}
