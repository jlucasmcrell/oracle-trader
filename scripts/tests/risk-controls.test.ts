/** Money-path regressions: real engines, temporary ledgers, fake venues; no network or Electron. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TradingEngine } from '../../src/main/engine/engine'
import { PreSubmitRefusal } from '../../src/main/engine/engine'
import { LeadLagEngine } from '../../src/main/strategies/leadLag'
import { AutoTrader } from '../../src/main/strategies/autoTrader'
import { Ladder, decideStage } from '../../src/main/ladder/ladder'
import { HttpError } from '../../src/main/util/http'
import { FillReconciler } from '../../src/main/store/fillReconciler'
import { KalshiAdapter } from '../../src/main/venues/kalshi'

const dir = mkdtempSync(join(tmpdir(), 'oracle-risk-'))
const realNow = Date.now
const realFetch = globalThis.fetch
let now = Date.parse('2026-09-15T12:05:00Z')
Date.now = () => now
globalThis.fetch = async () => { throw new Error('Network forbidden in risk tests') }
let passed = 0
// A test whose promise never settles lets Node exit 0 with no output; that must fail, not pass.
let finished = false
process.on('exit', () => { if (!finished) { console.error('risk-controls: stopped before finishing (a test never resolved)'); process.exitCode = 1 } })
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run()
  passed++
  console.log(`PASS ${name}`)
}
const cfg = {
  leadLagEnabled: true, leadLagLiveEnabled: true, leadLagMinDislocationCents: 4, leadLagMaxSpreadCents: 5,
  leadLagMaxContractsPerOrder: 1, leadLagMaxCapitalSpend: 1, leadLagMaxContractsPerWindow: 1,
  leadLagMaxSpendPerWindow: 0.5, leadLagProvenCoins: ['BTC'], leadLagNewCoinContracts: 1,
  leadLagMaxCoinsPerDirectionPerWindow: 1, pollIntervalMs: 10_000
}
const row = () => ({ ts: new Date(now).toISOString(), underlying: 'BTC', kalshiTicker: 'KXBTC15M-TEST',
  polyMarketId: 'test', polyPrice: 0.6, kalshiPrice: 0.49, dislocationCents: 11,
  suggestedAction: 'BUY_KALSHI_YES', clearsFees: true, executed: false })
const lead = (name: string): any => new LeadLagEngine(join(dir, name + '.json'), () => undefined)
const sweep = (l: any, venue: any) => l.sweep(venue, row(), 'YES', 0.49, cfg)

async function main(): Promise<void> {
  // Audit 2026-09-19 B-02: a failed positions read resolved to [] and read as "no positions" downstream.
  await test('a failed Kalshi positions read rejects; a missing shard does not', async () => {
    const a: any = new KalshiAdapter()
    a.requireAuth = () => {}
    a.authGet = async () => { throw new HttpError(503, 'upstream') }
    await assert.rejects(a.getPositions(), /upstream/)
    a.authGet = async (path: string) => {
      if (/exchange_index=3/.test(path)) throw new HttpError(404, 'no such shard')
      return { market_positions: [{ ticker: 'KXA', position_fp: '1', market_exposure_dollars: '0.5' }] }
    }
    assert.equal((await a.getPositions()).length, 1, 'a 4xx shard contributes nothing and does not reject')
    a.authGet = async (path: string) => {
      if (/exchange_index=2/.test(path)) throw new HttpError(429, 'rate limited')
      return { market_positions: [] }
    }
    await assert.rejects(a.getPositions(), /rate limited/, 'a throttled shard would make the merged view partial')
  })
  await test('concurrent entries cannot share the last position slot', async () => {
    const placed: any[] = []
    const venue: any = { getPositions: async () => placed.slice(), getOpenOrders: async () => [],
      placeOrder: async (o: any) => { placed.push(o); return { orderId: o.marketId, shares: 1, avgPrice: 0.5, timestamp: now } } }
    const e = new TradingEngine({ get: () => venue } as any, { record: () => undefined } as any)
    e.setExecutionMode('live')
    e.setRiskLimits({ maxStakePerBet: 1, maxOpenPositions: 1 })
    const results = await Promise.allSettled(['A', 'B'].map(marketId => e.placeOrder({ venue: 'kalshi', marketId, outcome: 'YES', amount: 0.5 })))
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(placed.length, 1)
  })
  // 2026-09-19 (§129, Gemini Flash F-01): an exit expressed as a buy of the opposite side (closeFrom) is not an entry.
  // It must pass at the cap, reserve nothing, and be recorded as a sell of the position it closes.
  await test('a closeFrom exit passes the position cap and records a sell', async () => {
    const placed: any[] = []
    const recorded: any[] = []
    const venue: any = {
      getPositions: async () => [{ venue: 'ibkr', marketId: 'A', outcome: 'YES', shares: 1, avgPrice: 0.5, currentPrice: 0.6 }],
      getOpenOrders: async () => [],
      placeOrder: async (o: any) => { placed.push(o); return { orderId: 'x-' + o.marketId, shares: 1, avgPrice: 0.4, venueStatus: 'executed', timestamp: now } },
      closeAsBuy: async (req: any) => ({ venue: 'ibkr', marketId: 'A-NO', outcome: 'NO', amount: 0.4, closeFrom: req.marketId })
    }
    const e = new TradingEngine({ get: () => venue } as any, { record: (r: any) => { recorded.push(r) } } as any)
    e.setExecutionMode('live')
    e.setRiskLimits({ maxStakePerBet: 1, maxOpenPositions: 1 })
    await assert.rejects(() => e.placeOrder({ venue: 'ibkr', marketId: 'B', outcome: 'YES', amount: 0.5 }), /max open positions/)
    const res = await e.sellPosition({ venue: 'ibkr', marketId: 'A', outcome: 'YES', shares: 1 } as any)
    assert.equal(res.orderId, 'x-A-NO')
    assert.equal(placed.length, 1)
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].side, 'sell')
    assert.equal(recorded[0].marketId, 'A')
    await assert.rejects(() => e.placeOrder({ venue: 'ibkr', marketId: 'C', outcome: 'YES', amount: 0.5 }), /max open positions/)
    // Audit 2026-09-19 B-35: the cap-DISABLED path (the operator's default, maxOpenPositions 0) records the same sell.
    const recorded2: any[] = []
    const e2 = new TradingEngine({ get: () => venue } as any, { record: (r: any) => { recorded2.push(r) } } as any)
    e2.setExecutionMode('live')
    e2.setRiskLimits({ maxStakePerBet: 0, maxOpenPositions: 0 })
    await e2.sellPosition({ venue: 'ibkr', marketId: 'A', outcome: 'YES', shares: 1 } as any)
    assert.equal(recorded2.length, 1)
    assert.equal(recorded2[0].side, 'sell')
    assert.equal(recorded2[0].marketId, 'A')
  })
  await test('a rejected entry releases the queue for the next entry', async () => {
    let attempts = 0
    const venue: any = { getPositions: async () => [], getOpenOrders: async () => [], placeOrder: async () => {
      if (++attempts === 1) throw new HttpError(400, 'rejected')
      return { orderId: 'B', shares: 1, avgPrice: 0.5, timestamp: now }
    } }
    const e = new TradingEngine({ get: () => venue } as any, { record: () => undefined } as any)
    e.setExecutionMode('live')
    e.setRiskLimits({ maxStakePerBet: 1, maxOpenPositions: 1 })
    // Round 115: the slot is reserved before submission, so a simultaneous second entry is refused while the first is
    // in flight (never past the cap); once the first is rejected, the slot is free for the next entry.
    await assert.rejects(() => e.placeOrder({ venue: 'kalshi', marketId: 'A', outcome: 'YES', amount: 0.5 }), /rejected/)
    const next = await e.placeOrder({ venue: 'kalshi', marketId: 'B', outcome: 'YES', amount: 0.5 })
    assert.equal(next.orderId, 'B')
  })
  await test('position cap caches venue reads, increments locally, and refreshes after three seconds', async () => {
    const placed: any[] = []
    let positionReads = 0
    let orderReads = 0
    const venue: any = {
      getPositions: async () => { positionReads++; return placed.slice() },
      getOpenOrders: async () => { orderReads++; return [] },
      placeOrder: async (o: any) => { placed.push(o); return { orderId: o.marketId, shares: 1, avgPrice: 0.5, venueStatus: 'executed', timestamp: now } }
    }
    const e = new TradingEngine({ get: () => venue } as any, { record: () => undefined } as any)
    e.setExecutionMode('live')
    e.setRiskLimits({ maxStakePerBet: 1, maxOpenPositions: 2 })
    await e.placeOrder({ venue: 'kalshi', marketId: 'A', outcome: 'YES', amount: 0.5 })
    await e.placeOrder({ venue: 'kalshi', marketId: 'B', outcome: 'YES', amount: 0.5 })
    await assert.rejects(() => e.placeOrder({ venue: 'kalshi', marketId: 'C', outcome: 'YES', amount: 0.5 }), /At max open positions/)
    assert.deepEqual({ placed: placed.length, positionReads, orderReads }, { placed: 2, positionReads: 1, orderReads: 1 })
    now += 30_001
    await assert.rejects(() => e.placeOrder({ venue: 'kalshi', marketId: 'C', outcome: 'YES', amount: 0.5 }), /At max open positions/)
    assert.deepEqual({ placed: placed.length, positionReads, orderReads }, { placed: 2, positionReads: 2, orderReads: 2 })
  })
  await test('window spending, contracts and direction survive a restart', async () => {
    let orders = 0
    const venue: any = { placeOrder: async () => { orders++; return { shares: 1, avgPrice: 0.5 } } }
    const before = lead('restart')
    await sweep(before, venue)
    await sweep(before, venue)
    const after = lead('restart')
    await sweep(after, venue)
    assert.equal(orders, 1)
    assert.equal(after.windowSpend, 0.5)
    assert.equal(after.windowFills.get('KXBTC15M-TEST').contracts, 1)
    assert.deepEqual([...after.windowDir.YES], ['BTC'])
  })
  await test('timeout after acceptance keeps its reservation across restart', async () => {
    let accepted = 0
    const venue: any = { placeOrder: async () => { accepted++; throw new Error('response lost after fill') } }
    await sweep(lead('uncertain'), venue)
    await sweep(lead('uncertain'), venue)
    assert.equal(accepted, 1)
    const saved = JSON.parse(readFileSync(join(dir, 'uncertain.json'), 'utf8'))
    assert.equal(saved.window.spend, 0.5)
    assert.deepEqual(saved.window.directions.YES, ['BTC'])
  })
  await test('explicit rejection and confirmed zero fill release reservations', async () => {
    const l = lead('release')
    await sweep(l, { placeOrder: async () => { throw new HttpError(400, 'rejected') } })
    assert.equal(l.windowSpend, 0)
    await sweep(l, { placeOrder: async () => ({ shares: 0, avgPrice: 0 }) })
    assert.equal(l.windowSpend, 0)
    assert.equal(l.windowDir.YES.size, 0)
    await sweep(l, { placeOrder: async () => ({ shares: 1, avgPrice: 0.5 }) })
    assert.equal(l.windowSpend, 0.5)
  })
  await test('reservation is durable before the venue call begins', async () => {
    const l = lead('before-submit')
    await sweep(l, { placeOrder: async () => {
      const saved = JSON.parse(readFileSync(join(dir, 'before-submit.json'), 'utf8'))
      assert.equal(saved.window.spend, 0.5)
      assert.equal(saved.window.fills[0][1].contracts, 1)
      return { shares: 1, avgPrice: 0.5 }
    } })
    assert.equal(l.state.tradesExecuted, 1)
  })
  await test('failed reservation persistence prevents order submission', async () => {
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const l: any = new LeadLagEngine(join(blocker, 'state.json'), () => undefined)
    let orders = 0
    await sweep(l, { placeOrder: async () => { orders++; return { shares: 1, avgPrice: 0.5 } } })
    assert.equal(orders, 0)
  })
  await test('legacy state holds one window then resumes without changing config', async () => {
    writeFileSync(join(dir, 'legacy.json'), JSON.stringify({ history: [], tradesExecuted: 9, dislocationsLogged: 20 }))
    let orders = 0
    const venue: any = { placeOrder: async () => { orders++; return { shares: 1, avgPrice: 0.5 } } }
    await sweep(lead('legacy'), venue)
    assert.equal(orders, 0)
    now += 900_000
    const l = lead('legacy')
    await sweep(l, venue)
    assert.equal(orders, 1)
    assert.equal(l.state.tradesExecuted, 10)
  })
  await test('malformed window state does not grant a fresh budget', async () => {
    writeFileSync(join(dir, 'malformed.json'), JSON.stringify({ history: [], window: {} }))
    let orders = 0
    await sweep(lead('malformed'), { placeOrder: async () => { orders++; return { shares: 1, avgPrice: 0.5 } } })
    assert.equal(orders, 0)
  })
  await test('sub-engine trip persists through recovery and resets the next UTC day', () => {
    // nowDate uses new Date(), so use the actual UTC day for the AutoTrader fixture.
    const date = new Date().toISOString().slice(0, 10)
    const t: any = Object.create(AutoTrader.prototype)
    t.config = { maxDailyLossPct: 20 }
    t.engine = { getExecutionMode: () => 'live' }
    t.lastEquity = 100
    t.state = { daily: { date, count: 0 }, dailyPnl: { date, realized: 0, tripped: false },
      venueDay: { date, realized: -21, fetchedAt: now }, perf: { realizedPnl: 0, trades: 0 } }
    let saves = 0
    t.persist = () => { saves++ }
    t.emit = () => undefined
    t.alert = () => undefined
    assert.equal(t.subEngineKilled(), true)
    assert.equal(t.state.dailyPnl.tripped, true)
    assert.ok(saves > 0)
    t.state.venueDay.realized = -19
    assert.equal(t.subEngineKilled(), true)
    t.state.dailyPnl.date = '2000-01-01'
    assert.equal(t.subEngineKilled(), false)
    assert.equal(t.state.dailyPnl.tripped, false)
    t.lastEquity = undefined
    assert.equal(t.subEngineKilled(), true)
  })
  await test('operator reset preserves ledgers, measures further losses and expires next day', () => {
    const date = new Date().toISOString().slice(0, 10)
    const t: any = Object.create(AutoTrader.prototype)
    t.config = { maxDailyLossPct: 20 }
    t.engine = { getExecutionMode: () => 'live' }
    t.state = { dailyPnl: { date, realized: 1.58, tripped: false },
      venueDay: { date, realized: -24.09 },
      killReset: { date, at: now, local: 1.58, venue: -24.09, reason: 'operator authorized' } }
    t.persist = t.emit = t.alert = () => undefined
    assert.equal(t.killSwitchCheck(80), null)
    assert.equal(t.state.venueDay.realized, -24.09)
    t.state.venueDay.realized = -41
    assert.match(t.killSwitchCheck(80), /TRIPPED/)
    t.state.dailyPnl.tripped = false
    t.state.venueDay.realized = -24.09
    t.state.dailyPnl.realized = -16
    assert.match(t.killSwitchCheck(80), /TRIPPED/)
    t.state.killReset.date = '2000-01-01'
    assert.deepEqual(t.dayRealizedForKill(), { realized: -24.09, source: 'venue' })
  })
  await test('twenty lead-lag settlements on one day count as one cluster', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ marketId: 'KXBTC15M-' + i, timestamp: now, realizedPnl: -0.1 }))
    writeFileSync(join(dir, 'leadlag-dislocations.jsonl'), rows.map(r => JSON.stringify({
      kalshiTicker: r.marketId, executed: true, filledContracts: 1, underlying: 'BTC', ts: new Date(now).toISOString()
    })).join('\n'))
    const l: any = Object.create(Ladder.prototype)
    l.userData = dir
    l.autoTrader = { getConfig: () => ({ leadLagProvenCoins: ['BTC', 'ETH'] }) }
    l.engine = { getLivePnl: async () => ({ details: rows }) }
    const evidence = await l.leadLagEvidence(now - 1000, 1)
    assert.equal(evidence.clusters, 1)
    assert.equal(decideStage(evidence, 1, 0).kind, 'hold')
  })
  await test('live orders never wait on account reads while the count is fresh, and submit concurrently', async () => {
    let reads = 0, inFlight = 0, overlap = 0
    let releaseRead!: () => void
    const venue: any = {
      getPositions: async () => { reads++; if (reads > 1) await new Promise<void>(r => { releaseRead = r }); return [] },
      getOpenOrders: async () => [],
      placeOrder: async (o: any) => { inFlight++; overlap = Math.max(overlap, inFlight); await new Promise(r => setImmediate(r)); inFlight--; return { orderId: o.marketId, shares: 1, avgPrice: 0.5, timestamp: now } }
    }
    const e = new TradingEngine({ get: () => venue } as any, { record: () => undefined } as any)
    e.setExecutionMode('live')
    e.setRiskLimits({ maxStakePerBet: 10, maxOpenPositions: 10 })
    await e.placeOrder({ venue: 'kalshi', marketId: 'warm', outcome: 'YES', amount: 0.5 })
    now += 6_000
    // The background refresh now blocks forever; orders must still go.
    const burst = await Promise.all(['A', 'B', 'C'].map(marketId => e.placeOrder({ venue: 'kalshi', marketId, outcome: 'YES', amount: 0.5 })))
    assert.equal(burst.length, 3)
    assert.equal(reads, 2, 'one background refresh started, none awaited')
    assert.ok(overlap >= 2, 'submissions overlap instead of queueing behind each other')
    releaseRead()
  })
  await test('a zero fill landing during a background read cannot open room past the cap (GPT reproduction)', async () => {
    let reads = 0, filled = 0
    let releaseRead!: () => void, releaseA!: () => void
    const venue: any = {
      getPositions: async () => { reads++; if (reads === 2) await new Promise<void>(r => { releaseRead = r }); return new Array(filled).fill({}) },
      getOpenOrders: async () => [],
      placeOrder: async (o: any) => {
        if (o.marketId === 'A') { await new Promise<void>(r => { releaseA = r }); return { orderId: 'A', shares: 0, avgPrice: 0.5, timestamp: now } }
        filled++
        return { orderId: o.marketId, shares: 1, avgPrice: 0.5, timestamp: now }
      }
    }
    const e = new TradingEngine({ get: () => venue } as any, { record: () => undefined } as any)
    e.setExecutionMode('live')
    e.setRiskLimits({ maxStakePerBet: 1, maxOpenPositions: 1 })
    e.warmOpenPositionCount('kalshi')
    await new Promise(r => setImmediate(r))
    const a = e.placeOrder({ venue: 'kalshi', marketId: 'A', outcome: 'YES', amount: 0.5 })
    await new Promise(r => setImmediate(r))
    now += 6_000
    e.warmOpenPositionCount('kalshi')
    await new Promise(r => setImmediate(r))
    assert.equal(reads, 2, 'a background read is in flight while A is')
    releaseA(); await a
    releaseRead(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r))
    const results = await Promise.allSettled(['B', 'C'].map(marketId => e.placeOrder({ venue: 'kalshi', marketId, outcome: 'YES', amount: 0.5 })))
    assert.equal(filled, 1, 'only one order may fill against a cap of one')
    assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected'])
  })
  await test('a read that cannot see an in-flight or just-filled order keeps its reservation counted', async () => {
    let releaseA!: () => void, releaseRead!: () => void, blockRead = false
    const held: any[] = []
    const venue: any = {
      getPositions: async () => { const snap = held.slice(); if (blockRead) await new Promise<void>(r => { releaseRead = r }); return snap },
      getOpenOrders: async () => [],
      placeOrder: async (o: any) => {
        if (o.marketId === 'A') await new Promise<void>(r => { releaseA = r })
        held.push(o)
        return { orderId: o.marketId, shares: 1, avgPrice: 0.5, timestamp: now }
      }
    }
    const e = new TradingEngine({ get: () => venue } as any, { record: () => undefined } as any)
    e.setExecutionMode('live')
    e.setRiskLimits({ maxStakePerBet: 1, maxOpenPositions: 1 })
    e.warmOpenPositionCount('kalshi')
    await new Promise(r => setImmediate(r))
    const a = e.placeOrder({ venue: 'kalshi', marketId: 'A', outcome: 'YES', amount: 0.5 })
    await new Promise(r => setImmediate(r))
    // A read completes while A is still in flight and the venue shows nothing.
    now += 6_000
    e.warmOpenPositionCount('kalshi')
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r))
    await assert.rejects(() => e.placeOrder({ venue: 'kalshi', marketId: 'B', outcome: 'YES', amount: 0.5 }), /At max open positions/)
    // A read snapshots before A fills and completes after: A settled during it, so it still cannot vouch for A.
    now += 6_000
    blockRead = true
    e.warmOpenPositionCount('kalshi')
    await new Promise(r => setImmediate(r))
    releaseA(); await a
    now += 3_000
    releaseRead(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r))
    held.length = 0
    await assert.rejects(() => e.placeOrder({ venue: 'kalshi', marketId: 'C', outcome: 'YES', amount: 0.5 }), /At max open positions/)
  })
  await test('a zero-fill live order gives its reserved slot back', async () => {
    let fills = 0
    const venue: any = { getPositions: async () => [], getOpenOrders: async () => [],
      placeOrder: async (o: any) => ({ orderId: o.marketId, shares: fills++ ? 1 : 0, avgPrice: 0.5, timestamp: now }) }
    const e = new TradingEngine({ get: () => venue } as any, { record: () => undefined } as any)
    e.setExecutionMode('live')
    e.setRiskLimits({ maxStakePerBet: 1, maxOpenPositions: 1 })
    await e.placeOrder({ venue: 'kalshi', marketId: 'miss', outcome: 'YES', amount: 0.5 })
    const hit = await e.placeOrder({ venue: 'kalshi', marketId: 'hit', outcome: 'YES', amount: 0.5 })
    assert.equal(hit.shares, 1)
    await assert.rejects(() => e.placeOrder({ venue: 'kalshi', marketId: 'third', outcome: 'YES', amount: 0.5 }), /At max open positions/)
  })
  await test('warming the count reads the venue in the background once', async () => {
    let reads = 0
    const venue: any = { getPositions: async () => { reads++; return [] }, getOpenOrders: async () => [] }
    const e = new TradingEngine({ get: () => venue } as any, { record: () => undefined } as any)
    e.setExecutionMode('live')
    e.setRiskLimits({ maxStakePerBet: 1, maxOpenPositions: 5 })
    e.warmOpenPositionCount('kalshi'); e.warmOpenPositionCount('kalshi')
    await new Promise(r => setImmediate(r))
    assert.equal(reads, 1)
    e.warmOpenPositionCount('kalshi'); await new Promise(r => setImmediate(r))
    assert.equal(reads, 1, 'a fresh count is not re-read')
  })
  await test('lead-lag passes the shard and records sweep latency', async () => {
    let shard: number | undefined
    const l = lead('latency')
    await l.sweep({ placeOrder: async (o: any) => { shard = o.exchangeIndex; return { shares: 1, avgPrice: 0.5 } } }, row(), 'YES', 0.49, cfg, 2)
    assert.equal(shard, 2)
    const executed = readFileSync(join(dir, 'latency-dislocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).pop()
    assert.equal(typeof executed.latencyMs, 'number')
    assert.equal(typeof executed.submitMs, 'number')
  })
  await test('a repeating reconciler failure is logged once per ten minutes', async () => {
    const lines: string[] = []
    const engine: any = { getExecutionMode: () => 'live', reconcileOrders: async () => undefined,
      getAdapter: () => ({ getFills: async () => { throw new Error('Gateway API not available yet') } }) }
    const rec = new FillReconciler(engine, { record: () => undefined } as any, join(dir, 'recon-throttle.json'), 'ibkr', s => lines.push(s))
    for (let i = 0; i < 5; i++) { await rec.run(); now += 60_000 }
    assert.equal(lines.filter(l => l.includes('run failed')).length, 1)
    now += 10 * 60_000
    await rec.run()
    assert.equal(lines.filter(l => l.includes('run failed')).length, 2)
  })
  // 2026-09-20 (audit B-52): the stake cap sat ABOVE the closeFrom exemption, so a cheap large position
  // entered under the cap could not be exited through the engine at all.
  await test('B-52: a closeFrom exit above the stake cap is not refused', async () => {
    const placed: any[] = []
    const venue: any = {
      getPositions: async () => [],
      getOpenOrders: async () => [],
      placeOrder: async (o: any) => { placed.push(o); return { venue: 'ibkr', marketId: o.marketId, outcome: o.outcome, orderId: 'x', shares: 80, amount: o.amount, avgPrice: 0.2, timestamp: Date.now(), status: 'filled' } }
    }
    const e = new TradingEngine({ get: () => venue } as any, { record: () => undefined } as any)
    e.setExecutionMode('live')
    e.setRiskLimits({ maxStakePerBet: 10, maxOpenPositions: 80 })
    await assert.rejects(() => e.placeOrder({ venue: 'ibkr', marketId: 'B', outcome: 'NO', amount: 65 }), /max stake per bet/)
    const res = await e.placeOrder({ venue: 'ibkr', marketId: 'A', outcome: 'NO', amount: 65, closeFrom: 'A' } as any)
    assert.equal(res.shares, 80)
    assert.equal(placed.length, 1, 'the exit reached the venue')
  })
  // 2026-09-20 (audit B-58): a refusal raised before any POST must be distinguishable from an ambiguous
  // response, or lead-lag logs it as an "uncertain order" and holds the window's budget and direction seat
  // for a sweep that never left the process.
  await test('B-58: pre-submission refusals are a PreSubmitRefusal, a venue rejection is not', async () => {
    const offline: any = {
      getPositions: async () => { throw new Error('positions offline') },
      getOpenOrders: async () => [],
      placeOrder: async () => { throw new HttpError(400, 'rejected') }
    }
    const e = new TradingEngine({ get: () => offline } as any, { record: () => undefined } as any)
    e.setExecutionMode('live')
    e.setRiskLimits({ maxStakePerBet: 1, maxOpenPositions: 80 })
    await assert.rejects(() => e.placeOrder({ venue: 'kalshi', marketId: 'A', outcome: 'YES', amount: 9 }),
      (err: any) => err instanceof PreSubmitRefusal && /max stake per bet/.test(err.message))
    e.setRiskLimits({ maxStakePerBet: 0, maxOpenPositions: 2 })
    await assert.rejects(() => e.placeOrder({ venue: 'kalshi', marketId: 'A', outcome: 'YES', amount: 0.5 }),
      (err: any) => err instanceof PreSubmitRefusal && /Position cap check failed/.test(err.message))
    const up: any = { ...offline, getPositions: async () => [] }
    const open = new TradingEngine({ get: () => up } as any, { record: () => undefined } as any)
    open.setExecutionMode('live')
    open.setRiskLimits({ maxStakePerBet: 0, maxOpenPositions: 80 })
    await assert.rejects(() => open.placeOrder({ venue: 'kalshi', marketId: 'A', outcome: 'YES', amount: 0.5 }),
      (err: any) => err instanceof HttpError && !(err instanceof PreSubmitRefusal))
  })

  console.log(`risk-controls: ${passed} scenarios passed`)
  finished = true
}
main().catch(err => { console.error(err); process.exitCode = 1 }).finally(() => {
  Date.now = realNow
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
})
