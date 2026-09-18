import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PolymarketUsAdapter, usCashPnl } from '../../src/main/venues/polymarketUs'
import { reconcileUsLedger } from '../../src/main/venues/usLedger'
import { KalshiAdapter, conservativeKalshiPace, kalshiRequestRates } from '../../src/main/venues/kalshi'
import { RateLimiter } from '../../src/main/util/http'
import { HistoryStore } from '../../src/main/store/history'
import { FillReconciler } from '../../src/main/store/fillReconciler'
import { TradingEngine } from '../../src/main/engine/engine'
import { miniExitPnl } from '../../src/main/strategies/miniAuto'
import { AutoTrader } from '../../src/main/strategies/autoTrader'
import { FlowMonitor } from '../../src/main/strategies/flowMonitor'
import { writeFileAtomic } from '../../src/main/store/json'
import { detectIbkrGateway } from '../../src/main/venues/ibkrGateway'

const home = mkdtempSync(join(tmpdir(), 'oracle-completion-'))
const network = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Network forbidden in regressions') }
let passed = 0
async function test(name: string, run: () => any) { await run(); passed++; console.log('PASS ' + name) }
async function main() {
  await test('IBKR Gateway detection prefers paper and reports unavailable safely', async () => {
    assert.deepEqual(await detectIbkrGateway(async (port) => port === 4001), {
      connected: true,
      port: 4001,
      mode: 'live',
      message: 'Gateway API detected on localhost:4001 (live). Read-only integration can connect.'
    })
    assert.equal((await detectIbkrGateway(async () => false)).connected, false)
    assert.equal((await detectIbkrGateway(async () => true)).port, 4002)
  })
  await test('account limits choose a conservative paced allowance; malformed limits fail', async () => {
    const limits = { read: { refill_rate: 300, bucket_capacity: 900 }, write: { refill_rate: 300, bucket_capacity: 900 } }
    assert.equal(conservativeKalshiPace(limits, { default_cost: 10, endpoint_costs: [{ cost: 50 }] }), 334)
    assert.throws(() => conservativeKalshiPace({}, {}), /costs/)
    // Round 115: separate lanes from each bucket at the default call cost (this account: 300 tokens/s each, cost 10).
    assert.deepEqual(kalshiRequestRates(limits, { default_cost: 10, endpoint_costs: [{ cost: 50 }] }), { read: 10, write: 15 })
    assert.deepEqual(kalshiRequestRates({ read: { refill_rate: 20, bucket_capacity: 40 }, write: { refill_rate: 20, bucket_capacity: 40 } }, { default_cost: 10, endpoint_costs: [] }), { read: 1, write: 1 })
    assert.throws(() => kalshiRequestRates({}, { default_cost: 10, endpoint_costs: [] }), /limits/)
    const now = Date.now, timer = globalThis.setTimeout, cancel = globalThis.clearTimeout
    let clock = 1000, wake: (() => void) | undefined, delay = 0
    Date.now = () => clock
    globalThis.setTimeout = ((fn: () => void, ms: number) => { wake = fn; delay = ms; return 1 }) as any
    globalThis.clearTimeout = (() => {}) as any
    try {
      const limiter = new RateLimiter(1, 334); await limiter.wait()
      let released = false; const pending = limiter.wait().then(() => { released = true })
      await Promise.resolve(); assert.equal(released, false); assert.equal(delay, 344)
      clock += 344; wake!(); await pending; assert.equal(released, true)
    } finally { Date.now = now; globalThis.setTimeout = timer; globalThis.clearTimeout = cancel }
  })
  await test('US position pages preserve held-leg cost and reject cursor loops', async () => {
    const a: any = new PolymarketUsAdapter(); a.requireAuth = () => {}
    a.authGet = async (path: string) => path.includes('cursor=next') ? { positions: { y: { netPositionDecimal: '2', avgPx: { value: '0.4' } } }, eof: true }
      : { positions: { n: { netPositionDecimal: '-1', avgPx: { value: '0.9' } } }, nextCursor: 'next', eof: false }
    const p = await a.getPositions(); assert.equal(p.length, 2); assert.equal(p[0].avgPrice, 0.9)
    a.authGet = async () => ({ positions: {}, nextCursor: 'same', eof: false })
    await assert.rejects(a.getPositions(), /cursor/)
  })
  await test('US replay reconciles partial sales, opposite netting, open cost and settlement', () => {
    const rows: any[] = [{ type: 'ACTIVITY_TYPE_ACCOUNT_DEPOSIT', accountBalanceChange: { transactionId: 'd', status: 'ACCOUNT_BALANCE_CHANGE_STATUS_COMPLETED', amount: { value: '10', currency: 'USD' } } }]
    const trade = (id: string, intent: string, shares: number, yes: number, fee: number) => ({ type: 'ACTIVITY_TYPE_TRADE', trade: {
      id, marketSlug: 'M', createTime: `2026-09-01T00:00:0${id}Z`, isAggressor: false,
      passiveExecution: { order: { id, intent: 'ORDER_INTENT_' + intent }, lastShares: String(shares), lastPx: { value: String(yes) }, commissionNotionalCollected: { value: String(fee) } }
    } })
    rows.push(trade('1', 'BUY_SHORT', 2, 0.7, 0.02), trade('2', 'SELL_SHORT', 1, 0.6, 0.01), trade('3', 'BUY_LONG', 2, 0.5, 0.02))
    const open: any[] = [{ marketId: 'M', outcome: 'YES', shares: 1 }]
    const pnl = reconcileUsLedger(rows, open, 9.75, usCashPnl(rows, 9.75, 0))
    assert.ok(Math.abs(pnl.realizedPnl - 0.26) < 1e-9); assert.equal(pnl.openCostBasis, 0.51); assert.equal(pnl.pairedCash, 1)
    assert.throws(() => reconcileUsLedger(rows, [], 9.75, usCashPnl(rows, 9.75, 0)), /inventory/)
    assert.throws(() => reconcileUsLedger(rows, open, 9.76, usCashPnl(rows, 9.76, 0)), /Cash ledger mismatch/)
    rows.push({ type: 'ACTIVITY_TYPE_POSITION_RESOLUTION', positionResolution: { marketSlug: 'M', side: 'POSITION_RESOLUTION_SIDE_LONG', updateTime: '2026-09-01T00:01:00Z', beforePosition: { netPositionDecimal: '1' }, afterPosition: { netPositionDecimal: '0' } } })
    const closed = reconcileUsLedger(rows, [], 10.75, usCashPnl(rows, 10.75, 0))
    assert.ok(Math.abs(closed.realizedPnl - 0.75) < 1e-9); assert.equal(closed.openCostBasis, 0)
    assert.throws(() => reconcileUsLedger([...rows, rows[1]], [], 10.75, usCashPnl([...rows, rows[1]], 10.75, 0)), /duplicate trade/)
  })
  await test('closely spaced partial executions backfill once, survive restart and replace display summaries', async () => {
    const file = join(home, 'history.json'), state = join(home, 'reconciler.json')
    const history = new HistoryStore(file)
    history.record({ id: 'order', venue: 'kalshi', marketId: 'M', side: 'buy', outcome: 'YES', shares: 1, amount: 0.4, price: 0.4, timestamp: 1000 })
    writeFileSync(state, JSON.stringify({ seenFillIds: ['one', 'two'], lastFillTs: 1002 }))
    const fills = ['one', 'two'].map((id, i) => ({ id, orderId: 'order', marketId: 'M', side: 'buy', outcome: 'YES', shares: 1, price: 0.4, timestamp: 1000 + i }))
    const e: any = { getExecutionMode: () => 'live', getAdapter: () => ({ getFills: async () => fills }) }
    await new FillReconciler(e, history, state, 'kalshi', () => {}).run()
    assert.deepEqual(history.list().map(r => r.id), ['fill:two', 'fill:one'])
    assert.equal(history.stats().totalTrades, 2)
    await new FillReconciler(e, new HistoryStore(file), state, 'kalshi', () => {}).run()
    assert.equal(readFileSync(state + '.fills.jsonl', 'utf8').trim().split('\n').length, 2)
    assert.equal(new HistoryStore(file).stats().totalTrades, 2)
    writeFileSync(state + '.fills.jsonl', 'torn')
    const corrupt = new FillReconciler(e, history, state, 'kalshi', () => {}); await corrupt.run()
    assert.match(corrupt.status().lastError!, /archive unreadable/)
  })
  await test('Kalshi batch quotes preserve request sides while reducing 51 markets to two calls', async () => {
    const a: any = new KalshiAdapter(); let calls = 0
    a.http = { get: async (path: string) => { calls++; const ids = new URL('https://x' + path).searchParams.get('tickers')!.split(','); return { markets: ids.map(ticker => ({ ticker, yes_bid_dollars: '0.3', yes_ask_dollars: '0.5', no_bid_dollars: '0.5', no_ask_dollars: '0.7' })) } } }
    const p = await a.getPrices(Array.from({ length: 51 }, (_, i) => ({ marketId: String(i), outcome: i % 2 ? 'NO' : 'YES' })))
    assert.equal(calls, 2); assert.equal(p.length, 51); assert.equal(p[0].price, 0.4); assert.equal(p[1].price, 0.6)
    a.http.get = async () => ({ markets: [{}], cursor: 'incomplete' }); await assert.rejects(a.getPrices([{ marketId: '0', outcome: 'YES' }]), /Incomplete/)
  })
  await test('a Kalshi order with a known shard skips the market lookup', async () => {
    const a: any = new KalshiAdapter(); let lookups = 0, sent: any
    a.requireAuth = () => {}; a.ensureOrderGroup = async () => undefined
    a.fetchMarket = async () => { lookups++; return { ticker: 'KXBTC15M-X', exchange_index: 2 } }
    a.authPost = async (_: string, body: any) => { sent = body; return { order_id: 'o1', fill_count: '1', average_fill_price: '0.5', status: 'executed' } }
    await a.placeOrder({ venue: 'kalshi', marketId: 'KXBTC15M-X', outcome: 'YES', amount: 0.5, contracts: 1, limitPrice: 0.5, exchangeIndex: 2 })
    assert.equal(lookups, 0); assert.equal(a.shardOf.get('KXBTC15M-X'), 2); assert.equal(sent.ticker, 'KXBTC15M-X')
  })
  await test('writes use their own lane and do not queue behind reads', async () => {
    const { HttpClient } = await import('../../src/main/util/http')
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' })) as any
    try {
      const http = new HttpClient({ baseUrl: 'https://example.test', rateLimit: 1, rateLimitWindowMs: 60_000, writeRateLimit: 5, writeRateLimitWindowMs: 1000 })
      await http.get('/a')
      const post = http.post('/orders', {}).then(() => 'posted')
      const timeout = new Promise(r => setTimeout(() => r('waited'), 200))
      assert.equal(await Promise.race([post, timeout]), 'posted')
    } finally { globalThis.fetch = realFetch }
  })
  await test('Polymarket US catalog index: one background walk serves ending-soon without re-paging', async () => {
    const a: any = new PolymarketUsAdapter(); a.requireAuth = () => {}
    const day = 86_400_000, now = Date.now()
    const row = (slug: string, closeIn: number) => ({ slug, id: slug, question: slug, closed: false, status: 'MARKET_STATUS_ACTIVE', outcomes: ['Yes', 'No'], outcomePrices: ['0.5', '0.5'],
      marketSides: [{ long: true, price: '0.5' }, { long: false, price: '0.5' }], endDate: new Date(now + closeIn).toISOString(), gameStartTime: new Date(now + closeIn - 3600_000).toISOString() })
    // Page 0: 100 rows, half closing inside a week, half in two months. Page 1: 30 rows (short page ends the walk).
    const pages = [Array.from({ length: 100 }, (_, i) => row(`p0-${i}`, i % 2 ? 3 * day : 60 * day)), Array.from({ length: 30 }, (_, i) => row(`p1-${i}`, 2 * day))]
    let calls = 0
    a.gateway = { get: async (path: string) => { calls++; const off = Number(/offset=(\d+)/.exec(path)?.[1] ?? 0); return { markets: pages[off / 100] ?? [] } } }
    assert.equal(await a.refreshCatalog(), 80, '50 + 30 rows close inside the horizon')
    assert.equal(calls, 2)
    const got = await a.searchMarkets({ sort: 'ending-soon', limit: 1000, minCloseTime: now + 60_000, maxCloseTime: now + 5 * day })
    assert.equal(calls, 2, 'a fresh index serves the query with no further gateway calls')
    assert.equal(got.length, 80)
    assert.ok(got.every((m: any) => m.closeTime <= now + 5 * day))
    a.catalog.at = now - 46 * 60_000
    await a.searchMarkets({ sort: 'ending-soon', limit: 10, minCloseTime: now + 60_000, maxCloseTime: now + 5 * day })
    assert.ok(calls > 2, 'a stale index falls back to the paged walk')
  })
  await test('Kalshi account pagination completes beyond 50 pages and rejects repeated cursors', async () => {
    const a: any = new KalshiAdapter(); let n = 0
    a.authGet = async () => ({ fills: [{ id: ++n }], cursor: n < 65 ? String(n) : '' })
    assert.equal((await a.authPaged('/portfolio/fills', 'fills', Infinity)).length, 65)
    a.authGet = async () => ({ fills: [{}], cursor: 'same' })
    await assert.rejects(a.authPaged('/portfolio/fills', 'fills', Infinity), /cursor/)
  })
  await test('US account cash removes collateral, missing ledgers fail, and executions expose fees', async () => {
    const a: any = new PolymarketUsAdapter(); a.requireAuth = () => {}
    a.authGet = async () => ({ balances: [{ currency: 'USD', currentBalance: 40.87775, marginRequirement: 16.04 }] })
    assert.ok(Math.abs((await a.getAccount()).balance - 24.83775) < 1e-9)
    a.authGet = async () => ({ balances: [{ currency: 'USD', currentBalance: 40.87775 }] })
    await assert.rejects(a.getAccount(), /margin/); await assert.rejects(a.getOpenOrders(), /orders ledger/)
    a.authPost = async () => ({ id: 'paid', executions: [{ lastShares: '2', lastPx: { value: '0.075' }, commissionNotionalCollected: { value: '0.02' } }] })
    const buy = await a.placeOrder({ marketId: 'M', outcome: 'NO', amount: 2 })
    assert.equal(buy.avgPrice, 0.925); assert.equal(buy.fee, 0.02)
    a.getPositions = async () => [{ marketId: 'M', outcome: 'NO', shares: 2, avgPrice: 0.9 }]
    assert.equal((await a.sellPosition({ marketId: 'M', outcome: 'NO', shares: 2 })).fee, 0.02)
  })
  await test('portfolio coalesces cold requests, separates modes and surfaces failed exposure reads', async () => {
    let reads = 0, release!: (r: any) => void
    const adapter: any = { currency: 'USD', getAccount: async () => { reads++; return new Promise(r => { release = r }) }, getPositions: async () => [] }
    const e: any = new TradingEngine({ get: () => adapter } as any, new HistoryStore(join(home, 'portfolio-history.json')))
    e.setExecutionMode('live')
    const one = e.getPortfolio('kalshi'), two = e.getPortfolio('kalshi')
    assert.equal(reads, 1); release({ balance: 10, portfolioValue: 2 })
    assert.equal((await one).totalValue, 12); assert.equal(await one, await two)
    e.setExecutionMode('paper'); await assert.rejects(e.getPortfolio('kalshi'), /paper broker/)
    e.setExecutionMode('live'); e.portfolioCache.clear()
    adapter.getAccount = async () => ({ balance: 10 }); adapter.getPositions = async () => { throw new Error('positions offline') }
    await assert.rejects(e.getPortfolio('kalshi'), /positions offline/)
  })
  await test('mini exits use actual fills, owned basis and fees, preserving paper realized accounting', () => {
    const result: any = { venue: 'polymarket-us', shares: 0.5, avgPrice: 0.7, fee: 0.01, realizedPnl: 99 }
    assert.ok(Math.abs(miniExitPnl({ entryPrice: 0.61 }, result) - 0.035) < 1e-9)
    assert.equal(miniExitPnl({ entryPrice: 0.61 }, { ...result, paper: true, realizedPnl: 0.025 }), 0.025)
  })
  await test('flow reads overlap in bounded batches without skipping the ranked sample', async () => {
    const a: any = Object.create(AutoTrader.prototype); let active = 0, max = 0, reads = 0
    a.engine = { getAdapter: () => ({ getRecentTrades: async () => [] }) }; a.config = {}
    a.flowMonitor = { read: async () => { active++; reads++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 1)); active--; return null } }
    assert.deepEqual(await a.flowSignals(Array.from({ length: 20 }, (_, i) => ({ id: String(i), probability: 0.5 }))), [])
    assert.equal(reads, 20); assert.equal(max, 4)
  })
  await test('a reconciliation gap forces full pagination on the next run', async () => {
    const file = join(home, 'gap.json'); writeFileSync(file, JSON.stringify({ schemaVersion: 2, lastFillTs: 1, seenFillIds: ['old'] }))
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), marketId: 'M', shares: 1, price: 0.4, outcome: 'YES', side: 'buy', timestamp: i + 2 }))
    const limits: number[] = []
    const e: any = { getExecutionMode: () => 'live', getAdapter: () => ({ getFills: async (limit: number) => { limits.push(limit); return rows } }) }
    const r = new FillReconciler(e, new HistoryStore(join(home, 'gap-history.json')), file, 'kalshi', () => {})
    await r.run(); assert.equal(r.status().completeness, 'partial')
    await r.run(); assert.deepEqual(limits, [1000, Infinity]); assert.equal(r.status().completeness, 'ok')
  })
  await test('expired flow is unavailable when its refresh fails', async () => {
    const monitor = new FlowMonitor(); const adapter: any = { getRecentTrades: async () => [] }
    assert.ok(await monitor.read(adapter, 'M', 1000))
    adapter.getRecentTrades = async () => { throw new Error('offline') }
    assert.equal(await monitor.read(adapter, 'M', 1000000), null)
  })
  await test('interrupted atomic settings replacement preserves the previous complete file', () => {
    const path = join(home, 'atomic.json'), fs = require('node:fs'), rename = fs.renameSync
    writeFileAtomic(path, '{"before":true}')
    try {
      fs.renameSync = () => { throw new Error('simulated interruption before replacement') }
      assert.throws(() => writeFileAtomic(path, '{"after":true}'), /interruption/)
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { before: true })
    } finally { fs.renameSync = rename }
    writeFileAtomic(path, '{"after":true}')
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { after: true })
  })
  await test('missing batch quotes still probe settlement with a future cached close, once per interval', async () => {
    const a: any = Object.create(AutoTrader.prototype); let probes = 0
    a.config = { dryRun: false }; a.settleProbeAt = new Map()
    a.state = { openTrades: [{ id: 'missing', marketId: 'M', strategy: 'consensus', outcome: 'YES', shares: 1, closeTime: Date.now() + 86400000 }] }
    a.engine = { getAdapter: () => ({ getPrices: async () => [] }), getExecutionMode: () => 'live' }
    a.trySettle = async () => { probes++ }
    await a.manageExits({}); await a.manageExits({}); assert.equal(probes, 1)
  })
  console.log(`completion: ${passed} scenarios passed`)
}
main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => { globalThis.fetch = network; rmSync(home, { recursive: true, force: true }) })
