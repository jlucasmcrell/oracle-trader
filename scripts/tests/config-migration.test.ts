import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Module from 'node:module'
const home = mkdtempSync(join(tmpdir(), 'oracle-migration-'))
const loader = (Module as any)._load
const network = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Network forbidden') }
;(Module as any)._load = function (id: string, ...args: any[]) {
  if (id === 'electron') return { app: { getPath: () => home, getAppPath: () => home }, safeStorage: { isEncryptionAvailable: () => false } }
  if (id === '../services/liveSpot') return { liveSpotFeed: { start: () => {} } } // Configuration test has no market-data connection.
  return loader.call(this, id, ...args)
}
try {
  const { AutoTrader } = require('../../src/main/strategies/autoTrader')
  const file = join(home, 'auto.json')
  const first = new AutoTrader({}, file)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).configVersion, 27)
  first.setConfig({ maxOpenPositions: 7, enabled: false, autoPoll: false, bookLogging: false })
  const second = new AutoTrader({}, file)
  assert.equal(second.getConfig().maxOpenPositions, 7)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).configVersion, 27)

  // ---- audit 2026-09-19 B-01: reset() is paper-only, whoever calls it ----
  {
    let cancels = 0
    let mode: 'live' | 'paper' = 'live'
    const engine: any = { getExecutionMode: () => mode, getAdapter: () => ({ cancelOrder: async () => { cancels++ } }) }
    const t: any = new AutoTrader(engine, join(home, 'reset-guard.json'))
    t.state.openTrades = [{ id: 't1', marketId: 'KXA', outcome: 'NO', shares: 1, amount: 0.9, entryPrice: 0.9, strategy: 'fade', createdAt: Date.now() }]
    t.state.pendingOrders = [{ orderId: 'o1', marketId: 'KXB', outcome: 'NO', yesPrice: 0.05, count: 1, strategy: 'fade' }]
    assert.throws(() => t.reset(), /paper-only/)
    assert.equal(cancels, 0, 'a live reset cancels nothing')
    assert.equal(t.state.openTrades.length, 1, 'a live reset forgets nothing')
    mode = 'paper'; t.busy = true; t.reset(); assert.equal(t.resetRequested, true, 'a busy paper reset defers')
    mode = 'live'; t.busy = false; t.doReset(); assert.equal(t.state.openTrades.length, 1, 'the deferred reset re-checks the mode')
    mode = 'paper'; t.reset()
    assert.equal(cancels, 1); assert.equal(t.state.openTrades.length, 0)
  }

  // ---- lead-lag gap floor is a config field with a clamp (2026-09-18) ----
  {
    const t: any = new AutoTrader({}, join(home, 'floor.json'))
    // setConfig without these starts the trader's timers and the process never exits (the first hang of 2026-09-18).
    const quiet = { enabled: false, autoPoll: false, bookLogging: false }
    assert.equal(t.leadLagCfg().leadLagMinDislocationCents, 4, 'default stays 4c')
    t.setConfig({ ...quiet, leadLagMinDislocationCents: 6 }); assert.equal(t.leadLagCfg().leadLagMinDislocationCents, 6)
    t.setConfig({ ...quiet, leadLagMinDislocationCents: 99 }); assert.equal(t.leadLagCfg().leadLagMinDislocationCents, 20, 'clamped high')
    t.setConfig({ ...quiet, leadLagMinDislocationCents: 0 }); assert.equal(t.leadLagCfg().leadLagMinDislocationCents, 2, 'clamped low: never 1c noise')
  }

  // ---- consensus fetch budget spends venue calls, not cache hits (2026-09-18) ----
  // The feed lists signals in a stable order. Counting cache hits against the 10-per-scan
  // budget froze the window on the first ten rows; rows 11+ were refused every scan.
  // This file is CJS-required by the runner, so the async part runs as an IIFE with an exit
  // guard: an unfinished or failed block sets a non-zero exit code.
  let budgetDone = false
  process.on('exit', () => { if (!budgetDone && !process.exitCode) { console.error('consensus budget test did not finish'); process.exitCode = 1 } })
  // Its own directory: the file-level finally removes `home` before this continuation runs.
  const bdir = mkdtempSync(join(tmpdir(), 'oracle-budget-'))
  void (async () => {
    const { ConsensusFeed } = require('../../src/main/strategies/consensus')
    const nowMs = Date.now()
    let fetches = 0, books = 0
    const adapter = {
      // Market 15 has already settled: a fresh signal on a finished match must be refused before its book is read.
      getMarket: async (id: string) => { fetches++; return { id, venue: 'kalshi', question: id, status: id === 'KXB15-Y' ? 'finalized' : 'open', outcomeType: 'BINARY', closeTime: nowMs + 48 * 3600_000, probability: 0.6 } },
      getOrderBook: async (id: string) => { books++; return { venue: 'kalshi', marketId: id, bids: [{ price: 0.58, size: 10 }], asks: [{ price: 0.62, size: 10 }] } }
    }
    const t: any = new AutoTrader({ getAdapter: () => adapter, getExecutionMode: () => 'paper' } as any, join(bdir, 'budget.json'))
    const feedPath = join(bdir, 'signals.jsonl')
    const rows = Array.from({ length: 16 }, (_, i) => JSON.stringify({ ts: new Date(nowMs).toISOString(), conditionId: `0x${i}`, title: 't', outcome: 'Yes', n_wallets: 4, poly_price: 0.6, kalshi: { market: `KXB${i}-Y`, side: 'YES', yes_ask: 0.62 } }))
    writeFileSync(feedPath, rows.join('\n') + '\n')
    t.consensusFeed = new ConsensusFeed(feedPath)
    const scan = () => ({ candles1m: {}, candles1h: {}, trades: new Map(), books: new Map(), headlinesByMarket: new Map(), live: new Map(), marketsById: new Map() })
    const logs: string[] = []
    const realLog = console.log
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
    let first: any[], second: any[], fetchesAfterFirst = -1
    try {
      first = await t.consensusSignals(scan())
      fetchesAfterFirst = fetches
      second = await t.consensusSignals(scan())
    } finally { console.log = realLog }
    const refusedOf = (line: string) => JSON.parse(/refused (\{.*?\})/.exec(line)?.[1] ?? '{}')
    const lines = logs.filter((l) => l.startsWith('[consensus]'))
    assert.equal(first.length, 10, 'scan 1 evaluates ten signals')
    assert.equal(refusedOf(lines[0])['fetch-budget'], 6, 'scan 1 refuses the six past the budget')
    assert.equal(fetchesAfterFirst, 10, 'scan 1 spends the whole budget on venue calls')
    assert.equal(second.length, 15, 'scan 2 evaluates every signal: cached markets are free')
    assert.equal(refusedOf(lines[1])['fetch-budget'], undefined, 'scan 2 refuses nothing for budget')
    assert.equal(fetches, 16, 'scan 2 fetches only the six it had not seen')
    assert.equal(refusedOf(lines[1])['market-closed'], 1, 'a finalized market is refused as closed')
    assert.equal(books, 25, 'no book is read for the closed market (10 + 15, never 26)')
    budgetDone = true
  })().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => rmSync(bdir, { recursive: true, force: true }))

  // ---- audit 2026-09-19: B-03 exit ordering, B-05 orphan-order ownership, B-06 dutch baskets at the reconcile ----
  let auditDone = false
  process.on('exit', () => { if (!auditDone && !process.exitCode) { console.error('audit B-03/B-05/B-06 tests did not finish'); process.exitCode = 1 } })
  const adir = mkdtempSync(join(tmpdir(), 'oracle-audit-'))
  void (async () => {
    // B-03: every persist during a full exit must see the trade already removed.
    {
      const seenAtPersist: number[] = []
      const engine: any = {
        getExecutionMode: () => 'paper',
        getAdapter: () => ({ getOrderBook: async () => ({ bids: [{ price: 0.7, size: 5 }], asks: [{ price: 0.72, size: 5 }] }) }),
        sellPosition: async () => ({ orderId: 'x1', venue: 'kalshi', marketId: 'KXA', outcome: 'YES', shares: 1, amount: 0.7, avgPrice: 0.7, fee: 0.01, timestamp: Date.now() })
      }
      const t: any = new AutoTrader(engine, join(adir, 'exit-order.json'))
      const trade = { id: 't1', marketId: 'KXA', question: 'q', outcome: 'YES', shares: 1, amount: 0.65, entryPrice: 0.65, strategy: 'fade', createdAt: Date.now(), feeRate: 0.07 }
      t.state.openTrades = [trade]
      t.persist = () => { seenAtPersist.push(t.state.openTrades.length) }
      const ok = await t.closeTrade(trade, 'take-profit', 7.7, 0.7, { scanned: 0, approved: 0, executed: 0, errors: [] })
      assert.equal(ok, true)
      assert.ok(seenAtPersist.length >= 1, 'the exit persisted')
      assert.ok(seenAtPersist.every((n) => n === 0), `every persist during the exit saw the trade removed (${seenAtPersist.join(',')})`)
      assert.equal(t.state.perf.trades, 1)
    }
    // B-05: an untracked resting order the journal recognises is cancelled; a hand-placed one is left alone.
    {
      const cancelled: string[] = []
      const adapter: any = {
        getOpenOrders: async () => [
          { orderId: 'X', clientOrderId: '3f0c2b9e-ours', marketId: 'M', outcome: 'NO', yesPrice: 0.05, remainingCount: 1, expirationTs: 0 },
          { orderId: 'Y', clientOrderId: 'manual', marketId: 'N', outcome: 'NO', yesPrice: 0.05, remainingCount: 1, expirationTs: 0 }
        ],
        getPositions: async () => [],
        cancelOrder: async (id: string) => { cancelled.push(id) }
      }
      const engine: any = { getExecutionMode: () => 'live', getAdapter: () => adapter, ownsOrder: (_v: string, _id: string, cid?: string) => cid === '3f0c2b9e-ours' }
      const t: any = new AutoTrader(engine, join(adir, 'orphans.json'))
      t.quoter.ownsOrder = () => false
      t.alert = () => {}
      await t.orphanSweep()
      assert.deepEqual(cancelled, ['X'], 'the journaled UUID order is cancelled; the unknown one is not')
    }
    // B-06: a dutch basket keyed by its event ticker is held while any leg is held.
    {
      let positions: any[] = [{ venue: 'kalshi', marketId: 'EV-1-A', outcome: 'NO', shares: 1, avgPrice: 0.35 }]
      const adapter: any = { getPositions: async () => positions, getMarket: async () => { throw new Error('no such market') } }
      const t: any = new AutoTrader({ getExecutionMode: () => 'live', getAdapter: () => adapter } as any, join(adir, 'dutch.json'))
      t.persist = () => {}
      t.state.openTrades = [{ id: 'd1', marketId: 'EV-1', question: 'q', outcome: 'NO', shares: 2, amount: 0.7, entryPrice: 0.35, strategy: 'dutch', createdAt: Date.now() - 11 * 60_000,
        legs: [{ marketId: 'EV-1-A', outcome: 'NO', shares: 1, amount: 0.35, entryPrice: 0.35 }, { marketId: 'EV-1-B', outcome: 'NO', shares: 1, amount: 0.35, entryPrice: 0.35 }] }]
      for (let i = 0; i < 3; i++) await t.reconcileLedgerWithVenue()
      assert.equal(t.state.openTrades.length, 1, 'a basket with a held leg survives three reconciles')
      positions = []
      for (let i = 0; i < 3; i++) await t.reconcileLedgerWithVenue()
      assert.equal(t.state.openTrades.length, 0, 'a basket with no held leg is still dropped after three misses')
    }
    // B-09: a venue position the journal explains (an acknowledged buy of ours) is adopted under its strategy.
    {
      const adapter: any = {
        getOpenOrders: async () => [],
        getPositions: async () => [{ venue: 'kalshi', marketId: 'KXR', outcome: 'NO', shares: 1.08, avgPrice: 0.93 }, { venue: 'kalshi', marketId: 'KXMANUAL', outcome: 'YES', shares: 2, avgPrice: 0.5 }],
        getMarket: async (id: string) => ({ id, venue: 'kalshi', question: 'q ' + id, status: 'open', closeTime: Date.now() + 3600_000, feeRate: 0.07 })
      }
      const engine: any = {
        getExecutionMode: () => 'live', getAdapter: () => adapter, ownsOrder: () => false,
        recoveredOrder: (_v: string, marketId: string) => marketId === 'KXR' ? { venue: 'kalshi', marketId, outcome: 'NO', side: 'buy', ref: 'auto:fade:sig1', clientOrderId: 'c1', orderId: 'o1', state: 'acknowledged', requestedAt: Date.now() - 300_000, acknowledgedAt: Date.now() - 240_000 } : undefined
      }
      const t: any = new AutoTrader(engine, join(adir, 'adopt.json'))
      t.quoter.ownsOrder = () => false
      t.persist = () => {}
      const alerts: string[] = []
      t.alert = (title: string) => { alerts.push(title) }
      await t.orphanSweep()
      const adopted = t.state.openTrades.find((x: any) => x.marketId === 'KXR')
      assert.ok(adopted, 'the journaled buy is adopted into the ledger')
      assert.equal(adopted.strategy, 'fade'); assert.equal(adopted.shares, 1.08); assert.equal(adopted.entryPrice, 0.93); assert.equal(adopted.outcome, 'NO'); assert.equal(adopted.feeRate, 0.07)
      assert.ok(!t.state.openTrades.some((x: any) => x.marketId === 'KXMANUAL'), 'a position the journal cannot explain is not adopted')
      assert.ok(alerts.some((a) => /adopted/.test(a)) && alerts.some((a) => /untracked/.test(a)), 'one adoption alert, one untracked alert')
    }
    auditDone = true
  })().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => rmSync(adir, { recursive: true, force: true }))

  // ---- v27 (2026-09-18): the fee-model fix ---------------------------------
  // netCentsOf() used to divide an already per-contract fee by the contract
  // count a second time. netSum/netSq/byEvent/byDay are running SUMS, so the
  // contaminated total cannot be filtered out later - v27 must clear it once,
  // while keeping every field the fee term never touched. Re-seed the file at
  // v26 with a populated calib block and re-open it.
  const seeded = JSON.parse(readFileSync(file, 'utf8'))
  seeded.configVersion = 26
  seeded.state.calib = {
    byStrategy: {
      fade: {
        n: 40,
        brierSum: 3.2,
        buckets: [{ n: 40, wins: 22, probSum: 12.5 }],
        netN: 40,
        netSum: 120,
        netSq: 900,
        byEvent: { E1: { n: 10, sum: 30 } },
        byDay: { '2026-09-01': { n: 10, sum: 30 } }
      },
      clean: { n: 5, brierSum: 1.1, buckets: [] } // never graded a settlement: but nothing accumulated
    },
    vetoWatch: [],
    vetoes: { graded: 0, wouldHaveWon: 0, estPnlCents: 0 }
  }
  writeFileSync(file, JSON.stringify(seeded))

  const third = new AutoTrader({}, file)
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.configVersion, 27)
  const s = after.state.calib.byStrategy.fade
  assert.equal(s.netN, undefined)
  assert.equal(s.netSum, undefined)
  assert.equal(s.netSq, undefined)
  assert.equal(s.byEvent, undefined)
  assert.equal(s.byDay, undefined)
  // every field the fee term never touched survives
  assert.equal(s.n, 40)
  assert.equal(s.brierSum, 3.2)
  assert.equal(s.buckets.length, 1)
  assert.equal(s.buckets[0].wins, 22)
  assert.equal(after.state.calib.byStrategy.clean.n, 5)
  // the operator's live setting survives the reset
  assert.equal(third.getConfig().maxOpenPositions, 7)
  console.log('config migration: version persisted, operator limit survives restart, v27 clears net-cents evidence only')
} finally {
  ;(Module as any)._load = loader
  globalThis.fetch = network
  rmSync(home, { recursive: true, force: true })
}
