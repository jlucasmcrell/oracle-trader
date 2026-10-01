/**
 * Read-only: print every ForecastEx lab arm's `gateBlockers` and `liveEligible`, the two figures registered
 * reads 191 (the IBKR fade gate) and 110 (first live IBKR order) are judged on.
 *
 *     npx tsx scripts/ibkr-lab-gate.ts [--json]
 *
 * Written 2026-10-01 because those registrations say "ibkr-lab status gateBlockers" and no such CLI existed: the
 * figures are only computed inside `IbkrLab.status()` (src/main/strategies/ibkrLab.ts:95-137), which needs a live
 * engine and venue. This reads `%APPDATA%/oracle-trader/ibkr-lab.json` and replays the SAME arithmetic on it.
 *
 * It imports every threshold and every arm list from the source of record rather than copying them, so the one
 * thing that can drift is the twelve lines of arithmetic below. Two deliberate differences from status(), both
 * stated because they bound what this tool may be used for:
 *   - `unrealized`/`unpriced` are not computed (they need live quotes and a slippage constant and no gate reads them).
 *   - `no usable dispersion` is reported from the same `se` test, but se here is computed from the file's closed
 *     trades only, exactly as status() does; open positions never enter the band in either place.
 * Nothing is written and nothing is sent.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IBKR_RETIRED, IBKR_STRATEGIES, IBKR_UNAVAILABLE, ibkrHoldsToSettlement } from '../src/main/strategies/ibkrSignals'
import { IBKR_LOSS_WAIVER_TRADES, IBKR_MIN_LOSSES } from '../src/main/strategies/ibkrLab'
import { IBKR_RULES_SINCE } from '../src/shared/ibkrLab'

interface Trade { strategy: string; marketId: string; quantity: number; net: number; openedAt: number; closedAt: number }
interface LabFile { config: { enabled: boolean; mode: string; liveStrategies: string[] }; scans: number; lastScanAt: number; lastError?: string | null; trades: Trade[]; positions: { strategy: string }[]; orders: { strategy: string }[] }

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const round = (n: number): number => Math.round(n * 100) / 100

const file = join(process.env.APPDATA!, 'oracle-trader', 'ibkr-lab.json')
const s: LabFile = JSON.parse(readFileSync(file, 'utf8'))

const rows = IBKR_STRATEGIES.map((def) => {
  // Mirrors src/main/strategies/ibkrLab.ts:95-137.
  const all = s.trades.filter((t) => t.strategy === def.id)
  const trades = all.filter((t) => t.openedAt >= IBKR_RULES_SINCE)
  const legacy = all.filter((t) => t.openedAt < IBKR_RULES_SINCE)
  const positions = s.positions.filter((p) => p.strategy === def.id)
  const pending = s.orders.filter((o) => o.strategy === def.id).length
  const stop = IBKR_RETIRED.get(def.id)

  const days = new Map<string, { n: number; sum: number }>()
  for (const t of trades) {
    const key = day(t.closedAt)
    const v = days.get(key) ?? { n: 0, sum: 0 }
    v.n += t.quantity
    v.sum += t.net
    days.set(key, v)
  }
  const groups = [...days.values()]
  const N = groups.reduce((a, g) => a + g.n, 0)
  const mean = N ? groups.reduce((a, g) => a + g.sum, 0) / N : 0
  const se = groups.length > 1 && N > 0
    ? Math.sqrt((groups.length / (groups.length - 1)) * groups.reduce((a, g) => a + (g.sum - g.n * mean) ** 2, 0)) / N
    : Infinity
  const G = groups.length
  const critical = G <= 2 ? 12.706 : G === 3 ? 4.303 : G <= 5 ? 3.182 : G <= 10 ? 2.776 : G <= 30 ? 2.262 : 1.96
  const confidenceLow = Number.isFinite(se) ? mean - critical * se : undefined

  const events = new Set(trades.map((t) => t.marketId.split('_').slice(0, -1).join('_'))).size
  const wins = trades.filter((t) => t.net > 0).length
  const losses = trades.filter((t) => t.net < 0).length
  const held = ibkrHoldsToSettlement(def.id)
  const sampled = !held || losses >= IBKR_MIN_LOSSES || trades.length >= IBKR_LOSS_WAIVER_TRADES

  const gateBlockers: string[] = []
  if (stop) gateBlockers.push(stop)
  if (def.id === 'benchmark' || def.id === 'settle-control') gateBlockers.push('control arm: never promoted')
  if (trades.length < 30) gateBlockers.push(`${trades.length}/30 closed`)
  if (events < 10) gateBlockers.push(`${events}/10 events`)
  if (days.size < 3) gateBlockers.push(`${days.size}/3 day-clusters`)
  if (!sampled) gateBlockers.push(`${losses}/${IBKR_MIN_LOSSES} losses sampled (or ${trades.length}/${IBKR_LOSS_WAIVER_TRADES} trades)`)
  if (!(se > 0) || !Number.isFinite(se)) gateBlockers.push('no usable dispersion')
  if (!((confidenceLow ?? -1) > 0)) gateBlockers.push(`lower bound ${confidenceLow === undefined ? 'unavailable' : (100 * confidenceLow).toFixed(2) + 'c'}`)

  return {
    // Widened: the unavailable arms below are a disjoint id union and share this row shape.
    id: def.id as string,
    held,
    closed: trades.length,
    wins,
    losses,
    contracts: N,
    net: round(trades.reduce((a, t) => a + t.net, 0)),
    events,
    days: days.size,
    open: positions.length,
    pending,
    legacyClosed: legacy.length,
    meanCents: N ? round(100 * mean) : null,
    lowCents: confidenceLow === undefined ? null : round(100 * confidenceLow),
    gateBlockers,
    liveEligible: gateBlockers.length === 0,
  }
})
for (const def of IBKR_UNAVAILABLE) {
  rows.push({ id: def.id, held: false, closed: 0, wins: 0, losses: 0, contracts: 0, net: 0, events: 0, days: 0, open: 0, pending: 0, legacyClosed: 0, meanCents: null, lowCents: null, gateBlockers: ['not available on this venue'], liveEligible: false })
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ at: new Date().toISOString(), rulesSince: new Date(IBKR_RULES_SINCE).toISOString(), config: s.config, scans: s.scans, lastScanAt: new Date(s.lastScanAt).toISOString(), lastError: s.lastError ?? null, rows }, null, 1))
} else {
  console.log(`FORECASTEX LAB GATE — ${file}`)
  console.log(`mode ${s.config.mode}, enabled ${s.config.enabled}, liveStrategies [${s.config.liveStrategies.join(', ')}], scans ${s.scans}, lastScanAt ${new Date(s.lastScanAt).toISOString()}, lastError ${s.lastError ?? '(none)'}`)
  console.log(`current-rule cohort opened at/after IBKR_RULES_SINCE = ${new Date(IBKR_RULES_SINCE).toISOString()}`)
  console.log('')
  console.log('arm                   closed  W/L     ct    net $   evts  days   mean c   low c   gate')
  for (const r of rows) {
    if (r.gateBlockers[0] === 'not available on this venue') continue
    const label = `${r.id}${r.held ? '*' : ''}`.padEnd(21)
    const g = r.liveEligible ? 'ELIGIBLE' : r.gateBlockers.map((b) => (b.length > 60 ? b.slice(0, 57) + '...' : b)).join('; ')
    console.log(`${label} ${String(r.closed).padStart(5)}  ${(r.wins + '/' + r.losses).padStart(6)} ${String(r.contracts).padStart(5)} ${r.net.toFixed(2).padStart(8)} ${String(r.events).padStart(5)} ${String(r.days).padStart(5)} ${(r.meanCents === null ? '-' : r.meanCents.toFixed(2)).padStart(8)} ${(r.lowCents === null ? '-' : r.lowCents.toFixed(2)).padStart(7)}   ${g}`)
  }
  console.log('')
  console.log('* holds to settlement, so it carries the 15-sampled-losses-or-250-closes bar (read 191).')
  const eligible = rows.filter((r) => r.liveEligible)
  console.log(`READ 110: ${eligible.length ? 'arms with NO gateBlockers: ' + eligible.map((r) => r.id).join(', ') : 'no arm has zero gateBlockers.'}`)
  const fade = rows.find((r) => r.id === 'fade')!
  console.log(`READ 191 (fade): ${fade.closed} closed, ${fade.losses} losses (bar ${IBKR_MIN_LOSSES} sampled losses or ${IBKR_LOSS_WAIVER_TRADES} closes), ${fade.events} events, ${fade.days} day-clusters, mean ${fade.meanCents === null ? '-' : fade.meanCents.toFixed(2) + 'c'}, lower bound ${fade.lowCents === null ? 'unavailable' : fade.lowCents.toFixed(2) + 'c'} -> ${fade.liveEligible ? 'QUALIFIES' : 'does not qualify'}`)
  console.log(`GATE_JSON ${JSON.stringify({ read191: { closed: fade.closed, losses: fade.losses, events: fade.events, days: fade.days, meanCents: fade.meanCents, lowCents: fade.lowCents, qualifies: fade.liveEligible }, read110: { eligible: eligible.map((r) => r.id) } })}`)
}
