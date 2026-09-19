import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
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
    try {
      if (existsSync(path)) {
        const rows: JournalOrder[] = readFileSync(path, 'utf8').split('\n').filter(s => s.trim()).map(s => JSON.parse(s))
        if (rows.some(r => !r.clientOrderId || !r.marketId || !r.venue || !['pending', 'acknowledged', 'rejected'].includes(r.state))) throw new Error('Invalid journal')
        this.orders = [...new Map(rows.map(r => [r.clientOrderId, r])).values()]
      }
    } catch { this.failure = 'Unreadable order journal; new submissions blocked until reconciled' }
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
    this.save(row)
    return row
  }
  update(row: JournalOrder, patch: Partial<JournalOrder>): void { Object.assign(row, patch); this.save(row) }
  private save(row: JournalOrder): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, JSON.stringify(row) + '\n', { flush: true })
    } catch (e) { this.failure = 'Order journal write failed; submissions blocked'; throw e }
  }
}
