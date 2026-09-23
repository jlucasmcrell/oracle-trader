/**
 * Grades what the anti-flood per-series cap threw away.
 *
 * `src/main/venues/cullRecorder.ts` records every market the cap discarded that still had a two-sided book.
 * This settles those markets against Kalshi and prices the counterfactual: if we had taken the entry each
 * strategy's own rule implies, at the recorded quote, paying the real taker fee, what would it have earned?
 *
 * The recorder deliberately stores raw quotes rather than verdicts, so the entry rules live HERE and can be
 * changed without re-recording - and so this never has to duplicate a threshold that drifts in the trader.
 *
 * GET-only, paced, and it trades nothing.
 *
 *   node scripts/cull-gate.mjs                 # every recorded day
 *   node scripts/cull-gate.mjs 2026-09-12      # one day
 *
 * READ THE SIGN CONVENTION BEFORE QUOTING A NUMBER: a positive mean means the cap COST us money by
 * discarding these markets. A negative mean means the cap protected us and should stay exactly as it is.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { needsSettleFetch, settledCacheEntry } from './lib/cull-cache.mjs'

const DIR = process.env.CULL_DIR ?? join(process.env.APPDATA ?? '', 'oracle-trader', 'universe-culled')
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2'
const CACHE = join(DIR, 'settled-cache.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Progress ticks go to stderr, and only on a console: the weekly task runs this under PowerShell's `*>`, which captures
// stderr too (as NativeCommandError records), so a tick written anywhere would still land in the report (backlog 171).
const tick = (s) => process.stderr.isTTY && process.stderr.write(s)

/**
 * Entry rules, copied from the strategies' own configured bounds. Each returns the side it would buy, or
 * null. Kept intentionally simple: this measures whether the DISCARDED POPULATION contained winners, not
 * whether a full signal would have fired - a full signal needs candles and book depth the recorder does not
 * keep. Treat a positive result as "worth wiring the real signal at this band", never as a P&L forecast.
 */
// A verdict needs a real sample. Culled markets from one series settle together, so day-clusters matter
// more than raw n; both are required.
// A quote with no bid behind it is not a price - see the note at the lambda fit below.
const MAX_SPREAD_FOR_LAMBDA = 0.1

const MIN_N_FOR_VERDICT = 100
const MIN_DAYS_FOR_VERDICT = 5

const RULES = {
  // meanReversionMinEntryPrice 0.35, with the global 0.05-0.95 tail guard.
  'mean-reversion': (mid) => (mid >= 0.35 && mid <= 0.95 ? 'YES' : null),
  // momentum has no price filter of its own; only the global band applies.
  momentum: (mid) => (mid > 0.05 && mid < 0.95 ? 'YES' : null),
  // The band the fade rescue does NOT cover - the whole point of the audit finding.
  'mid-zone': (mid) => (mid >= 0.12 && mid <= 0.88 ? 'YES' : null)
}

function loadCache() {
  try {
    return existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}
  } catch {
    return {}
  }
}

function saveCache(cache) {
  try {
    writeFileSync(CACHE, JSON.stringify(cache))
  } catch {
    /* best effort */
  }
}

async function settle(ticker, cache) {
  const c = cache[ticker]
  // A blank result on a settled market can fill in later; re-check those for 24h, then let them rest.
  if (c && typeof c === 'object' && c.blankAt !== undefined) {
    if (Date.now() - c.blankAt < 24 * 3600_000) return { res: null, fetched: false }
  } else if (c !== undefined) return { res: c, fetched: false }
  try {
    const r = await fetch(`${KALSHI}/markets/${encodeURIComponent(ticker)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
    if (!r.ok) return { res: undefined, fetched: true }
    const j = await r.json()
    const st = j.market?.status
    const res = j.market?.result
    if (st !== 'settled' && st !== 'finalized') return { res: undefined, fetched: true }
    if (res === 'yes' || res === 'no') cache[ticker] = res
    else cache[ticker] = { blankAt: Date.now() }
    return { res: res === 'yes' || res === 'no' ? res : null, fetched: true }
  } catch {
    return { res: undefined, fetched: true }
  }
}


/**
 * One request per 50 tickers instead of one per ticker. 41k culled markets at 180 ms each is over two hours -
 * longer than the weekly task's own time limit, so the 2026-09-18 run was killed at 97% and wrote nothing,
 * and because the cache write sat below the loop it never existed and every run restarted from zero.
 * Batching the same read into ~800 requests is also far gentler on the endpoint the live trader shares,
 * and the cache is written per chunk so a killed run still hands its work to the next one.
 *
 * This does NOT replace the per-ticker settle() below it. Measured 2026-09-19: the batch endpoint silently
 * omits some tickers it has answers for - 8,079 of 38,754 came back absent here and every one of the eight
 * sampled resolved `finalized` with a result on `/markets/<ticker>`. The single-market loop is the recovery
 * path for those, and it is now the only place the run still spends real time.
 */
async function prefillSettled(tickers, cache) {
  // Dedup first: `due` carries one row per (day, ticker), so the same ticker recurs across day files.
  const todo = [...new Set(tickers)].filter((t) => needsSettleFetch(cache[t]))
  if (!todo.length) return
  let done = 0
  for (let i = 0; i < todo.length; i += 50) {
    const chunk = todo.slice(i, i + 50)
    try {
      const r = await fetch(`${KALSHI}/markets?tickers=${encodeURIComponent(chunk.join(','))}&limit=1000`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
      if (r.ok) {
        const j = await r.json()
        for (const m of j.markets ?? []) {
          if (!m.ticker) continue
          // An open market has no answer yet: settledCacheEntry returns undefined so a later run re-reads it.
          const entry = settledCacheEntry(m)
          if (entry !== undefined) cache[m.ticker] = entry
        }
      }
    } catch {
      /* a failed chunk stays uncached and is retried next run */
    }
    done += chunk.length
    if ((i / 50) % 20 === 0) saveCache(cache)
    tick(`  settling ${done}/${todo.length}\r`)
    await sleep(180)
  }
  saveCache(cache)
  tick('\n')
}

// ---- normal CDF / inverse, for the Wang-Transform fit below ----
/** Abramowitz-Stegun 7.1.26 erf; accurate to ~1.5e-7, far finer than the 1c tick this is applied to. */
function erf(x) {
  const s = x < 0 ? -1 : 1
  x = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * x)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return s * y
}
const Phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2))
/** Acklam's inverse normal CDF. */
function probit(p) {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const a = [-3.969683028665376e2, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pl = 0.02425
  let q, r
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  q = p - 0.5
  r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/**
 * MLE of the Wang-Transform risk premium: p_mkt = Phi(Phi^-1(p*) + lambda), so p* = Phi(Phi^-1(p_mkt) - lambda).
 * `obs` are {p: mid yes price at record time, y: 1 if it settled YES}.
 *
 * This is a CALIBRATION estimate, not an edge estimate — see the header note. A positive lambda says listed
 * YES prices sit above realised frequencies in this population; it does NOT license buying NO on everything,
 * because the same number is produced by a venue that mostly lists questions whose answer is no.
 */
function fitLambda(obs) {
  const z = obs.map((o) => ({ z: probit(o.p), y: o.y }))
  const ll = (lam) => {
    let s = 0
    for (const o of z) {
      const pStar = Math.min(1 - 1e-12, Math.max(1e-12, Phi(o.z - lam)))
      s += o.y ? Math.log(pStar) : Math.log(1 - pStar)
    }
    return s
  }
  let best = 0
  let bestLl = -Infinity
  for (let lam = -1.5; lam <= 1.5; lam += 0.001) {
    const v = ll(lam)
    if (v > bestLl) {
      bestLl = v
      best = lam
    }
  }
  // SE from the observed information: -1 / (d2 loglik / dlam2), by central difference.
  const h = 0.01
  const d2 = (ll(best + h) - 2 * bestLl + ll(best - h)) / (h * h)
  const se = d2 < 0 ? Math.sqrt(-1 / d2) : NaN
  // A maximum on the edge of the search grid is not a maximum, and the curvature there is not an SE.
  const atBoundary = Math.abs(best) >= 1.49
  return { lambda: best, se: atBoundary ? NaN : se, atBoundary, n: obs.length, ll: bestLl, llZero: ll(0) }
}

const day = process.argv[2]
const files = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && (!day || f === `${day}.jsonl`))
  : []
if (files.length === 0) {
  console.log(`no culled-market files in ${DIR}${day ? ` for ${day}` : ''}`)
  process.exit(0)
}

// Dedup on (day, ticker): a restart re-records a market at a fresh quote, and the FIRST sighting is the one
// whose quote we would actually have traded at.
const rows = new Map()
for (const f of files) {
  for (const line of readFileSync(join(DIR, f), 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      const k = `${f.slice(0, 10)}|${r.ticker}`
      if (!rows.has(k)) rows.set(k, r)
    } catch {
      /* skip a torn line */
    }
  }
}
console.log(`culled markets recorded: ${rows.size} (from ${files.length} day file(s))`)

const cache = loadCache()
const now = Date.now()
// Only markets past their close have an answer; anything else is still open and says nothing yet.
const due = [...rows.values()].filter((r) => r.close && Date.parse(r.close) < now)
console.log(`past close and gradeable: ${due.length}\n`)

await prefillSettled(due.map((r) => r.ticker), cache)

const results = {}
let settled = 0
let n = 0
for (const r of due) {
  const { res, fetched } = await settle(r.ticker, cache)
  if (++n % 50 === 0) tick(`  ${n}/${due.length}\r`)
  // Pace only when a request actually went out. Sleeping on cache hits and not on fetches had it backwards.
  if (fetched) await sleep(180)
  if (res !== 'yes' && res !== 'no') continue
  settled++
  const mid = (r.yb + r.ya) / 2
  for (const [name, rule] of Object.entries(RULES)) {
    const side = rule(mid)
    if (!side) continue
    // Taker cost of the side the rule wants, then Kalshi's exact taker fee on it.
    const cost = side === 'YES' ? r.ya : 1 - r.yb
    if (!(cost > 0 && cost < 1)) continue
    const won = side === 'YES' ? res === 'yes' : res === 'no'
    const fee = 0.07 * cost * (1 - cost)
    const net = ((won ? 1 - cost : -cost) - fee) * 100
    const g = (results[name] = results[name] ?? { n: 0, wins: 0, net: 0, sq: 0, byDay: new Map() })
    g.n++
    if (won) g.wins++
    g.net += net
    g.sq += net * net
    // Day buckets: markets culled from one series settle together (a whole NCAAF slate resolves on one
    // afternoon), so counting them as independent overstates confidence the same way day-correlated fills
    // did before clusteredMean existed.
    const dk = (r.close ?? '').slice(0, 10) || 'unknown'
    const b = g.byDay.get(dk) ?? { n: 0, sum: 0 }
    b.n++
    b.sum += net
    g.byDay.set(dk, b)
  }
}
// Persist. Without this, every run re-fetches every settled market against the endpoint the live trader
// shares - the grader's whole pacing discipline undone by a missing write.
saveCache(cache)
console.log(`settled with a result: ${settled}\n`)
// ---- Wang-Transform calibration check (Yang, SSRN 6468338: lambda_hat = 0.187 for Kalshi) ----
// Our calibratedYesRate() returns IDENTITY above 10c, i.e. asserts zero bias across 90% of the price range.
// These rows already carry a quote and a settled outcome, so testing that assertion is free.
const obs = []
for (const r of due) {
  const res = cache[r.ticker]
  if (res !== 'yes' && res !== 'no') continue
  // A MID IS NOT A PRICE WITHOUT A BID. Fitting lambda on the hunch ledger gave 1.124 - six times the
  // published Kalshi figure - because 94% of that sample was multi-outcome events (one winner among 15-25
  // listed options) on EMPTY books: 25/25 options with no bid, a one-sided ask at 85-97c, median spread
  // 90c. `(0 + 0.97)/2 = 0.485` reads as an at-the-money market and is nothing of the kind. Requiring a
  // two-sided book cut lambda to 0.792; also requiring a tradeable spread cut the sample to 13, and the
  // honest answer to "we cannot test this yet".
  if (!(r.yb > 0 && r.ya > 0)) continue
  if (r.ya - r.yb > MAX_SPREAD_FOR_LAMBDA) continue
  const p = (r.yb + r.ya) / 2
  if (!(p > 0.01 && p < 0.99)) continue
  obs.push({ p, y: res === 'yes' ? 1 : 0, day: (r.close ?? '').slice(0, 10) })
}
if (obs.length >= 200) {
  const fit = fitLambda(obs)
  const lo = fit.lambda - 1.96 * fit.se
  const hi = fit.lambda + 1.96 * fit.se
  console.log('\n--- WANG-TRANSFORM CALIBRATION (descriptive; gates nothing) ---')
  if (fit.atBoundary || !Number.isFinite(fit.se)) {
    console.log(`  n=${fit.n}  lambda_hat ${fit.lambda.toFixed(3)}  - ${fit.atBoundary ? 'AT THE GRID BOUNDARY: not a valid MLE, no interval' : 'flat likelihood: SE unavailable, no interval'}`)
  } else {
    console.log(`  n=${fit.n}  lambda_hat ${fit.lambda.toFixed(3)}  95% [${lo.toFixed(3)}, ${hi.toFixed(3)}]`)
  }
  console.log(`  published Kalshi estimate: 0.187 (Yang, SSRN 6468338, n=271,699)`)
  console.log(`  our calibratedYesRate() implies lambda = 0 above 10c`)
  // The SE above is from the observed information and treats every market as independent. Markets that
  // settle on the same afternoon (one NCAAF slate) are not. The first real sample was n=333 on ONE day and
  // read "excludes 0: YES" - which is the one-cluster band that killed momentum, wearing a different hat.
  // Same rule as every other verdict in this file: nothing is "excluded" under MIN_DAYS_FOR_VERDICT days.
  const lambdaDays = new Set(obs.map((o) => o.day)).size
  const excludesZero = lo > 0 || hi < 0
  const excludesPaper = lo > 0.187 || hi < 0.187
  if (lambdaDays < MIN_DAYS_FOR_VERDICT) {
    console.log(`  settlement days in this sample: ${lambdaDays} - under ${MIN_DAYS_FOR_VERDICT}, so the interval above is UNCLUSTERED and`)
    console.log('  overconfident; no "excludes" verdict is read from it. The by-price table below is the honest part.')
  } else {
    console.log(`  settlement days: ${lambdaDays} (interval is still unclustered - read it as indicative)`)
    console.log(`  excludes 0?     ${excludesZero ? 'YES - our identity assumption above 10c is WRONG in this population' : 'no - identity is not refuted here'}`)
    console.log(`  excludes 0.187? ${excludesPaper ? "YES - our sample disagrees with the paper's magnitude" : "no - consistent with the paper"}`)
  }
  // Realised frequency by price band: the assumption-free version of the same question.
  console.log('\n  realised YES frequency by quoted price (no model):')
  for (const [blo, bhi] of [[0.01, 0.1], [0.1, 0.25], [0.25, 0.45], [0.45, 0.55], [0.55, 0.75], [0.75, 0.9], [0.9, 0.99]]) {
    const sub = obs.filter((o) => o.p >= blo && o.p < bhi)
    if (sub.length < 20) {
      console.log(`    ${blo.toFixed(2)}-${bhi.toFixed(2)}  n=${String(sub.length).padStart(5)}  (too thin to report)`)
      continue
    }
    const mp = sub.reduce((a, o) => a + o.p, 0) / sub.length
    const fr = sub.reduce((a, o) => a + o.y, 0) / sub.length
    const se = Math.sqrt((fr * (1 - fr)) / sub.length)
    console.log(
      `    ${blo.toFixed(2)}-${bhi.toFixed(2)}  n=${String(sub.length).padStart(5)}  mean price ${mp.toFixed(3)}  settled YES ${fr.toFixed(3)} +/- ${(1.96 * se).toFixed(3)}  gap ${((fr - mp) * 100).toFixed(1)}c`
    )
  }
  console.log(`\n  (fitted only on two-sided books with spread <= ${(MAX_SPREAD_FOR_LAMBDA * 100).toFixed(0)}c - a mid with no bid behind it`)
  console.log('  is not a price, and ignoring that produced a spurious lambda of 1.124 once already)')
  console.log('\n  SAMPLE BIAS, stated rather than buried: these are markets the per-series anti-flood cap')
  console.log('  DISCARDED - by construction not the top-3 by 24h volume in their series, so they skew')
  console.log('  low-volume and wide-spread. Fine for asking whether a bias exists; NOT representative of')
  console.log('  what we trade. And a positive lambda here is not an edge: the same number is produced by a')
  console.log('  venue that mostly lists questions whose answer turns out to be no.')
} else {
  console.log(`\nWang-Transform calibration: ${obs.length} settled quotes so far, need 200+`)
}


console.log(['rule'.padEnd(16), 'n'.padStart(6), 'win%'.padStart(7), 'mean c'.padStart(10), '95% lo'.padStart(10), '95% hi'.padStart(10)].join(' '))
for (const [name, g] of Object.entries(results)) {
  if (g.n < 2) {
    console.log([name.padEnd(16), String(g.n).padStart(6), '-'.padStart(7), '-'.padStart(10), '-'.padStart(10), '-'.padStart(10)].join(' '))
    continue
  }
  const mean = g.net / g.n
  // Day-clustered SE with the G/(G-1) finite-cluster correction, floored at the plain SE under three
  // clusters - the same estimator the ladder uses, and for the same reason.
  const groups = [...g.byDay.values()]
  const G = groups.length
  const plain = Math.sqrt(Math.max(0, (g.sq - g.n * mean * mean) / (g.n - 1)) / g.n)
  const clustered = (Math.sqrt(groups.reduce((a, x) => a + (x.sum - x.n * mean) ** 2, 0)) / g.n) * (G > 1 ? Math.sqrt(G / (G - 1)) : 1)
  const se = G < 3 ? Math.max(clustered, plain) : clustered
  const lo = mean - 1.96 * se
  const hi = mean + 1.96 * se
  // No verdict on a thin sample. `lo > 0` fired on n=2 with a 100% win rate before this guard existed -
  // the same shape as the one-cluster band that killed momentum on 2026-09-07.
  const enough = g.n >= MIN_N_FOR_VERDICT && G >= MIN_DAYS_FOR_VERDICT && se > 0
  const verdict = !enough
    ? `  (n=${g.n}, ${G} day(s) - too thin for a verdict)`
    : lo > 0
      ? '  <-- the cap is COSTING us'
      : hi < 0
        ? '  <-- the cap is PROTECTING us'
        : ''
  const showBand = g.n >= 2 && se > 0
  console.log(
    [
      name.padEnd(16),
      String(g.n).padStart(6),
      ((g.wins / g.n) * 100).toFixed(1).padStart(7),
      mean.toFixed(2).padStart(10),
      (showBand ? lo.toFixed(2) : '-').padStart(10),
      (showBand ? hi.toFixed(2) : '-').padStart(10)
    ].join(' ') + verdict
  )
}
console.log('\nPositive mean = the cap discarded winners. Negative = it protected the account.')
console.log('These are POPULATION results on the discarded set, not a signal backtest: a positive band says')
console.log('"wire the real signal at this band and measure properly", not "this is what we would have made".')
