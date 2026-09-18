import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const file = join(process.env.APPDATA || '', 'oracle-trader', 'mini-auto-polymarket-us.json-research.jsonl')
if (!existsSync(file)) {
  console.log('No Polymarket US micro-maker research log yet.')
  process.exit(0)
}
const rows = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)] } catch { return [] }
}).filter((x) => x.strategy === 'micro-maker')
const rests = rows.filter((x) => x.type === 'resting')
const fills = rows.filter((x) => x.type === 'fill')
const expired = rows.filter((x) => x.type === 'expired-unfilled')
const closed = rows.filter((x) => x.type === 'closed' && Number.isFinite(x.pnl))
const pnl = closed.reduce((s, x) => s + x.pnl, 0)
const contracts = closed.reduce((s, x) => s + (Number(x.shares) || 0), 0)
const byMarket = new Map()
for (const x of closed) {
  const key = x.marketId || 'unknown'
  byMarket.set(key, (byMarket.get(key) || 0) + x.pnl)
}
const vals = [...byMarket.values()]
const mean = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0
const variance = vals.length > 1 ? vals.reduce((s,x)=>s+(x-mean)**2,0)/(vals.length-1) : 0
const se = vals.length ? Math.sqrt(variance/vals.length) : 0
const lo = mean - 1.96*se
const hi = mean + 1.96*se
console.log(`POLY US MICRO-MAKER: rests ${rests.length}, fills ${fills.length}, expired ${expired.length}, closed ${closed.length} across ${vals.length} markets`)
console.log(`fill rate (completed quote outcomes only): ${fills.length + expired.length ? (100*fills.length/(fills.length+expired.length)).toFixed(1) : 'n/a'}%`)
console.log(`realized P&L $${pnl.toFixed(2)}; ${contracts ? (100*pnl/contracts).toFixed(2) : 'n/a'}c/contract`)
console.log(`market-clustered mean $${mean.toFixed(3)} CI95 [$${lo.toFixed(3)}, $${hi.toFixed(3)}]`)
console.log('GATE: >=100 fills, >=50 closed markets, positive realized P&L, market-clustered lower bound > $0')
console.log(`RESULT: ${fills.length>=100 && vals.length>=50 && pnl>0 && lo>0 ? 'PASS' : 'FAIL / NOT YET'}`)
