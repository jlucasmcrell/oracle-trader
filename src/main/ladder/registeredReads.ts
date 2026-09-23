/**
 * Pre-registered reads that run themselves (section 163). Operator, 2026-09-23: "If anything requires me remembering
 * to do something, it will never happen, things should be automatic." Each read carries its registration's fixed rule.
 * From its date it is evaluated once per UTC day; PASS or FAIL applies the registered action once and is pushed to the
 * alert webhook; CONTINUE waits for the next day, and at the registration's final date becomes a final verdict.
 * Decisions are persisted and never re-applied.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { kalshiTakerFeeCentsFor } from '../util/kalshiFee'

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
