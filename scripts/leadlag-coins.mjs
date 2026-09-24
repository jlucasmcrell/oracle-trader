#!/usr/bin/env node
/**
 * Per-coin grading for the lead-lag arm, from the venue ledger.
 *
 * WHY THIS EXISTS (2026-09-13). Round 91 widened lead-lag from BTC/ETH to seven coins and cut the poll
 * to 10 s. The ladder tracks the whole arm as ONE strategy (`kalshi-leadlag` in GENERIC_STRATEGIES), so
 * five untested coins now settle into the same pooled verdict that promoted BTC/ETH to notch x4. A pool
 * cannot stop a subset: if the new coins are negative and BTC/ETH carries the average, the arm keeps
 * trading them and the ladder never sees it. This script is the missing measurement - it does not trade,
 * size or gate anything, it just says what each coin has actually done at the venue.
 *
 * LEDGER OF RECORD. Kalshi settlements, netted the way scripts/venue-pnl.py nets them:
 *
 *     net = revenue/100 + min(yes_count, no_count) - yes_cost - no_cost - fees
 *
 * The `min(...)` term is the part the obvious formula gets wrong: offsetting YES/NO in the same market is
 * netted by the exchange at $1 a pair when it happens, so that dollar never appears in `revenue`.
 *
 * ATTRIBUTION. The KX<COIN>15M series are traded by the lead-lag sweep and nothing else, so a settlement
 * in those series is this arm's. That assumption is CHECKED, not assumed: --check joins the executed rows
 * of leadlag-dislocations.jsonl and reports contracts-per-coin from both sides. If they diverge, some
 * other path is trading these series and the per-coin numbers below are not attributable.
 *
 * Usage:
 *   node scripts/leadlag-coins.mjs [dump.json] [--since ISO] [--check] [--json]
 *
 * Default dump: the newest tmp/k-*.json OR tmp/kalshi-*.json. Default --since: the round-91 go-live (see EXPANSION_AT).
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const APPDATA = join(process.env.APPDATA ?? '', 'oracle-trader')

/** Round 91's restart: the first moment the five new coins could trade. */
const EXPANSION_AT = '2026-09-13T10:05:00Z'
/** The two coins that earned the arm's promotions; everything else is new as of EXPANSION_AT. */
const ESTABLISHED = new Set(['BTC', 'ETH'])

// ---- the coin list, read from the live source so this can never drift from what the app trades ----
function coins() {
  const src = readFileSync(join(REPO, 'src/main/strategies/leadLag.ts'), 'utf8')
  const m = /export const LEADLAG_COINS = \[([^\]]*)\]/.exec(src)
  // Fail loudly. A private copy of the coin list that silently goes stale is exactly the drift this
  // script exists to catch, so there is deliberately no fallback array here.
  if (!m) throw new Error('could not read LEADLAG_COINS from src/main/strategies/leadLag.ts')
  const out = [...m[1].matchAll(/'([A-Z0-9]+)'/g)].map((x) => x[1])
  if (!out.length) throw new Error('LEADLAG_COINS parsed empty from src/main/strategies/leadLag.ts')
  return out
}

const num = (x) => {
  const v = typeof x === 'number' ? x : parseFloat(x ?? '0')
  return Number.isFinite(v) ? v : 0
}

/** Venue-true net for one Kalshi settlement row, including exchange-netted pairs. */
function settlementNet(s) {
  const y = num(s.yes_count_fp ?? s.yes_count)
  const n = num(s.no_count_fp ?? s.no_count)
  return num(s.revenue) / 100 + Math.min(y, n) - num(s.yes_total_cost_dollars) - num(s.no_total_cost_dollars) - num(s.fee_cost)
}

/** Contracts at risk in one settlement: the larger leg, since a netted pair was never exposed. */
const settlementContracts = (s) => Math.max(num(s.yes_count_fp ?? s.yes_count), num(s.no_count_fp ?? s.no_count))

/**
 * Cluster-robust 95% interval on cents per contract, t on G-1 df (the round-73 correction: a normal z
 * on five or six day-clusters reads far too narrow). Returns nulls below two clusters rather than a
 * zero-width band, because a band that cannot exclude zero must not LOOK like one that does.
 */
const T95 = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131 }
function clustered(rows, keyOf) {
  const contracts = rows.reduce((a, r) => a + r.contracts, 0)
  const net = rows.reduce((a, r) => a + r.net, 0)
  if (!(contracts > 0)) return { n: 0, contracts: 0, mean: 0, lo: null, hi: null, clusters: 0 }
  const mean = (net / contracts) * 100 // cents per contract
  const by = new Map()
  for (const r of rows) {
    const k = keyOf(r)
    by.set(k, (by.get(k) ?? []).concat([r]))
  }
  const G = by.size
  if (G < 2) return { n: rows.length, contracts, mean, lo: null, hi: null, clusters: G }
  // Each cluster contributes the sum of its per-contract residuals; the mean is contract-weighted.
  let ss = 0
  for (const group of by.values()) {
    let t = 0
    for (const r of group) t += r.net * 100 - mean * r.contracts
    ss += t * t
  }
  const se = Math.sqrt((ss * G) / ((G - 1) * contracts * contracts))
  const tc = T95[G - 1] ?? 1.96
  return { n: rows.length, contracts, mean, lo: mean - tc * se, hi: mean + tc * se, clusters: G }
}

// ---- selftest ----
// Every case here is a bug this script actually had on 2026-09-13, plus the netting formula it exists
// to apply. Run it before trusting a reading: `node scripts/leadlag-coins.mjs --selftest`.
function selftest() {
  const fails = []
  const ok = (cond, what) => { if (!cond) fails.push(what) }
  const approx = (a, b) => Math.abs(a - b) < 1e-6

  // The netting formula, against a real row: exchange-netted YES/NO pairs never appear in `revenue`.
  // KXHYPE15M-26SEP130645-45 settled `no` holding 8 YES @$2.32 and 8 NO @$5.76 with revenue 0.
  // revenue - costs reads -$8.31; the truth (venue-pnl.py and the ledger) is -$0.31.
  const paired = { revenue: 0, yes_count_fp: '8.00', no_count_fp: '8.00', yes_total_cost_dollars: '2.320000', no_total_cost_dollars: '5.760000', fee_cost: '0.230000' }
  ok(approx(+settlementNet(paired).toFixed(2), -0.31), `netted pair: got ${settlementNet(paired).toFixed(2)}, want -0.31`)
  ok(settlementContracts(paired) === 8, 'a netted pair risked 8 contracts, not 16')
  // An ordinary one-sided win: 8 NO @$4.24, result no, revenue $8.00, fee $0.14 -> +$3.62.
  const plain = { revenue: 800, yes_count_fp: '0.00', no_count_fp: '8.00', yes_total_cost_dollars: '0.000000', no_total_cost_dollars: '4.240000', fee_cost: '0.140000' }
  ok(approx(+settlementNet(plain).toFixed(2), 3.62), `one-sided: got ${settlementNet(plain).toFixed(2)}, want 3.62`)

  // The coin list is read from the live source, never copied.
  const cs = coins()
  ok(cs.includes('BTC') && cs.includes('HYPE') && cs.length >= 2, `LEADLAG_COINS parsed: ${cs.join(',')}`)

  // A single day-cluster must yield NO interval, not a zero-width one that looks decisive.
  const oneDay = [{ day: 'd1', net: -1, contracts: 10 }, { day: 'd1', net: 2, contracts: 10 }]
  ok(clustered(oneDay, (r) => r.day).lo === null, 'one cluster must not produce an interval')
  const twoDay = [{ day: 'd1', net: -1, contracts: 10 }, { day: 'd2', net: 2, contracts: 10 }]
  ok(clustered(twoDay, (r) => r.day).lo !== null, 'two clusters must produce an interval')
  ok(approx(clustered(twoDay, (r) => r.day).mean, 5), 'mean is contract-weighted cents')
  ok(clustered([], (r) => r.day).contracts === 0, 'empty input must not throw')

  // The dump picker sorts by mtime. Lexicographic sort put k-20260909.json after k-2026-09-13.json
  // ('-' < '9') and the whole report came back empty and cheerful.
  ok('k-2026-09-13.json'.localeCompare('k-20260909.json') < 0, 'the name sort really is wrong (guards the comment above)')

  // With no --since, args[sinceIdx + 1] is args[0]: the explicit dump path was being discarded.
  const pick = (argv) => { const i = argv.indexOf('--since'); const v = i >= 0 ? argv[i + 1] : undefined; return argv.find((a) => !a.startsWith('--') && a !== v) }
  ok(pick(['tmp/k.json', '--check']) === 'tmp/k.json', 'explicit dump path survives with no --since')
  ok(pick(['tmp/k.json', '--since', '2026-01-01T00:00:00Z']) === 'tmp/k.json', 'explicit dump path survives with --since')
  ok(pick(['--since', '2026-01-01T00:00:00Z']) === undefined, '--since value is not mistaken for a dump path')

  console.log(`selftest: ${11 - fails.length} passed, ${fails.length} failed` + (fails.length ? ' -> ' + JSON.stringify(fails, null, 1) : ''))
  return fails.length ? 1 : 0
}
if (process.argv.includes('--selftest')) process.exit(selftest())

// ---- inputs ----
const args = process.argv.slice(2)
const wantJson = args.includes('--json')
const wantCheck = args.includes('--check')
const sinceIdx = args.indexOf('--since')
const since = sinceIdx >= 0 ? args[sinceIdx + 1] ?? EXPANSION_AT : EXPANSION_AT
// Guard the index: with no --since, sinceIdx is -1 and `args[sinceIdx + 1]` is args[0], which silently
// threw away an explicitly given dump path and read the newest one instead.
const sinceValue = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined
let dumpPath = args.find((a) => !a.startsWith('--') && a !== sinceValue)
if (!dumpPath) {
  const tmp = join(REPO, 'tmp')
  // By MTIME, not by name. Sorting the names picked k-20260909.json over k-2026-09-13.json ('-' < '9')
  // and the whole report came back empty and cheerful.
  // Both prefixes: the maintenance session writes tmp/kalshi-<date>.json, which /^k-/ does not match, so on
  // 2026-09-24 this read graded against a dump from 09-18 and reported 0 settlements as "NOT YET (collecting)".
  const cands = existsSync(tmp) ? readdirSync(tmp).filter((f) => /^(k|kalshi)-.*\.json$/.test(f)).map((f) => join(tmp, f)) : []
  if (!cands.length) throw new Error('no dump given and no tmp/k-*.json or tmp/kalshi-*.json found; run scripts/readonly-kalshi-dump.cjs first')
  dumpPath = cands.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).pop()
}

const dump = JSON.parse(readFileSync(dumpPath, 'utf8'))
const COINS = coins()
const seriesOf = new Map(COINS.map((c) => [`KX${c}15M`, c]))

const rows = []
for (const s of dump.settlements ?? []) {
  const coin = seriesOf.get(String(s.ticker ?? '').split('-')[0])
  if (!coin) continue
  const at = s.settled_time ?? ''
  if (at < since) continue
  rows.push({ coin, at, day: at.slice(0, 10), net: settlementNet(s), contracts: settlementContracts(s), fee: num(s.fee_cost), ticker: s.ticker })
}
rows.sort((a, b) => a.at.localeCompare(b.at))

console.log(`LEAD-LAG BY COIN — ${dumpPath.split(/[\\/]/).pop()}, settlements at/after ${since}`)
console.log(`coins from LEADLAG_COINS: ${COINS.join(' ')} | ${rows.length} settlements, ${rows.reduce((a, r) => a + r.contracts, 0)} contracts\n`)

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)
console.log(`  ${pad('coin', 6)} ${padL('mkts', 5)} ${padL('contracts', 10)} ${padL('net $', 9)} ${padL('fees $', 8)} ${padL('c/contract', 11)}  day-clustered 95%`)
const perCoin = {}
for (const coin of COINS) {
  const rs = rows.filter((r) => r.coin === coin)
  if (!rs.length) {
    console.log(`  ${pad(coin, 6)} ${padL(0, 5)} ${padL(0, 10)} ${padL('-', 9)} ${padL('-', 8)} ${padL('-', 11)}  no settlements in window`)
    perCoin[coin] = { n: 0, contracts: 0, net: 0, mean: null, lo: null, hi: null, clusters: 0, established: ESTABLISHED.has(coin) }
    continue
  }
  const c = clustered(rs, (r) => r.day)
  const net = rs.reduce((a, r) => a + r.net, 0)
  const fees = rs.reduce((a, r) => a + r.fee, 0)
  const band = c.lo === null ? `(${c.clusters} day-cluster: no interval)` : `[${c.lo.toFixed(2)}, ${c.hi.toFixed(2)}]`
  console.log(`  ${pad(coin, 6)} ${padL(rs.length, 5)} ${padL(c.contracts, 10)} ${padL(net.toFixed(2), 9)} ${padL(fees.toFixed(2), 8)} ${padL(c.mean.toFixed(2), 11)}  ${band}${ESTABLISHED.has(coin) ? '' : '   NEW'}`)
  perCoin[coin] = { n: rs.length, contracts: c.contracts, net: +net.toFixed(4), mean: +c.mean.toFixed(3), lo: c.lo === null ? null : +c.lo.toFixed(3), hi: c.hi === null ? null : +c.hi.toFixed(3), clusters: c.clusters, established: ESTABLISHED.has(coin) }
}

// ---- the comparison the pooled ladder verdict cannot make ----
const est = rows.filter((r) => ESTABLISHED.has(r.coin))
const nw = rows.filter((r) => !ESTABLISHED.has(r.coin))
const cEst = clustered(est, (r) => r.day)
const cNew = clustered(nw, (r) => r.day)
const line = (label, c, rs) => {
  const net = rs.reduce((a, r) => a + r.net, 0)
  const band = c.lo === null ? `(${c.clusters} day-cluster: no interval)` : `95% [${c.lo.toFixed(2)}, ${c.hi.toFixed(2)}]`
  console.log(`  ${pad(label, 22)} ${padL(rs.length, 4)} mkts ${padL(c.contracts, 5)} contracts  net $${padL(net.toFixed(2), 8)}  ${padL(c.mean.toFixed(2), 7)}c/contract  ${band}`)
}
console.log(`\nPOOLED vs SPLIT (the ladder judges only the first line of these three):`)
line('all coins (pooled)', clustered(rows, (r) => r.day), rows)
line('BTC/ETH (established)', cEst, est)
line('new coins (not BTC/ETH)', cNew, nw)

// ---- pre-registered stop, written 2026-09-13, judged by a later session ----
const MIN_CONTRACTS = 400
const MIN_DAYS = 5
const stopReady = cNew.contracts >= MIN_CONTRACTS && cNew.clusters >= MIN_DAYS
const stopFires = stopReady && cNew.hi !== null && cNew.hi < 0
const scaleReady = stopReady && cNew.lo !== null && cNew.lo > 0
console.log(`\nSTOP RULE for the five new coins (pre-registered 2026-09-13, docs/PREREGISTERED-leadlag-coins.md):`)
console.log(`  [${cNew.contracts >= MIN_CONTRACTS ? 'x' : ' '}] >= ${MIN_CONTRACTS} contracts settled on the new coins   (${cNew.contracts})`)
console.log(`  [${cNew.clusters >= MIN_DAYS ? 'x' : ' '}] >= ${MIN_DAYS} day-clusters                        (${cNew.clusters})`)
console.log(`  [${stopFires ? 'x' : ' '}] day-clustered UPPER bound < 0 -> narrow the coin list back to BTC/ETH`)
console.log(`  [${scaleReady ? 'x' : ' '}] day-clustered LOWER bound > 0 -> the expansion is earning; leave it`)
console.log(`RESULT: ${!stopReady ? 'NOT YET (collecting)' : stopFires ? 'STOP — narrow to BTC/ETH' : scaleReady ? 'KEEP — expansion earning' : 'UNDECIDED — neither bound clears zero'}`)

// ---- attribution check: does the arm's own ledger agree on contracts per coin? ----
let check = null
if (wantCheck) {
  const p = join(APPDATA, 'leadlag-dislocations.jsonl')
  console.log(`\nATTRIBUTION CHECK vs ${p}`)
  if (!existsSync(p)) {
    console.log('  ledger not found — per-coin attribution UNVERIFIED')
  } else {
    const filled = {}
    for (const l of readFileSync(p, 'utf8').split('\n')) {
      if (!l.trim()) continue
      let r
      try { r = JSON.parse(l) } catch { continue }
      if (!r.executed || !(r.filledContracts > 0)) continue
      if ((r.ts ?? '') < since) continue
      const coin = seriesOf.get(String(r.kalshiTicker ?? '').split('-')[0])
      if (!coin) continue
      filled[coin] = (filled[coin] ?? 0) + r.filledContracts
    }
    check = { sweepFills: filled, settled: {} }
    let agree = true
    for (const coin of COINS) {
      const s = perCoin[coin].contracts
      const f = filled[coin] ?? 0
      check.settled[coin] = s
      // Open positions make settled <= filled; settled ABOVE filled means another path traded the series.
      const bad = s > f
      if (bad) agree = false
      console.log(`  ${pad(coin, 6)} sweep-filled ${padL(f, 5)}   settled ${padL(s, 5)}${bad ? '   <-- settled exceeds the sweep ledger: ANOTHER PATH IS TRADING THIS SERIES' : ''}`)
    }
    // A check with nothing to compare is not a passing check. The first run of this script read a stale
    // dump, compared 0 settled against 274 fills and printed "attribution holds" - vacuously true and
    // completely wrong. Require something on BOTH sides before the word OK is allowed.
    const settledTotal = COINS.reduce((a, c) => a + perCoin[c].contracts, 0)
    const filledTotal = COINS.reduce((a, c) => a + (filled[c] ?? 0), 0)
    check.agree = agree && settledTotal > 0 && filledTotal > 0
    check.settledTotal = settledTotal
    check.filledTotal = filledTotal
    console.log(
      settledTotal === 0 || filledTotal === 0
        ? `  INCONCLUSIVE — ${settledTotal} contracts settled against ${filledTotal} sweep fills in this window; nothing to compare.`
        : agree
          ? '  OK — every coin settled no more than the sweep filled; attribution holds.'
          : '  MISMATCH — the per-coin numbers above are NOT attributable to lead-lag alone.'
    )
  }
}

if (wantJson) {
  console.log('COINS_JSON ' + JSON.stringify({
    since, dump: dumpPath.split(/[\\/]/).pop(), settlements: rows.length,
    pooled: { contracts: clustered(rows, (r) => r.day).contracts, mean: +clustered(rows, (r) => r.day).mean.toFixed(3) },
    established: { contracts: cEst.contracts, mean: +cEst.mean.toFixed(3), lo: cEst.lo === null ? null : +cEst.lo.toFixed(3), hi: cEst.hi === null ? null : +cEst.hi.toFixed(3), days: cEst.clusters },
    newCoins: { contracts: cNew.contracts, mean: +cNew.mean.toFixed(3), lo: cNew.lo === null ? null : +cNew.lo.toFixed(3), hi: cNew.hi === null ? null : +cNew.hi.toFixed(3), days: cNew.clusters },
    perCoin, stop: { minContracts: MIN_CONTRACTS, minDays: MIN_DAYS, ready: stopReady, fires: stopFires, scaleReady }, check
  }))
}
