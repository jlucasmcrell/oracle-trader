import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { appendDurably, isSharingViolation } from './append'
import { dirname } from 'node:path'
import type { VenueId } from '../../shared/types'

export interface JournalOrder {
  clientOrderId: string
  venue: VenueId
  marketId: string
  outcome: string
  side: 'buy' | 'sell'
  ref?: string
  version: string
  requestedAt: number
  submittedAt?: number
  acknowledgedAt?: number
  orderId?: string
  state: 'pending' | 'acknowledged' | 'rejected'
}

/** Persistent provenance and reservations for submissions whose responses are unknown. */
export class OrderJournal {
  private orders: JournalOrder[] = []
  private failure?: string
  constructor(private readonly path: string) {
    // Parse row by row and KEEP what parsed. This is an append-only file, so a crash tears the last line
    // and nothing else; voiding the whole journal for it dropped every reservation from the cap count,
    // lost fill attribution, and let ibkrLab close an uncertain live row as "rejected" with net 0 (audit
    // B-42). `failure` still blocks new submissions either way - the rows are for reading, not trusting.
    const rows: JournalOrder[] = []
    try {
      if (existsSync(path)) {
        const lines = readFileSync(path, 'utf8').split('\n').filter(s => s.trim())
        for (let i = 0; i < lines.length; i++) {
          let r: JournalOrder
          try { r = JSON.parse(lines[i]) as JournalOrder } catch {
            // "Torn" only when complete rows precede it: a file whose ONLY line is garbage is simply unreadable.
            this.failure = rows.length > 0 && i === lines.length - 1
              ? 'Torn last journal line; new submissions blocked until reconciled'
              : 'Unreadable order journal; new submissions blocked until reconciled'
            break
          }
          if (!r.clientOrderId || !r.marketId || !r.venue || !['pending', 'acknowledged', 'rejected'].includes(r.state)) {
            this.failure = 'Unreadable order journal; new submissions blocked until reconciled'
            break
          }
          rows.push(r)
        }
      }
    } catch { this.failure = 'Unreadable order journal; new submissions blocked until reconciled' }
    this.orders = [...new Map(rows.map(r => [r.clientOrderId, r])).values()]
  }
  pending(venue: VenueId): JournalOrder[] { return this.orders.filter(r => r.venue === venue && r.state === 'pending') }
  attribution(venue: VenueId, orderId: string): JournalOrder | undefined { return this.orders.find(r => r.venue === venue && r.orderId === orderId) }
  /** The latest acknowledged submission on a market: the provenance of a venue position nothing local tracks. */
  acknowledgedOn(venue: VenueId, marketId: string): JournalOrder | undefined { return this.orders.findLast(r => r.venue === venue && r.marketId === marketId && r.state === 'acknowledged') }
  /** The row that generated a client id: how a resting venue order is recognised as OURS after a lost response. */
  byClientId(venue: VenueId, clientOrderId: string): JournalOrder | undefined { return this.orders.find(r => r.venue === venue && r.clientOrderId === clientOrderId) }
  byRef(venue: VenueId, ref: string): JournalOrder | undefined { return this.orders.findLast(r => r.venue === venue && r.ref === ref) }
  begin(input: Pick<JournalOrder, 'venue' | 'marketId' | 'outcome' | 'side' | 'ref'>): JournalOrder {
    if (this.failure) throw new Error(this.failure)
    if (this.pending(input.venue).some(r => r.marketId === input.marketId)) throw new Error(`Unresolved submission on ${input.marketId}; awaiting venue reconciliation`)
    const row: JournalOrder = { ...input, clientOrderId: randomUUID(), version: '2026-09-15-r3', requestedAt: Date.now(), state: 'pending' }
    this.orders.push(row)
    try {
      this.save(row)
    } catch (e) {
      // Not on disk, so not submitted: forget it, or it blocks its market as an unresolved submission.
      this.orders.splice(this.orders.indexOf(row), 1)
      throw e
    }
    return row
  }
  update(row: JournalOrder, patch: Partial<JournalOrder>): void { Object.assign(row, patch); this.save(row) }
  private save(row: JournalOrder): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      appendDurably(this.path, JSON.stringify(row) + '\n', { flush: true })
    } catch (e) {
      // Another process holding the file (a scan, a copy) fails THIS submission without latching (backlog 223): the
      // next one tries afresh. Any other write failure is an integrity problem and still blocks every submission.
      if (!isSharingViolation(e)) this.failure = 'Order journal write failed; submissions blocked'
      throw e
    }
  }
}
