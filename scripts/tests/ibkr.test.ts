import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { EventName, SecType } from '@stoqey/ib'
import { IbkrReader, ibkrInstrument } from '../../src/main/venues/ibkr'

class Fake extends EventEmitter {
  closed = false
  missingEnd = false
  rejectQuotes = false
  connect() { queueMicrotask(() => this.emit(EventName.nextValidId, 100)); return this }
  disconnect() { this.closed = true; this.emit(EventName.disconnected); return this }
  reqAccountSummary(id: number) {
    this.emit(EventName.accountSummary, id, 'TEST', 'TotalCashValue', '42.50', 'USD')
    this.emit(EventName.accountSummaryEnd, id)
  }
  reqPositions() { this.emit(EventName.position, 'TEST', { conId: 7, symbol: 'FF' }, 2, 0.4); this.emit(EventName.positionEnd) }
  cancelAccountSummary() {}
  cancelPositions() {}
  reqAllOpenOrders() { if (!this.missingEnd) this.emit(EventName.openOrderEnd) }
  reqContractDetails(id: number) {
    this.emit(EventName.contractDetails, id, {contract: {conId: 7, symbol: 'FF', secType: SecType.OPT, exchange: 'FORECASTX', right: 'C', lastTradeDateOrContractMonth: '20260916 13:00:00 US/Central'}})
    this.emit(EventName.contractDetailsEnd, id)
  }
  reqMktData(id: number, contract: unknown) {
    assert.deepEqual(contract, {conId: 7, exchange: 'FORECASTX'})
    if (this.rejectQuotes) { this.emit(EventName.error, new Error('Market data subscription required'), 354, id); return }
    this.emit(EventName.marketDataType, id, 3)
    this.emit(EventName.tickPrice, id, 1, -1)
    this.emit(EventName.tickPrice, id, 2, 0.52)
    this.emit(EventName.tickSnapshotEnd, id)
  }
}
async function main() {
  const sessions: Fake[] = []
  const detect = async () => ({connected: true, port: 4001, mode: 'live' as const, message: ''})
  const reader = new IbkrReader(() => {const f = new Fake(); sessions.push(f); return f as any}, detect, 50)
  const [snapshot, markets] = await Promise.all([reader.snapshot(), reader.markets('FF')])
  assert.equal(snapshot.accounts[0].value, '42.50')
  assert.equal(snapshot.positions[0].quantity, 2)
  assert.equal(snapshot.orders.length, 0)
  assert.equal(markets[0].outcome, 'YES')
  assert.equal(ibkrInstrument({exchange:'FORECASTX',right:'P' as any}).outcome, 'NO')
  await assert.rejects(reader.markets('*'), /symbol/)
  await assert.rejects(reader.quote(999), /Select/)
  const quote = await reader.quote(7)
  assert.equal(quote.bid, undefined)
  assert.equal(quote.ask, .52)
  assert.equal(quote.dataType, 'delayed')
  assert.ok(sessions.every(s=>s.closed))
  const incomplete = new IbkrReader(() => {const f=new Fake(); f.missingEnd=true; return f as any},detect,10)
  await assert.rejects(incomplete.snapshot(), /timed out/)
  const denied = new IbkrReader(() => {const f=new Fake(); f.rejectQuotes=true; return f as any},detect,50)
  await denied.markets('FF')
  await assert.rejects(denied.quote(7), /354.*subscription/)
  console.log('IBKR: complete snapshots, timeout failure, YES/NO mapping, contract identity, unavailable prices, permissions and session cleanup passed')
}
main().catch(err=>{console.error(err);process.exitCode=1})
