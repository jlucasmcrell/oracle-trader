/**
 * Pre-registered reads that run themselves (section 163). Operator, 2026-09-23: "If anything requires me remembering
 * to do something, it will never happen, things should be automatic." Each read carries its registration's fixed rule.
 * From its date it is evaluated once per UTC day; PASS or FAIL applies the registered action once and is pushed to the
 * alert webhook; CONTINUE waits for the next day, and at the registration's final date becomes a final verdict.
 * Decisions are persisted and never re-applied.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { kalshiTakerFeeCentsFor } from '../util/kalshiFee'
import { etDay } from '../util/etDay'
import { polyUsTakerFee } from '../strategies/polyusLag'

export type Verdict = 'WAIT' | 'CONTINUE' | 'PASS' | 'FAIL' | 'INCONCLUSIVE'
export interface ReadResult {
  verdict: Verdict
  summary: string
}
export interface RegisteredRead {
  id: string
  /** The registration, for the alert and the log. */
  doc: string
  /** Earliest evaluation, ms. */
  from: number
  /** At or after this a CONTINUE is final: INCONCLUSIVE, and the registered default applies. */
  finalAt?: number
  evaluate(now: number): Promise<ReadResult>
  /** The registered action for a decided verdict; returns what it did, in words. */
  apply(verdict: Verdict): Promise<string>
}
interface ReadState {
  lastEvalDay?: string
  verdict?: Verdict
  summary?: string
  decidedAt?: string
  action?: string
}

export class ReadRunner {
  private state: Record<string, ReadState> = {}
  private running = false

  constructor(
    private readonly path: string,
    private readonly reads: RegisteredRead[],
    private readonly notify: (title: string, message: string) => void,
    private readonly log: (s: string) => void = console.log
  ) {
    try {
      if (existsSync(path)) this.state = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ReadState>
    } catch {
      this.state = {}
    }
  }

  status(): Record<string, ReadState> {
    return JSON.parse(JSON.stringify(this.state)) as Record<string, ReadState>
  }

  async tick(now: number): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const day = new Date(now).toISOString().slice(0, 10)
      for (const r of this.reads) {
        const s = (this.state[r.id] ??= {})
        if (s.decidedAt || now < r.from || s.lastEvalDay === day) continue
        let res: ReadResult
        try {
          res = await r.evaluate(now)
        } catch (e) {
          // A failed evaluation retries next hour rather than waiting a day.
          this.log(`[reads] ${r.id}: evaluation failed, retrying next hour: ${e instanceof Error ? e.message : String(e)}`)
          continue
        }
        if (res.verdict === 'CONTINUE' && r.finalAt !== undefined && now >= r.finalAt) res = { verdict: 'INCONCLUSIVE', summary: res.summary }
        s.lastEvalDay = day
        s.verdict = res.verdict
        s.summary = res.summary
        this.log(`[reads] ${r.id}: ${res.verdict} - ${res.summary}`)
        if (res.verdict === 'PASS' || res.verdict === 'FAIL' || res.verdict === 'INCONCLUSIVE') {
          let action: string
          try {
            action = await r.apply(res.verdict)
          } catch (e) {
            action = `ACTION FAILED: ${e instanceof Error ? e.message : String(e)}`
          }
          s.decidedAt = new Date(now).toISOString()
          s.action = action
          this.log(`[reads] ${r.id}: ${action}`)
          this.notify(`Oracle Trader - ${r.id}: ${res.verdict}`, `${res.summary}\n${action}\n(${r.doc})`)
        }
        this.persist()
      }
    } finally {
      this.running = false
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.path + '.tmp', JSON.stringify(this.state, null, 2))
      renameSync(this.path + '.tmp', this.path)
    } catch (e) {
      this.log(`[reads] could not save state: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lead-lag at event speed (docs/PREREGISTERED-leadlag-fast-shadow.md, backlog 233)
// ---------------------------------------------------------------------------------------------------------------

export interface FastOpenRow {
  ts: string
  t: string
  side: 'YES' | 'NO'
  net: number
  px: number
}
export interface FastReadStats {
  n: number
  days: number
  rowDays: number
  meanCents: number
  lo80: number
  hi80: number
}

/**
 * The grader's statistic (scripts/backtests/leadlag_fast_shadow.py): among 'open' rows at `thresholdCents` net or more,
 * the first settled gap per market and side, bought at the price when it opened plus Kalshi's one-contract fee, held to
 * settlement; the mean in cents with a day-clustered 80% band.
 */
export function fastReadStats(opens: FastOpenRow[], results: ReadonlyMap<string, 'yes' | 'no'>, thresholdCents: number, rowDays: number): FastReadStats | null {
  const seen = new Set<string>()
  const byDay = new Map<string, number[]>()
  let n = 0
  let sum = 0
  for (const o of [...opens].filter((o) => o.net >= thresholdCents).sort((a, b) => a.ts.localeCompare(b.ts))) {
    const res = results.get(o.t)
    const key = `${o.t}|${o.side}`
    if (!res || seen.has(key)) continue
    seen.add(key)
    const won = (res === 'yes') === (o.side === 'YES')
    const v = 100 * ((won ? 1 : 0) - o.px) - kalshiTakerFeeCentsFor(o.px, 1)
    const day = o.ts.slice(0, 10)
    byDay.set(day, [...(byDay.get(day) ?? []), v])
    n++
    sum += v
  }
  if (n === 0) return null
  const m = sum / n
  const g = byDay.size
  const se = g >= 2 ? Math.sqrt((g / (g - 1)) * [...byDay.values()].reduce((s, v) => s + (v.reduce((a, b) => a + b, 0) - v.length * m) ** 2, 0)) / n : Infinity
  return { n, days: g, rowDays, meanCents: m, lo80: m - 1.28 * se, hi80: m + 1.28 * se }
}

/** The registered rule: 3 UTC days of rows; PASS n >= 150 and lower bound > 0; FAIL upper bound < 0; else CONTINUE. */
export function fastReadVerdict(s: FastReadStats | null, rowDays: number): ReadResult {
  if (rowDays < 3) return { verdict: 'WAIT', summary: `${rowDays} UTC day(s) of rows; the registration needs 3` }
  if (!s) return { verdict: 'CONTINUE', summary: 'no settled decision at 6c net yet' }
  const line = `6c net, first gap per market and side: ${s.meanCents >= 0 ? '+' : ''}${s.meanCents.toFixed(2)}c/contract, 80% [${s.lo80.toFixed(2)}, ${s.hi80.toFixed(2)}], n=${s.n} over ${s.days} days`
  if (s.n >= 150 && s.lo80 > 0) return { verdict: 'PASS', summary: line }
  if (s.hi80 < 0) return { verdict: 'FAIL', summary: line }
  return { verdict: 'CONTINUE', summary: line + (s.n < 150 ? ` (needs 150)` : ' (band spans zero)') }
}

export function fastLeadLagRead(deps: {
  shadowPath: string
  kalshiSettled: (series: string, minCloseTs: number) => Promise<{ ticker: string; result?: string }[]>
  setFastLive: (on: boolean) => void
}): RegisteredRead {
  return {
    id: 'leadlag-fast',
    doc: 'docs/PREREGISTERED-leadlag-fast-shadow.md',
    from: Date.parse('2026-09-26T00:00:00Z'),
    finalAt: Date.parse('2026-10-03T00:00:00Z'),
    async evaluate() {
      if (!existsSync(deps.shadowPath)) return { verdict: 'WAIT', summary: 'no shadow file yet' }
      const opens: FastOpenRow[] = []
      const rowDays = new Set<string>()
      let first = Infinity
      for (const line of readFileSync(deps.shadowPath, 'utf8').split(/\r?\n/)) {
        if (!line) continue
        try {
          const r = JSON.parse(line) as { ts?: string; ev?: string; t?: string; side?: string; net?: number; px?: number }
          if (!r.ts) continue
          rowDays.add(r.ts.slice(0, 10))
          first = Math.min(first, Date.parse(r.ts))
          if (r.ev === 'open' && r.t && (r.side === 'YES' || r.side === 'NO') && typeof r.net === 'number' && typeof r.px === 'number') {
            opens.push({ ts: r.ts, t: r.t, side: r.side, net: r.net, px: r.px })
          }
        } catch {
          // skip a torn line
        }
      }
      const series = [...new Set(opens.filter((o) => o.net >= 6).map((o) => o.t.split('-')[0]))]
      const results = new Map<string, 'yes' | 'no'>()
      for (const s of series) {
        for (const m of await deps.kalshiSettled(s, Math.floor(first / 1000))) if (m.result === 'yes' || m.result === 'no') results.set(m.ticker, m.result)
      }
      return fastReadVerdict(fastReadStats(opens, results, 6, rowDays.size), rowDays.size)
    },
    async apply(verdict) {
      if (verdict === 'PASS') {
        deps.setFastLive(true)
        return 'leadLagFastLive switched ON: the event-speed path now trades one contract per first gap, under the lead-lag arm\'s ladder stage and caps'
      }
      deps.setFastLive(false)
      return verdict === 'FAIL' ? 'leadLagFastLive stays OFF: gaps at event speed are not an edge for us' : 'leadLagFastLive stays OFF: still inconclusive at the final read'
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Kalshi leads Polymarket US in play (docs/PREREGISTERED-polyus-lag.md, backlog 234)
// ---------------------------------------------------------------------------------------------------------------

/** The cohort starts at the first immediate-or-cancel LIMIT order (section 162): the build deployed 07:21:28Z. */
export const POLYUS_LAG_COHORT_START = Date.parse('2026-09-23T07:21:28Z')

export interface LagClosed { ts: string; marketId: string; pnl: number; shares: number }
export interface LagFill { ts: string; seenLeg: number; fillLeg: number }

/** Per-contract P&L in cents, clustered by game, and the average fill against the price seen. */
export function polyusLagStats(closed: LagClosed[], fills: LagFill[]): { n: number; games: number; meanCents: number; lo80: number; hi80: number; slipCents: number | null } {
  const rows = closed.filter((c) => c.shares > 0)
  const byGame = new Map<string, number[]>()
  for (const c of rows) byGame.set(c.marketId, [...(byGame.get(c.marketId) ?? []), (100 * c.pnl) / c.shares])
  const n = rows.length
  const all = [...byGame.values()].flat()
  const m = n ? all.reduce((a, b) => a + b, 0) / n : 0
  const g = byGame.size
  const se = g >= 2 ? Math.sqrt((g / (g - 1)) * [...byGame.values()].reduce((s, v) => s + (v.reduce((a, b) => a + b, 0) - v.length * m) ** 2, 0)) / n : Infinity
  const slip = fills.filter((f) => Number.isFinite(f.seenLeg) && Number.isFinite(f.fillLeg))
  return { n, games: g, meanCents: m, lo80: m - 1.28 * se, hi80: m + 1.28 * se, slipCents: slip.length ? (100 * slip.reduce((s, f) => s + (f.fillLeg - f.seenLeg), 0)) / slip.length : null }
}

/**
 * The registered rule, plus the two defaults the registration lacked (amended 2026-09-23, before any entry under it):
 * read at 60 settled entries over 15 games, or on 2026-10-13. FAIL: the 80% band's upper bound below zero, or fills
 * averaging more than 2c worse than the price seen. PASS: the lower bound above zero. Otherwise continue to 150 entries.
 * Defaults: on 2026-10-13 with fewer than 15 entries the displayed price is not tradable often enough to test - FAIL;
 * at 150 entries still inconclusive - INCONCLUSIVE, and the arm stops.
 */
export function polyusLagVerdict(s: ReturnType<typeof polyusLagStats>, now: number): ReadResult {
  const line = `${s.n} settled entries over ${s.games} games: ${s.meanCents >= 0 ? '+' : ''}${s.meanCents.toFixed(2)}c/contract, 80% [${s.lo80.toFixed(2)}, ${s.hi80.toFixed(2)}]${s.slipCents === null ? '' : `, fills ${s.slipCents.toFixed(2)}c from the price seen`}`
  const readDue = (s.n >= 60 && s.games >= 15) || now >= Date.parse('2026-10-13T00:00:00Z')
  if (!readDue) return { verdict: 'WAIT', summary: line }
  if (s.slipCents !== null && s.slipCents > 2) return { verdict: 'FAIL', summary: line + ' - fills average more than 2c worse than seen' }
  if (s.n < 15) return { verdict: 'FAIL', summary: line + ' - too few fills at the displayed price to test by 2026-10-13' }
  if (s.hi80 < 0) return { verdict: 'FAIL', summary: line }
  if (s.lo80 > 0) return { verdict: 'PASS', summary: line }
  if (s.n >= 150) return { verdict: 'INCONCLUSIVE', summary: line + ' - no edge shown at 150 entries' }
  return { verdict: 'WAIT', summary: line + ' - continuing to 150 entries' }
}

export function polyusLagRead(deps: { researchPath: string; retire: (reason: string) => Promise<void> }): RegisteredRead {
  return {
    id: 'polyus-lag',
    doc: 'docs/PREREGISTERED-polyus-lag.md',
    from: Date.parse('2026-09-24T00:00:00Z'),
    async evaluate(now) {
      const closed: LagClosed[] = []
      const fills: LagFill[] = []
      if (existsSync(deps.researchPath)) {
        for (const line of readFileSync(deps.researchPath, 'utf8').split(/\r?\n/)) {
          if (!line.includes('"lag')) continue
          try {
            const r = JSON.parse(line) as { ts?: string; type?: string; strategy?: string; mode?: string; marketId?: string; pnl?: number; shares?: number; seenLeg?: number; fillLeg?: number }
            if (!r.ts || Date.parse(r.ts) < POLYUS_LAG_COHORT_START) continue
            if (r.type === 'closed' && r.strategy === 'lag' && r.mode === 'live' && r.marketId && typeof r.pnl === 'number' && typeof r.shares === 'number') closed.push({ ts: r.ts, marketId: r.marketId, pnl: r.pnl, shares: r.shares })
            if (r.type === 'lag-fill' && typeof r.seenLeg === 'number' && typeof r.fillLeg === 'number') fills.push({ ts: r.ts, seenLeg: r.seenLeg, fillLeg: r.fillLeg })
          } catch {
            // skip a torn line
          }
        }
      }
      return polyusLagVerdict(polyusLagStats(closed, fills), now)
    },
    async apply(verdict) {
      if (verdict === 'PASS') return 'stays on; the ladder may scale it under its own rules'
      await deps.retire(`PREREGISTERED-polyus-lag ${verdict}`)
      return 'polyus-lag retired: off, and not re-armed by the ladder'
    }
  }
}

/**
 * A verdict already reached from the registration's own grader and recorded in the changelog: the app carries it out
 * once, persists it and pushes it, the same as a read it evaluates itself (section 163).
 */
export function decidedRead(id: string, doc: string, verdict: 'PASS' | 'FAIL', summary: string, act: () => Promise<string>): RegisteredRead {
  return { id, doc, from: 0, evaluate: async () => ({ verdict, summary }), apply: async () => act() }
}

// ---------------------------------------------------------------------------------------------------------------
// Lead-lag weekdays against weekends (docs/PREREGISTERED-leadlag-weekday.md)
// ---------------------------------------------------------------------------------------------------------------

export const WEEKDAY_COHORT_START = Date.parse('2026-09-30T04:00:00Z')

/** One live lead-lag fill from leadlag-dislocations.jsonl: `price` is what the side bought cost. */
export interface LeadLagFill { ts: string; t: string; yes: boolean; contracts: number; price: number }
export interface DayBand { contracts: number; days: number; meanCents: number; lo80: number; hi80: number }

/** Contract-weighted cents per contract after the taker fee, with an 80% band clustered on the New York day. */
function dayBand(obs: { day: string; ct: number; cents: number }[]): DayBand {
  const byDay = new Map<string, { ct: number; sum: number }>()
  for (const o of obs) {
    const d = byDay.get(o.day) ?? { ct: 0, sum: 0 }
    d.ct += o.ct
    d.sum += o.ct * o.cents
    byDay.set(o.day, d)
  }
  const ct = obs.reduce((s, o) => s + o.ct, 0)
  const m = ct ? obs.reduce((s, o) => s + o.ct * o.cents, 0) / ct : 0
  const g = byDay.size
  const se = g >= 2 ? Math.sqrt((g / (g - 1)) * [...byDay.values()].reduce((s, d) => s + (d.sum - d.ct * m) ** 2, 0)) / ct : Infinity
  return { contracts: ct, days: g, meanCents: m, lo80: m - 1.28 * se, hi80: m + 1.28 * se }
}

export function weekdayReadStats(fills: LeadLagFill[], results: Map<string, 'yes' | 'no'>, since = WEEKDAY_COHORT_START): { weekday: DayBand; weekend: DayBand } {
  const wk: { day: string; ct: number; cents: number }[] = []
  const we: { day: string; ct: number; cents: number }[] = []
  for (const f of fills) {
    const at = Date.parse(f.ts)
    const res = results.get(f.t)
    if (!(at >= since) || !res || f.contracts <= 0) continue
    const won = (res === 'yes') === f.yes
    const day = etDay(at)
    ;(day.weekend ? we : wk).push({ day: day.date, ct: f.contracts, cents: (won ? 100 : 0) - 100 * f.price - kalshiTakerFeeCentsFor(f.price, 1) })
  }
  return { weekday: dayBand(wk), weekend: dayBand(we) }
}

const fmtBand = (b: DayBand): string =>
  `${b.meanCents >= 0 ? '+' : ''}${b.meanCents.toFixed(2)}c/contract, 80% [${b.lo80.toFixed(2)}, ${b.hi80.toFixed(2)}], ${b.contracts} contracts over ${b.days} days`

/**
 * The registered rule: read once the cohort holds at least 10 weekday and 6 weekend days. FAIL (weekdays lose): the
 * weekday band wholly below zero - lead-lag then trades weekends only. PASS: the weekday band wholly above zero - no
 * change. Otherwise continue to 2026-11-02, then INCONCLUSIVE - no change.
 */
export function weekdayReadVerdict(s: { weekday: DayBand; weekend: DayBand }): ReadResult {
  const line = `weekdays ${fmtBand(s.weekday)}; weekends ${fmtBand(s.weekend)}`
  if (s.weekday.days < 10 || s.weekend.days < 6) return { verdict: 'WAIT', summary: line + ' (needs 10 weekday and 6 weekend days)' }
  if (s.weekday.hi80 < 0) return { verdict: 'FAIL', summary: line }
  if (s.weekday.lo80 > 0) return { verdict: 'PASS', summary: line }
  return { verdict: 'CONTINUE', summary: line + ' (weekday band spans zero)' }
}

export function leadLagWeekdayRead(deps: {
  dislocationsPath: string
  kalshiSettled: (series: string, minCloseTs: number) => Promise<{ ticker: string; result?: string }[]>
  setWeekdays: (on: boolean) => void
}): RegisteredRead {
  return {
    id: 'leadlag-weekday',
    doc: 'docs/PREREGISTERED-leadlag-weekday.md',
    from: Date.parse('2026-10-19T04:00:00Z'),
    finalAt: Date.parse('2026-11-02T05:00:00Z'),
    async evaluate() {
      if (!existsSync(deps.dislocationsPath)) return { verdict: 'WAIT', summary: 'no lead-lag log yet' }
      const fills: LeadLagFill[] = []
      for (const line of readFileSync(deps.dislocationsPath, 'utf8').split(/\r?\n/)) {
        if (!line.includes('"executed":true')) continue
        try {
          const r = JSON.parse(line) as { ts?: string; kalshiTicker?: string; suggestedAction?: string; filledContracts?: number; fillPrice?: number }
          if (r.ts && r.kalshiTicker && typeof r.filledContracts === 'number' && r.filledContracts > 0 && typeof r.fillPrice === 'number' && Date.parse(r.ts) >= WEEKDAY_COHORT_START) {
            fills.push({ ts: r.ts, t: r.kalshiTicker, yes: (r.suggestedAction ?? '').endsWith('YES'), contracts: r.filledContracts, price: r.fillPrice })
          }
        } catch {
          // skip a torn line
        }
      }
      const results = new Map<string, 'yes' | 'no'>()
      for (const s of [...new Set(fills.map((f) => f.t.split('-')[0]))]) {
        for (const m of await deps.kalshiSettled(s, Math.floor(WEEKDAY_COHORT_START / 1000))) if (m.result === 'yes' || m.result === 'no') results.set(m.ticker, m.result)
      }
      return weekdayReadVerdict(weekdayReadStats(fills, results))
    },
    async apply(verdict) {
      if (verdict === 'FAIL') {
        deps.setWeekdays(false)
        return 'leadLagWeekdays switched OFF: lead-lag now trades live on New York weekends only'
      }
      return 'no change: lead-lag keeps trading every day'
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Polymarket US BTC-hour lead-lag shadow (docs/PREREGISTERED-polyus-btc-hour.md)
// ---------------------------------------------------------------------------------------------------------------

export const BTC_HOUR_MIN_NET = 6
/** Two leaders are tested, so each band is drawn at z = 1.645 (Bonferroni: an 80% family over two). */
const BTC_HOUR_Z = 1.645

export interface BtcHourOpen { ts: string; slug: string; leader: string; side: 'YES' | 'NO'; px: number; net: number }
export interface BtcHourBand { n: number; days: number; meanCents: number; lo: number; hi: number }

/** First gap per market, side and leader at BTC_HOUR_MIN_NET or more, bought at the logged price, held to settlement. */
export function btcHourStats(opens: BtcHourOpen[], results: Map<string, 'yes' | 'no'>): Record<string, BtcHourBand> {
  const seen = new Set<string>()
  const by = new Map<string, { day: string; c: number }[]>()
  for (const o of [...opens].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const res = results.get(o.slug)
    const key = `${o.slug}|${o.leader}|${o.side}`
    if (o.net < BTC_HOUR_MIN_NET || !res || seen.has(key)) continue
    seen.add(key)
    const won = (res === 'yes') === (o.side === 'YES')
    const rows = by.get(o.leader) ?? []
    rows.push({ day: o.ts.slice(0, 10), c: (won ? 100 : 0) - 100 * o.px - 100 * polyUsTakerFee(o.px) })
    by.set(o.leader, rows)
  }
  const out: Record<string, BtcHourBand> = {}
  for (const [leader, rows] of by) {
    const days = new Map<string, number[]>()
    for (const r of rows) days.set(r.day, [...(days.get(r.day) ?? []), r.c])
    const n = rows.length, m = rows.reduce((s, r) => s + r.c, 0) / n, g = days.size
    const se = g >= 2 ? Math.sqrt((g / (g - 1)) * [...days.values()].reduce((s, v) => s + (v.reduce((a, b) => a + b, 0) - v.length * m) ** 2, 0)) / n : Infinity
    out[leader] = { n, days: g, meanCents: m, lo: m - BTC_HOUR_Z * se, hi: m + BTC_HOUR_Z * se }
  }
  return out
}

/**
 * The registered rule. A leader is readable at >= 100 first gaps over >= 7 days. PASS: any readable leader's lower bound
 * above zero. FAIL: both leaders readable and both upper bounds below zero. Otherwise continue to 2026-11-01.
 */
export function btcHourVerdict(s: Record<string, BtcHourBand>): ReadResult {
  const fmt = (k: string): string => {
    const b = s[k]
    return b ? `${k} ${b.meanCents >= 0 ? '+' : ''}${b.meanCents.toFixed(2)}c [${b.lo.toFixed(2)}, ${b.hi.toFixed(2)}] n=${b.n}/${b.days}d` : `${k} none`
  }
  const line = `${fmt('international')}; ${fmt('spot')} (first gap >= ${BTC_HOUR_MIN_NET}c, z ${BTC_HOUR_Z})`
  const readable = ['international', 'spot'].filter((k) => s[k] && s[k].n >= 100 && s[k].days >= 7)
  if (!readable.length) return { verdict: 'WAIT', summary: line + ' - needs 100 first gaps over 7 days for a leader' }
  if (readable.some((k) => s[k].lo > 0)) return { verdict: 'PASS', summary: line }
  if (readable.length === 2 && readable.every((k) => s[k].hi < 0)) return { verdict: 'FAIL', summary: line }
  return { verdict: 'CONTINUE', summary: line }
}

export function polyusBtcHourRead(deps: {
  shadowPath: string
  settled: (slugs: string[]) => Promise<Map<string, 'yes' | 'no'>>
  stop: () => void
}): RegisteredRead {
  return {
    id: 'polyus-btc-hour',
    doc: 'docs/PREREGISTERED-polyus-btc-hour.md',
    from: Date.parse('2026-10-18T00:00:00Z'),
    finalAt: Date.parse('2026-11-01T00:00:00Z'),
    async evaluate(now) {
      if (!existsSync(deps.shadowPath)) return { verdict: 'WAIT', summary: 'no shadow file yet' }
      const opens: BtcHourOpen[] = []
      for (const line of readFileSync(deps.shadowPath, 'utf8').split(/\r?\n/)) {
        if (!line.includes('"open"')) continue
        try {
          const r = JSON.parse(line) as Partial<BtcHourOpen> & { ev?: string }
          if (r.ev === 'open' && r.ts && r.slug && r.leader && (r.side === 'YES' || r.side === 'NO') && typeof r.px === 'number' && typeof r.net === 'number') opens.push(r as BtcHourOpen)
        } catch {
          // skip a torn line
        }
      }
      // A market is graded once it has ended (its slug names the hour it starts).
      const slugs = [...new Set(opens.filter((o) => o.net >= BTC_HOUR_MIN_NET).map((o) => o.slug))]
        .filter((s) => { const m = /(\d{4}-\d\d-\d\d)-(\d\d)00z$/.exec(s); return !!m && Date.parse(`${m[1]}T${m[2]}:00:00Z`) + 2 * 3600_000 < now })
      return btcHourVerdict(btcHourStats(opens, await deps.settled(slugs)))
    },
    async apply(verdict) {
      if (verdict === 'PASS') return 'recorder keeps running; a live arm needs its own registration (sizes and limits are the operator\'s)'
      deps.stop()
      return 'btcHourShadowEnabled switched OFF: the BTC-hour recorder stops'
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Polymarket US fade, re-armed 2026-09-23 (docs/PREREGISTERED-polyus-fade.md, backlog 235)
// ---------------------------------------------------------------------------------------------------------------

export interface MiniClosed { ts: string; marketId: string; pnl: number; shares: number }

/** Per-contract P&L in cents with a day-clustered 80% band, and the loss count, over settled entries. */
export function miniArmStats(closed: MiniClosed[]): { n: number; losses: number; days: number; meanCents: number; lo80: number; hi80: number } {
  const rows = closed.filter((c) => c.shares > 0)
  const byDay = new Map<string, number[]>()
  for (const c of rows) byDay.set(c.ts.slice(0, 10), [...(byDay.get(c.ts.slice(0, 10)) ?? []), (100 * c.pnl) / c.shares])
  const n = rows.length
  const m = n ? rows.reduce((s, c) => s + (100 * c.pnl) / c.shares, 0) / n : 0
  const g = byDay.size
  const se = g >= 2 ? Math.sqrt((g / (g - 1)) * [...byDay.values()].reduce((s, v) => s + (v.reduce((a, b) => a + b, 0) - v.length * m) ** 2, 0)) / n : Infinity
  return { n, losses: rows.filter((c) => c.pnl < 0).length, days: g, meanCents: m, lo80: m - 1.28 * se, hi80: m + 1.28 * se }
}

/**
 * The registered rule: read at 15 losses or 250 settled entries. PASS: the lower bound above zero (the ladder may scale).
 * FAIL: the upper bound below zero. Otherwise continue to 30 losses or 500 settled, or 2026-12-31: then INCONCLUSIVE, and
 * the arm stops - a favourite fade that shows nothing over that sample is not worth the slots.
 */
/** `stopped`: the ladder has stopped the arm for good, so the cohort can never grow - the read is final now
 * (PREREGISTERED-polyus-fade.md amendment 2; without it the read waited for ever, backlog 258). */
export function polyusFadeVerdict(s: ReturnType<typeof miniArmStats>, now: number, stopped = false): ReadResult {
  const line = `${s.n} settled, ${s.losses} losses over ${s.days} days: ${s.meanCents >= 0 ? '+' : ''}${s.meanCents.toFixed(2)}c/contract, 80% [${s.lo80.toFixed(2)}, ${s.hi80.toFixed(2)}]` + (stopped ? ' - the ladder stopped the arm for good, so this read is final' : '')
  const first = s.losses >= 15 || s.n >= 250
  const final = stopped || s.losses >= 30 || s.n >= 500 || now >= Date.parse('2026-12-31T00:00:00Z')
  if (!first && !final) return { verdict: 'WAIT', summary: line }
  if (s.hi80 < 0) return { verdict: 'FAIL', summary: line }
  if (s.lo80 > 0) return { verdict: 'PASS', summary: line }
  if (final) return { verdict: 'INCONCLUSIVE', summary: line + ' - no edge shown by the final read' }
  return { verdict: 'WAIT', summary: line + ' - continuing to 30 losses or 500 settled' }
}

export function polyusFadeRead(deps: { researchPath: string; cohortStart: number; retire: (reason: string) => Promise<void>; stopped?: () => boolean }): RegisteredRead {
  return {
    id: 'polyus-fade',
    doc: 'docs/PREREGISTERED-polyus-fade.md',
    from: deps.cohortStart,
    async evaluate(now) {
      const closed: MiniClosed[] = []
      if (existsSync(deps.researchPath)) {
        for (const line of readFileSync(deps.researchPath, 'utf8').split(/\r?\n/)) {
          if (!line.includes('"closed"')) continue
          try {
            const r = JSON.parse(line) as { ts?: string; type?: string; strategy?: string; mode?: string; marketId?: string; pnl?: number; shares?: number }
            if (r.type === 'closed' && r.strategy === 'fade' && r.mode === 'live' && r.ts && Date.parse(r.ts) >= deps.cohortStart && r.marketId && typeof r.pnl === 'number' && typeof r.shares === 'number') {
              closed.push({ ts: r.ts, marketId: r.marketId, pnl: r.pnl, shares: r.shares })
            }
          } catch {
            // skip a torn line
          }
        }
      }
      return polyusFadeVerdict(miniArmStats(closed), now, deps.stopped?.() ?? false)
    },
    async apply(verdict) {
      if (verdict === 'PASS') return 'stays on; the ladder may scale it under its own rules'
      await deps.retire(`PREREGISTERED-polyus-fade ${verdict}`)
      return 'polyus-fade retired: off, and not re-armed by the ladder'
    }
  }
}
