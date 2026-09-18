/**
 * Persistent venue-fill reconciler (live mode). Every few minutes it reads the
 * venue's paginated fills feed and publishes any fill the shared trade history
 * has not seen into history.json — independent of which strategy placed the
 * order and of whether that strategy is enabled, disarmed, or has since
 * forgotten the order.
 *
 * Why: engine.placeOrder records only what filled at placement. A resting
 * (post-only) order fills later, and that fill never reached the shared
 * ledger; the weather quoter kept its own JSONL and saw 33 of 653 fills.
 *
 * Dedupe rules:
 *  - by venue fill id (persisted, bounded);
 *  - every execution is archived, including placement-time and partial fills;
 *  - the display hides covered placement summaries by order ID and quantity.
 * Published rows carry ref 'venue-fill' so HistoryStore.stats() can keep
 * them out of the win-rate/P&L denominators (they are one leg, not a round
 * trip) while still counting them as fills.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TradingEngine } from '../engine/engine'
import type { HistoryStore } from './history'
import type { TradeRecord, VenueFill, VenueId } from '../../shared/types'

export interface ReconcilerState {
  schemaVersion?: number
  venue: VenueId
  seenFillIds: string[]
  lastFillTs: number
  ingested: number
  skippedPlacement: number
  runs: number
  lastRunAt?: number
  lastError?: string
  /** 'ok' when the newest page reached fills we had already seen; 'partial' when the page cap was hit before overlap. */
  completeness: 'ok' | 'partial' | 'unknown'
}

export const VENUE_FILL_REF = 'venue-fill'

/** Pure planning step: which venue fills become history rows. Exported for tests. */
/**
 * Every execution is retained by its immutable ID. Placement summaries are
 * hidden by HistoryStore once actual executions cover their quantity.
 */
export function planFillIngest(
  fills: VenueFill[],
  seenFillIds: Set<string>,
  _placements: Map<string, number>,
  venue: VenueId
): { rows: TradeRecord[]; skippedPlacement: number; newIds: string[] } {
  const rows: TradeRecord[] = []
  const newIds: string[] = []
  const newSet = new Set<string>()
  let skippedPlacement = 0
  for (const f of [...fills].sort((a, b) => a.timestamp - b.timestamp)) {
    if (!f.id || !f.marketId || !Number.isFinite(f.shares) || f.shares <= 0 || !Number.isFinite(f.price) || f.price < 0 || f.price > 1 || !Number.isFinite(f.timestamp)) throw new Error('Invalid venue execution')
    if (seenFillIds.has(f.id) || newSet.has(f.id)) continue
    newIds.push(f.id)
    newSet.add(f.id)
    rows.push({
      id: `fill:${f.id}`,
      orderId: f.orderId,
      venue,
      marketId: f.marketId,
      side: f.side,
      outcome: f.outcome,
      amount: Math.round(f.shares * f.price * 1e6) / 1e6,
      shares: f.shares,
      price: f.price,
      fee: f.fee,
      ref: VENUE_FILL_REF,
      timestamp: f.timestamp
    })
  }
  return { rows, skippedPlacement, newIds }
}

export class FillReconciler {
  private state: ReconcilerState
  private running = false
  private archived = new Set<string>()
  private archiveError?: string
  private lastFailLog?: { message: string; at: number }

  constructor(
    private readonly engine: TradingEngine,
    private readonly history: HistoryStore,
    private readonly path: string,
    private readonly venue: VenueId = 'kalshi',
    private readonly log: (s: string) => void = console.log
  ) {
    this.state = { venue, seenFillIds: [], lastFillTs: 0, ingested: 0, skippedPlacement: 0, runs: 0, completeness: 'unknown' }
    try {
      if (existsSync(path)) this.state = { ...this.state, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<ReconcilerState>) }
    } catch {
      // fresh state
    }
    // Re-read executions previously discarded by the timestamp heuristic.
    if (this.state.schemaVersion !== 2) {
      this.state.seenFillIds = []; this.state.lastFillTs = 0; this.state.schemaVersion = 2
    }
    try {
      if (existsSync(this.path + '.fills.jsonl')) for (const line of readFileSync(this.path + '.fills.jsonl', 'utf8').split('\n').filter(Boolean)) {
        const row = JSON.parse(line) as TradeRecord
        if (!row.id || row.venue !== this.venue) throw new Error('Invalid execution archive')
        this.archived.add(row.id)
      }
    } catch { this.archiveError = 'Execution archive unreadable; repair required before appending' }
  }

  status(): ReconcilerState {
    return { ...this.state, seenFillIds: [] }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = this.path + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.path)
    } catch (e) {
      this.log('[reconciler] persist failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  async run(): Promise<void> {
    if (this.running) return
    if (this.engine.getExecutionMode() !== 'live') return
    const adapter = this.engine.getAdapter(this.venue)
    if (!adapter?.getFills) return
    this.running = true
    try {
      if (this.archiveError) throw new Error(this.archiveError)
      await this.engine.reconcileOrders?.(this.venue).catch(e => {
        this.log('[reconciler] order recovery deferred: ' + (e instanceof Error ? e.message : String(e)))
      })
      // First run backfills the whole feed; later runs read enough recent pages
      // to overlap with fills already seen (completeness is reported, not assumed).
      const limit = this.state.lastFillTs ? 1000 : Infinity
      const fills = await adapter.getFills(limit)
      const seen = new Set(this.state.seenFillIds)
      const plan = planFillIngest(fills, seen, new Map(), this.venue)
      const fillsById = new Map(fills.map(f => [`fill:${f.id}`, f]))
      for (const row of plan.rows) {
        const orderId = fillsById.get(row.id)?.orderId
        const intent = orderId ? this.engine.orderAttribution?.(this.venue, orderId) : undefined
        row.orderId = orderId
        row.clientOrderId = intent?.clientOrderId
        row.strategyRef = intent?.ref ?? (orderId ? this.engine.orderStrategy?.(this.venue, orderId) : undefined)
        row.implementationVersion = intent?.version
      }
      const archiveRows = plan.rows.filter(r => !this.archived.has(r.id))
      if (archiveRows.length) {
        try {
          mkdirSync(dirname(this.path), { recursive: true })
          appendFileSync(this.path + '.fills.jsonl', archiveRows.map(r => JSON.stringify(r)).join('\n') + '\n', { flush: true })
        } catch (e) { this.archiveError = 'Execution archive write failed; verify integrity before retrying'; throw e }
        for (const row of archiveRows) this.archived.add(row.id)
      }
      if (plan.rows.length) this.history.recordMany(plan.rows)
      // Completeness: the page overlapped fills we had already seen (or was
      // shorter than the cap), so nothing can have slipped between runs.
      const overlapped = fills.length < limit || fills.some((f) => seen.has(f.id))
      for (const id of plan.newIds) seen.add(id)
      this.state.completeness = fills.length === 0 ? this.state.completeness : overlapped ? 'ok' : 'partial'
      this.state.seenFillIds = [...seen].slice(-20000)
      // A full recent page with no overlap can conceal a gap. Force complete
      // pagination next run instead of repeatedly seeing only the newest 1000.
      this.state.lastFillTs = overlapped ? fills.reduce((latest, f) => Math.max(latest, f.timestamp), this.state.lastFillTs) : 0
      this.state.ingested += plan.rows.length
      this.state.skippedPlacement += plan.skippedPlacement
      this.state.runs++
      this.state.lastRunAt = Date.now()
      this.state.lastError = undefined
      if (plan.rows.length || this.state.runs === 1) {
        this.log(`[reconciler] ${this.venue}: ${fills.length} executions read, ${plan.rows.length} reconciled, completeness ${this.state.completeness}`)
      }
    } catch (e) {
      this.state.lastError = e instanceof Error ? e.message : String(e)
      // A down gateway fails every run; repeat the same message at most every 10 minutes (209 lines in 3.5 h).
      const failNow = Date.now()
      if (!this.lastFailLog || this.lastFailLog.message !== this.state.lastError || failNow - this.lastFailLog.at >= 10 * 60_000) {
        this.lastFailLog = { message: this.state.lastError, at: failNow }
        this.log('[reconciler] run failed: ' + this.state.lastError)
      }
    } finally {
      this.persist()
      this.running = false
    }
  }
}
