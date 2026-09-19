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
