// Read for docs/PREREGISTERED-newmarket-bid.md. READ-ONLY: the recorder's books and tape, and public Kalshi results.
//
//   node scripts/newmarket-gate.mjs [--dir data/newmarkets] [--verdict]
//
// Unit: one market. In its first 60 minutes, the first book row where one side's best ask is 88-95c: a paper
// post-only bid for ONE contract on the other side at 100 minus that ask, i.e. joining the best bid that is already
// there, behind all of its displayed size. It is cancelled 60 minutes after the market opened.
// A fill counts only when later prints (a) trade THROUGH our price, or (b) trade AT our price for more than the
// size that was displayed ahead of us. Held to settlement, after the maker fee where the series charges one
// (rounded up to a whole cent). 90% band clustered on the New York day.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './lib/repo-root.mjs'
import { band } from './lategame-gate.mjs'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const DIR = arg('--dir', join(REPO, 'data', 'newmarkets'))
const READ_ON = Date.parse('2026-11-27T00:00:00Z'), LAST = Date.parse('2026-12-18T00:00:00Z')
const MIN_N = 50, MIN_DAYS = 10, MIN_MEAN = 2, LO = 0.88, HI = 0.95, HOUR = 3600_000
const CACHE = join(DIR, 'results.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nyDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const jsonl = (f) => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : []
/** Maker fee for one contract, in cents: zero unless the series charges makers, then 1.75 p(1-p) x multiplier, rounded up. */
export const makerFee1 = (p, feeType, mult) => /maker/.test(feeType ?? '') ? Math.ceil(1.75 * (mult ?? 1) * p * (1 - p) - 1e-9) : 0

/** The paper order a book row calls for, or null: { side, px (what we bid), ahead (size displayed at that price) }. */
export function orderOf(r) {
  const yesAsk = r.nb != null ? +(1 - r.nb).toFixed(4) : null, noAsk = r.yb != null ? +(1 - r.yb).toFixed(4) : null
  if (yesAsk != null && yesAsk >= LO && yesAsk <= HI) return { side: 'no', px: r.nb, ahead: r.nbs }
  if (noAsk != null && noAsk >= LO && noAsk <= HI) return { side: 'yes', px: r.yb, ahead: r.ybs }
  return null
}

/** Whether prints after `fromMs` and up to `untilMs` fill one contract resting at `o`. Trades: {ts, yes, n, side}. */
export function filled(o, trades, fromMs, untilMs) {
  let at = 0
  for (const x of trades) {
    const ts = Date.parse(x.ts)
    if (!(ts > fromMs && ts <= untilMs) || x.side === o.side) continue   // only takers buying the other side hit our bid
    const ours = o.side === 'yes' ? x.yes : +(1 - x.yes).toFixed(4)       // the print's price on OUR side
    if (ours < o.px - 1e-9) return true                                   // through us
    if (Math.abs(ours - o.px) < 1e-9 && (at += x.n) > o.ahead + 1 - 1e-9) return true
  }
  return false
}

if (process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('scripts/newmarket-gate.mjs')) {
  mkdirSync(DIR, { recursive: true })
  const meta = new Map(jsonl(join(DIR, 'markets.jsonl')).map((m) => [m.t, m]))
  const files = readdirSync(DIR)
  const orders = new Map()
  for (const f of files.filter((f) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort()) for (const r of jsonl(join(DIR, f))) {
    const m = meta.get(r.t)
    if (!m || orders.has(r.t) || Date.parse(r.ts) > Date.parse(m.open) + HOUR) continue
    const o = orderOf(r)
    if (o && o.px > 0) orders.set(r.t, { ...o, ts: r.ts, m })
  }
  const tape = new Map()
  for (const f of files.filter((f) => /^trades-.*\.jsonl$/.test(f))) for (const x of jsonl(join(DIR, f))) { if (!tape.has(x.t)) tape.set(x.t, []); tape.get(x.t).push(x) }
  const fills = [...orders.entries()].filter(([t, o]) => filled(o, tape.get(t) ?? [], Date.parse(o.ts), Date.parse(o.m.open) + HOUR))
  const res = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}
  for (const [t] of fills) {
    if (res[t]) continue
    const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${t}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
    const j = r?.ok ? await r.json() : null
    if (j?.market?.result === 'yes' || j?.market?.result === 'no') res[t] = j.market.result
    await sleep(120)
  }
  writeFileSync(CACHE, JSON.stringify(res))
  const units = fills.filter(([t]) => res[t]).map(([t, o]) => ({ day: nyDay(o.ts), cat: o.m.cat, c: 100 * ((res[t] === o.side ? 1 : 0) - o.px) - makerFee1(o.px, o.m.fee, o.m.mult) }))
  const b = band(units)
  let v = 'WAIT'
  if (Date.now() >= READ_ON && b.n >= MIN_N && b.days >= MIN_DAYS) v = b.lo > 0 && b.mean >= MIN_MEAN ? 'PASS' : b.mean < MIN_MEAN ? 'FAIL' : Date.now() >= LAST ? 'INCONCLUSIVE' : 'CONTINUE'
  else if (Date.now() >= LAST) v = 'INCONCLUSIVE'
  console.log(`${meta.size} markets tracked, ${orders.size} paper bids, ${fills.length} filled (${orders.size ? (100 * fills.length / orders.size).toFixed(1) : 0}%), ${fills.length - units.length} unsettled`)
  console.log(`filled n=${b.n} days=${b.days}  ${b.mean}c/contract, 90% [${b.lo}, ${b.hi}] ${v}`)
  for (const cat of ['Sports', 'Mentions', 'Entertainment']) { const x = band(units.filter((u) => u.cat === cat)); if (x.n) console.log(`   ${cat} n=${x.n} ${x.mean}c [${x.lo}, ${x.hi}]  (scored only)`) }
  console.log(`read from 2026-11-27 at ${MIN_N} fills on ${MIN_DAYS} days: PASS needs the band above zero and a mean of at least ${MIN_MEAN}c; a mean under ${MIN_MEAN}c FAILS; INCONCLUSIVE after 2026-12-18`)
  if (process.argv.includes('--verdict')) process.exitCode = v === 'PASS' ? 0 : 1
}
