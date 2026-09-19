import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TradingEngine } from '../../src/main/engine/engine'
import { OrderJournal } from '../../src/main/store/orderJournal'
import { HistoryStore } from '../../src/main/store/history'
import { FillReconciler } from '../../src/main/store/fillReconciler'
import { HttpError, RateLimiter } from '../../src/main/util/http'
import { PolymarketUsAdapter, usCashPnl } from '../../src/main/venues/polymarketUs'
import { AutoTrader } from '../../src/main/strategies/autoTrader'
import { cfObservation } from '../../src/main/venues/cfReferenceShadow'
import { loadJsonOrQuarantine } from '../../src/main/store/json'
import { LeadLagEngine } from '../../src/main/strategies/leadLag'
import { entryFeeDollars } from '../../src/main/strategies/autoTrader'

const dir = mkdtempSync(join(tmpdir(), 'oracle-remaining-'))
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Network forbidden in regression tests') }
const order: any = { venue: 'kalshi', marketId: 'MARKET', outcome: 'YES', amount: 0.5, ref: 'leadlag' }
const result: any = { venue: 'kalshi', marketId: 'MARKET', outcome: 'YES', orderId: 'venue-order', shares: 1, amount: 0.5, avgPrice: 0.5, timestamp: Date.now(), status: 'filled' }
let passed = 0
async function test(name: string, run: () => any) { await run(); passed++; console.log('PASS ' + name) }

async function main() {
  await test('reference observations reject stale, unsupported and invalid prices', () => {
    const now = Date.now()
    const frame = (value: unknown, time = now, index_id = 'BRTI') => ({ type: 'cfbenchmarks_value', msg: { index_id, data: JSON.stringify({ value, time }) } })
    assert.equal(cfObservation(frame('64000'), now)?.value, 64000)
    assert.equal(cfObservation(frame('NaN'), now), undefined)
    assert.equal(cfObservation(frame(64000, now - 61000), now), undefined)
    assert.equal(cfObservation(frame(64000, now, 'unknown'), now), undefined)
  })
  await test('missing US balances and malformed exposure fail closed', async () => {
    const a: any = new PolymarketUsAdapter(); a.requireAuth = () => {}
    a.authGet = async () => ({})
    await assert.rejects(a.getAccount(), /USD balance/); await assert.rejects(a.getPositions(), /positions ledger/)
    a.authGet = async () => ({ positions: { m: { netPositionDecimal: 'NaN' } } })
    await assert.rejects(a.getPositions(), /quantity/)
    a.authGet = async () => ({ balances: [{ currency: 'USD', currentBalance: '39.84935', marginRequirement: 0 }] })
    assert.equal((await a.getAccount()).balance, 39.84935)
  })
  await test('failed recovery does not suppress normal fill ingestion', async () => {
    const history = new HistoryStore(join(dir, 'recovery-offline-history.json'))
    const e: any = { getExecutionMode: () => 'live', reconcileOrders: async () => { throw new Error('lookup offline') },
      getAdapter: () => ({ getFills: async () => [{ id: 'independent-fill', marketId: 'OTHER', outcome: 'YES', side: 'buy', shares: 1, price: 0.4, timestamp: Date.now() }] }) }
    const r = new FillReconciler(e, history, join(dir, 'recovery-offline.json'), 'kalshi', () => {})
    await r.run(); assert.equal(r.status().ingested, 1)
  })
  await test('unknown buy persists, blocks a retry, recovers, and attributes the late fill', async () => {
    const home = join(dir, 'recover')
    const history = new HistoryStore(join(home, 'history.json'))
    let sentId = '', attempts = 0
    const adapter: any = {
      placeOrder: async (o: any) => {
        o.onSubmit(); attempts++; sentId = o.clientOrderId
        assert.equal(new OrderJournal(join(home, 'order-journal.jsonl')).pending('kalshi')[0].clientOrderId, sentId)
        throw new Error('response lost after acceptance')
      },
      findOrderByClientId: async (id: string) => { assert.equal(id, sentId); return { orderId: 'venue-order' } },
      getFills: async () => [{ id: 'fill-1', orderId: 'venue-order', marketId: 'MARKET', outcome: 'YES', side: 'buy', shares: 1, price: 0.5, fee: 0.01, timestamp: Date.now() }]
    }
    const create = () => { const e = new TradingEngine({ get: () => adapter } as any, history, { paperStateDir: home }); e.setExecutionMode('live'); return e }
    await assert.rejects(create().placeOrder(order), /response lost/)
    const restarted = create()
    await assert.rejects(restarted.placeOrder(order), /Unresolved submission/)
    assert.equal(attempts, 1)
    const oldNow = Date.now
    Date.now = () => oldNow() + 61_000
    try { await new FillReconciler(restarted, history, join(home, 'reconciler.json')).run() } finally { Date.now = oldNow }
    const fill = history.list()[0]
    assert.equal(fill.strategyRef, 'leadlag'); assert.equal(fill.clientOrderId, sentId)
    assert.equal(fill.implementationVersion, '2026-09-15-r3'); assert.equal(fill.ref, 'venue-fill')
    assert.equal(new OrderJournal(join(home, 'order-journal.jsonl')).pending('kalshi').length, 0)
  })
  // Audit 2026-09-19 B-04: a submission the venue never created stayed pending forever, blocking that market's
  // buys and sells and holding a cap slot; an unsent row (no submittedAt) was never released either.
  await test('a never-created submission is released after three clean searches over ten minutes; an unsent row at once', async () => {
    const home = join(dir, 'never-created')
    const history = new HistoryStore(join(home, 'history.json'))
    let searches = 0
    const adapter: any = {
      placeOrder: async (o: any) => { o.onSubmit(); throw new Error('response lost after acceptance') },
      findOrderByClientId: async () => { searches++; return undefined },
      getFills: async () => []
    }
    const e = new TradingEngine({ get: () => adapter } as any, history, { paperStateDir: home })
    e.setExecutionMode('live')
    await assert.rejects(e.placeOrder(order), /response lost/)
    const journal = () => new OrderJournal(join(home, 'order-journal.jsonl'))
    assert.equal(journal().pending('kalshi').length, 1)
    const oldNow = Date.now
    const base = oldNow()
    try {
      Date.now = () => base + 61_000; await e.reconcileOrders('kalshi')
      Date.now = () => base + 6 * 60_000; await e.reconcileOrders('kalshi')
      assert.equal(journal().pending('kalshi').length, 1, 'two misses inside ten minutes keep the row')
      Date.now = () => base + 11 * 60_000; await e.reconcileOrders('kalshi')
    } finally { Date.now = oldNow }
    assert.equal(searches, 3)
    assert.equal(journal().pending('kalshi').length, 0, 'three clean misses over ten minutes release the row')
    // The market accepts a submission again (no 'Unresolved submission' block).
    await assert.rejects(e.placeOrder(order), /response lost/)
    // An unsent row: the adapter never reached the socket (no submittedAt). Released on the first pass after a minute.
    const j = journal()
    j.begin({ venue: 'kalshi', marketId: 'UNSENT', outcome: 'YES', side: 'buy', ref: 'fade' })
    const e2 = new TradingEngine({ get: () => adapter } as any, history, { paperStateDir: home })
    e2.setExecutionMode('live')
    try { Date.now = () => oldNow() + 61_000; await e2.reconcileOrders('kalshi') } finally { Date.now = oldNow }
    assert.equal(journal().pending('kalshi').filter((r) => r.marketId === 'UNSENT').length, 0, 'an unsent row is released')
  })
  await test('local preflight failure and explicit rejection do not strand capacity', async () => {
    let calls = 0
    const adapter: any = { placeOrder: async (o: any) => {
      calls++
      if (calls === 1) throw new Error('no liquidity before POST')
      o.onSubmit()
      if (calls === 2) throw new HttpError(400, 'rejected')
      return result
    } }
    const e = new TradingEngine({ get: () => adapter } as any, { record: () => {} } as any, { paperStateDir: join(dir, 'reject') }); e.setExecutionMode('live')
    await assert.rejects(e.placeOrder(order)); await assert.rejects(e.placeOrder(order))
    assert.equal((await e.placeOrder(order)).orderId, 'venue-order')
  })
  await test('uncertain sell blocks another sell; corrupt journal fails closed', async () => {
    const home = join(dir, 'sell')
    let calls = 0
    const adapter: any = { sellPosition: async (o: any) => { o.onSubmit(); calls++; throw new Error('timeout') } }
    const e = new TradingEngine({ get: () => adapter } as any, {} as any, { paperStateDir: home }); e.setExecutionMode('live')
    await assert.rejects(e.sellPosition(order), /timeout/)
    await assert.rejects(e.sellPosition(order), /Unresolved/); assert.equal(calls, 1)
    writeFileSync(join(home, 'order-journal.jsonl'), 'torn')
    assert.throws(() => new OrderJournal(join(home, 'order-journal.jsonl')).begin({ ...order, side: 'buy' }), /Unreadable/)
  })
  await test('US cash P&L includes fees once and handles funding, withdrawal and earned rebates', () => {
    const funding = (type: string, value: string, id: string): any => ({ type: 'ACTIVITY_TYPE_' + type, accountBalanceChange: { transactionId: id, status: 'ACCOUNT_BALANCE_CHANGE_STATUS_COMPLETED', amount: { value, currency: 'USD' } } })
    const rows = [funding('ACCOUNT_DEPOSIT', '25', '1'), funding('REFERRAL_BONUS', '20', '2'), funding('ACCOUNT_WITHDRAWAL', '10', '3'), funding('TAKER_FEE_REBATE', '1', '4')]
    assert.equal(usCashPnl(rows, 31, 0).realizedPnl, -4)
    assert.equal(usCashPnl(rows, 31, 1).available, false)
    assert.equal(usCashPnl([...rows, rows[0]], 31, 0).available, false)
    assert.equal(usCashPnl([], 31, 0).available, false)
  })
  await test('US price protection rejection submits only once, closing limits are honored', async () => {
    const adapter: any = new PolymarketUsAdapter()
    adapter.requireAuth = () => {}
    let bodies: any[] = []
    adapter.authPost = async (_: string, body: any) => { bodies.push(body); throw new HttpError(400, 'slippage rejected') }
    await assert.rejects(adapter.placeOrder({ ...order, venue: 'polymarket-us', limitPrice: 0.4 }))
    assert.equal(bodies.length, 1); assert.ok(bodies[0].slippageTolerance)
    adapter.getPositions = async () => [{ marketId: 'MARKET', outcome: 'NO', shares: 10, avgPrice: 0.5 }]
    adapter.authPost = async (_: string, body: any) => { bodies.push(body); return { id: 'sell', executions: [] } }
    await adapter.sellPosition({ ...order, outcome: 'NO', shares: 2, limitPrice: 0.3 })
    assert.equal(bodies[1].type, 'ORDER_TYPE_LIMIT'); assert.equal(bodies[1].price.value, '0.300'); assert.equal(bodies[1].quantity, 2)
  })
  await test('rate-limit wakeups respect capacity and prioritize order work', async () => {
    const now = Date.now, timer = globalThis.setTimeout, cancel = globalThis.clearTimeout
    let clock = 1000, wake: (() => void) | undefined
    Date.now = () => clock
    globalThis.setTimeout = ((fn: () => void) => { wake = fn; return 1 }) as any
    globalThis.clearTimeout = (() => {}) as any
    try {
      const limiter = new RateLimiter(1); const seen: string[] = []
      await limiter.wait()
      const read = limiter.wait(0).then(() => seen.push('read'))
      const write = limiter.wait(2).then(() => seen.push('write'))
      clock += 60_010; wake!(); await write; assert.deepEqual(seen, ['write'])
      clock += 60_010; wake!(); await read; assert.deepEqual(seen, ['write', 'read'])
    } finally { Date.now = now; globalThis.setTimeout = timer; globalThis.clearTimeout = cancel }
  })
  await test('concurrent initial P&L reads share one request; errors never become zero profit', async () => {
    let calls = 0
    const adapter: any = { getSettlements: async () => { calls++; await Promise.resolve(); throw new Error('ledger offline') } }
    const e = new TradingEngine({ get: () => adapter } as any, {} as any)
    const rows = await Promise.allSettled([e.getLivePnl('kalshi'), e.getLivePnl('kalshi')])
    assert.equal(calls, 1); assert.ok(rows.every(r => r.status === 'rejected'))
  })
  await test('exit quotes fetch in bounded batches without changing position order', async () => {
    const t: any = Object.create(AutoTrader.prototype)
    let inflight = 0, peak = 0
    t.config = { fadeExitEnabled: false }; t.state = { openTrades: Array.from({ length: 9 }, (_, i) => ({ id: String(i), marketId: String(i), outcome: 'YES', strategy: 'fade', createdAt: Date.now(), closeTime: Date.now() + 3600_000 })) }
    t.engine = { getExecutionMode: () => 'live', getAdapter: () => ({ getPrice: async () => {
      inflight++; peak = Math.max(peak, inflight); await Promise.resolve(); inflight--; return { price: 0.5 }
    } }) }
    t.settleProbeAt = new Map()
    await t.manageExits({})
    assert.equal(peak, 4); assert.ok(t.state.openTrades.every((r: any) => r.lastSideMid === 0.5))
  })
  await test('B-31: an unparseable state file is moved aside, never overwritten by the next persist', () => {
    const p = join(dir, 'state-b31.json')
    writeFileSync(p, '\ufeff{"trades": [1, 2')
    const logs: string[] = []
    assert.equal(loadJsonOrQuarantine(p, (s) => logs.push(s)), undefined)
    assert.ok(!existsSync(p), 'the corrupt file no longer sits at the state path')
    assert.ok(readdirSync(dir).some((f) => f.startsWith('state-b31.json.corrupt-')), 'it was moved aside')
    assert.ok(logs.length === 1 && /unreadable/.test(logs[0]))
    writeFileSync(p, '{"trades": [1, 2]}')
    assert.deepEqual(loadJsonOrQuarantine(p), { trades: [1, 2] })
    assert.equal(loadJsonOrQuarantine(join(dir, 'absent.json')), undefined)
  })
  await test('B-10: a live scan with no balance and no equity holds entries instead of skipping the kill switch', () => {
    const t: any = Object.create(AutoTrader.prototype)
    t.config = { stopEntry: false, maxDailyLossPct: 20 }
    t.state = { openTrades: [], pendingOrders: [], daily: { date: '', count: 0 }, dailyPnl: { date: '', realized: 0, tripped: false } }
    t.engine = { getExecutionMode: () => 'live' }
    t.reconciledLive = true
    t.venueLedgerStale = () => false
    t.churn = new Map()
    const why = t.entryBlocked({ strategy: 'fade', marketId: 'KXX' }, { tradingActive: true })
    assert.match(why, /balance unknown/)
    let kill = 0
    t.killSwitchCheck = () => { kill++; return 'kill-switch: test' }
    assert.equal(t.entryBlocked({ strategy: 'fade', marketId: 'KXX' }, { tradingActive: true, balance: 50 }), 'kill-switch: test')
    assert.equal(kill, 1, 'with a balance the kill switch is judged')
  })
  await test('B-25: a lost exit response is booked from the recovered order, not retried, settled or dropped', async () => {
    const mk = (over: Partial<any> = {}) => {
      const t: any = Object.create(AutoTrader.prototype)
      const trade: any = { id: 'x', marketId: 'KXF', outcome: 'NO', shares: 2, amount: 1.2, entryPrice: 0.6, strategy: 'fade', createdAt: Date.now() - 3600_000, exitUnknownAt: Date.now() - 120_000, feeRate: 0.07 }
      t.state = { openTrades: [trade] }
      t.persist = () => {}; t.emit = () => {}
      t.booked = [] as any[]
      t.recordExit = (pnl: number, key: string, tr: any, shares?: number) => t.booked.push({ pnl, key, shares })
      t.removeTrade = (id: string) => { t.state.openTrades = t.state.openTrades.filter((r: any) => r.id !== id) }
      t.engine = { recoveredOrder: () => ({ side: 'sell', orderId: 'sell-1', requestedAt: Date.now() - 100_000 }), submissionPending: () => false, ...over }
      return { t, trade }
    }
    // Full fill recovered: booked at the fill price and removed.
    {
      const { t, trade } = mk()
      const adapter: any = { getFills: async () => [{ orderId: 'sell-1', shares: 1.2, price: 0.46, fee: 0.02 }, { orderId: 'sell-1', shares: 0.8, price: 0.46, fee: 0.01 }, { orderId: 'other', shares: 5, price: 0.9, fee: 0 }] }
      assert.equal(await t.reconcileUnknownExit(trade, adapter), false)
      assert.equal(t.state.openTrades.length, 0)
      assert.equal(t.booked.length, 1)
      assert.ok(Math.abs(t.booked[0].pnl - ((0.46 - 0.6) * 2 - 0.03 - entryFeeDollars(trade))) < 1e-9, 'realized = (fill - entry) x shares - exit fees - entry fee')
    }
    // Still pending at the journal: untouched, and the caller must skip it.
    {
      const { t, trade } = mk({ recoveredOrder: () => undefined, submissionPending: () => true })
      assert.equal(await t.reconcileUnknownExit(trade, { getFills: async () => { throw new Error('must not be called') } }), true)
      assert.equal(t.state.openTrades.length, 1); assert.equal(t.booked.length, 0); assert.ok(trade.exitUnknownAt)
    }
    // Released as never created: the flag clears and the exit ladder may retry.
    {
      const { t, trade } = mk({ recoveredOrder: () => undefined, submissionPending: () => false })
      assert.equal(await t.reconcileUnknownExit(trade, {}), false)
      assert.equal(trade.exitUnknownAt, undefined); assert.equal(t.booked.length, 0); assert.equal(t.state.openTrades.length, 1)
    }
    // Partial: the slice is booked, the remainder keeps working.
    {
      const { t, trade } = mk()
      assert.equal(await t.reconcileUnknownExit(trade, { getFills: async () => [{ orderId: 'sell-1', shares: 0.5, price: 0.5, fee: 0.01 }] }), false)
      assert.equal(t.state.openTrades.length, 1); assert.equal(trade.shares, 1.5); assert.equal(trade.exitUnknownAt, undefined); assert.equal(t.booked[0].shares, 0.5)
    }
  })
  await test('B-32/B-33: the socket top is snapshotted after the REST book and the quote carries its read time', async () => {
    const ll: any = new LeadLagEngine(join(dir, 'll-b32.json'), () => undefined)
    ll.resolveSlug = async () => ({ upToken: 'tok', marketId: 'm1' })
    let top = { bid: 0.44, ask: 0.46, at: Date.now(), changes: 1 }
    ll.polyWs = { top: () => top }
    let fetchedAt = 0
    const saved = globalThis.fetch
    globalThis.fetch = (async () => {
      top = { bid: 0.50, ask: 0.52, at: Date.now(), changes: 2 }
      fetchedAt = Date.now()
      return { ok: true, json: async () => ({ bids: [{ price: '0.50' }], asks: [{ price: '0.52' }] }) }
    }) as any
    try {
      const q = await ll.polyQuote('slug')
      assert.equal(q.ws.bid, 0.50, 'the snapshot is the top at the instant the book arrived, not before the round trip')
      assert.ok(q.at >= fetchedAt && q.at <= Date.now())
      assert.equal(q.source, 'clob-book')
    } finally { globalThis.fetch = saved }
  })
  console.log(`remaining-defects: ${passed} scenarios passed`)
}
main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })
