/**
 * Adversarial mock tests for the 2026-09-06 session code: quoter disarm path,
 * cancel retention, fill reconciler, promotion ladder. No network, no Electron.
 * Run: npx tsx scripts/tests/adversarial.test.ts
 */
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThinQuoter, type QuoterConfig } from '../../src/main/strategies/quoter'
import { FillReconciler } from '../../src/main/store/fillReconciler'
import { HistoryStore } from '../../src/main/store/history'
import { GENERIC_STRATEGIES, Ladder } from '../../src/main/ladder/ladder'
import { paidBudgetRemaining, readPaidBudget, writePaidBudget } from '../../src/main/intelligence/engine'
import type { VenueAdapter } from '../../src/shared/venue'
import type { OpenOrder, VenueFill } from '../../src/shared/types'

let pass = 0
let fail = 0
function eq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else {
    fail++
    console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
  }
}
const dir = mkdtempSync(join(tmpdir(), 'oracle-adv-'))
const quiet = (): void => undefined

const baseCfg: QuoterConfig = {
  quoterEnabled: false,
  quoterCategory: 'Climate and Weather',
  quoterSeriesRegex: '^KX(HIGH|LOW)',
  quoterMinSpreadCents: 3,
  quoterMaxSpreadCents: 20,
  quoterMaxTouchDepth: 50,
  quoterMaxContracts: 1,
  quoterMaxMarkets: 4,
  quoterMaxExposure: 3,
  quoterMaxPositionExposure: 25,
  quoterMaxInventory: 1,
  quoterCancelMinutes: 60,
  quoterMinHoursToClose: 3,
  quoterMaxHoursToClose: 48,
  amountPerTrade: 1,
  quoterShadowEnabled: false
}

function mockAdapter(overrides: Partial<Record<string, unknown>>): VenueAdapter {
  const calls: Record<string, number> = {}
  const count = (k: string): void => {
    calls[k] = (calls[k] ?? 0) + 1
  }
  const a = {
    id: 'kalshi',
    name: 'Kalshi',
    currency: 'USD',
    capabilities: { liveTrading: true, realMoney: true, socialExposure: false },
    calls,
    init: async () => undefined,
    searchMarkets: async () => [],
    getMarket: async () => {
      throw new Error('not used')
    },
    getPrice: async () => ({ venue: 'kalshi', marketId: '', outcome: 'YES', price: 0.5, probability: 0.5, timestamp: 0 }),
    getAccount: async () => ({ venue: 'kalshi', userId: 'u', balance: 10, balanceByShard: { 0: 10 }, currency: 'USD', realMoney: true }),
    getPositions: async () => [],
    placeOrder: async () => {
      throw new Error('not used')
    },
    sellPosition: async () => {
      throw new Error('not used')
    },
    cancelOrder: async () => {
      count('cancelOrder')
    },
    getTopHolders: async () => [],
    getUserPortfolio: async () => {
      throw new Error('x')
    },
    getUserBets: async () => [],
    getLeaderboard: async () => [],
    getUserHoldings: async () => [],
    getOrderBooks: async () => [],
    getOpenOrders: async (): Promise<OpenOrder[]> => [],
    getFills: async (): Promise<VenueFill[]> => [],
    amendOrder: async () => ({ fillCount: 0, avgYes: 0 }),
    ...overrides
  }
  return a as unknown as VenueAdapter
}

function seedQuoter(name: string, quotes: unknown[]): { q: ThinQuoter; path: string } {
  const path = join(dir, `${name}.json`)
  require('node:fs').writeFileSync(path, JSON.stringify({ quotes, placed: 1, amended: 0, canceled: 0, filled: 0 }))
  return { q: new ThinQuoter(path, quiet), path }
}
const quote = (orderId: string, marketId: string, outcome: 'YES' | 'NO', yesPrice: number) => ({ orderId, marketId, outcome, yesPrice, count: 1, placedAt: Date.now() - 60_000, close: Date.now() + 6 * 3600_000, filledSoFar: 0 })

async function main(): Promise<void> {
  // ---- A. disarm path: a quote that filled and vanished from the resting list must be booked, and not cancelled ----
  {
    const { q, path } = seedQuoter('a', [quote('o1', 'KXLOWTMIA-26SEP07-B70.5', 'YES', 0.4), quote('o2', 'KXLOWTSFO-26SEP07-B58.5', 'NO', 0.6)])
    const adapter = mockAdapter({
      getOpenOrders: async () => [{ orderId: 'o2', marketId: 'KXLOWTSFO-26SEP07-B58.5', outcome: 'NO', yesPrice: 0.6, initialCount: 1, fillCount: 0, remainingCount: 1, status: 'resting' }],
      getFills: async () => [{ id: 'f1', orderId: 'o1', marketId: 'KXLOWTMIA-26SEP07-B70.5', outcome: 'YES', side: 'buy', shares: 1, price: 0.4, fee: 0, isTaker: false, timestamp: Date.now() }]
    })
    await q.tick(adapter, { ...baseCfg, quoterEnabled: false }, 'live', true, false)
    const st = JSON.parse(readFileSync(path, 'utf8'))
    eq('A: vanished filled order booked', st.filled, 1)
    eq('A: ledgerFills attributed from venue feed', st.ledgerFills, 1)
    eq('A: quotes cleared after disarm', st.quotes.length, 0)
    eq('A: only the still-resting order was cancelled', (adapter as unknown as { calls: Record<string, number> }).calls.cancelOrder ?? 0, 1)
    eq('A: fill log written', existsSync(join(dir, 'a-fills.jsonl')), true)
  }
  // ---- B. cancel failure keeps the quote tracked; venue "not found" counts as gone ----
  {
    const { q, path } = seedQuoter('b', [quote('o1', 'M1', 'YES', 0.4), quote('o2', 'M2', 'NO', 0.6)])
    const adapter = mockAdapter({
      getOpenOrders: async () => [
        { orderId: 'o1', marketId: 'M1', outcome: 'YES', yesPrice: 0.4, initialCount: 1, fillCount: 0, remainingCount: 1, status: 'resting' },
        { orderId: 'o2', marketId: 'M2', outcome: 'NO', yesPrice: 0.6, initialCount: 1, fillCount: 0, remainingCount: 1, status: 'resting' }
      ],
      cancelOrder: async (id: string) => {
        if (id === 'o1') throw new Error('DELETE /portfolio/events/orders/o1 -> 503: service_unavailable')
        throw new Error('DELETE /portfolio/events/orders/o2 -> 404: {"error":{"code":"not_found","message":"order not found"}}')
      }
    })
    await q.tick(adapter, { ...baseCfg, quoterEnabled: false }, 'live', true, false)
    const st = JSON.parse(readFileSync(path, 'utf8'))
    eq('B: failed cancel stays tracked, not-found dropped', st.quotes.map((x: { orderId: string }) => x.orderId), ['o1'])
  }
  // ---- B2. fills feed unavailable on disarm: nothing dropped, nothing cancelled ----
  {
    const { q, path } = seedQuoter('b2', [quote('o1', 'M1', 'YES', 0.4)])
    const adapter = mockAdapter({
      getOpenOrders: async () => [],
      getFills: async () => {
        throw new Error('GET /portfolio/fills -> 503')
      }
    })
    await q.tick(adapter, { ...baseCfg, quoterEnabled: false }, 'live', true, false)
    const st = JSON.parse(readFileSync(path, 'utf8'))
    eq('B2: held when fills feed is down', st.quotes.length, 1)
    eq('B2: no cancel while holding', (adapter as unknown as { calls: Record<string, number> }).calls.cancelOrder ?? 0, 0)
  }
  // ---- B3. paused: hold everything ----
  {
    const { q, path } = seedQuoter('b3', [quote('o1', 'M1', 'YES', 0.4)])
    const adapter = mockAdapter({ getOpenOrders: async () => [] })
    await q.tick(adapter, { ...baseCfg, quoterEnabled: false }, 'live', true, false, true)
    const st = JSON.parse(readFileSync(path, 'utf8'))
    eq('B3: paused holds quotes', st.quotes.length, 1)
    eq('B3: paused makes no venue calls', (adapter as unknown as { calls: Record<string, number> }).calls.cancelOrder ?? 0, 0)
  }
  // ---- C. fill reconciler: dedupe, placement skip, completeness, ref exclusion from stats ----
  {
    const hist = new HistoryStore(join(dir, 'history.json'))
    hist.record({ id: 'ot-taker', venue: 'kalshi', marketId: 'M', side: 'buy', outcome: 'YES', amount: 0.5, shares: 1, price: 0.5, timestamp: 1 })
    hist.record({ id: 'sell-1', venue: 'kalshi', marketId: 'M', side: 'sell', outcome: 'YES', amount: 0.6, shares: 1, price: 0.6, realizedPnl: 0.1, timestamp: 2 })
    const fills: VenueFill[] = [
      { id: 'f-taker', orderId: 'ot-taker', marketId: 'M', outcome: 'YES', side: 'buy', shares: 1, price: 0.5, fee: 0.01, isTaker: true, timestamp: 1 },
      { id: 'f-maker', orderId: 'ot-maker', marketId: 'M2', outcome: 'NO', side: 'buy', shares: 2, price: 0.3, fee: 0, isTaker: false, timestamp: 3 }
    ]
    let calls = 0
    const engine = {
      getExecutionMode: () => 'live',
      getAdapter: () => ({
        getFills: async (limit: number) => {
          calls++
          return limit >= 5000 ? fills : fills.slice(0, 1)
        }
      })
    }
    const rec = new FillReconciler(engine as never, hist, join(dir, 'recon.json'), 'kalshi', quiet)
    await rec.run()
    const rows1 = hist.list(100, 'kalshi')
    eq('C: maker and taker executions each published once', rows1.filter((t) => t.ref === 'venue-fill').map((t) => t.id), ['fill:f-maker', 'fill:f-taker'])
    await rec.run()
    eq('C: second run adds nothing', hist.list(100, 'kalshi').filter((t) => t.ref === 'venue-fill').length, 2)
    const s = rec.status()
    eq('C: counters', { ingested: s.ingested, skipped: s.skippedPlacement, runs: s.runs, completeness: s.completeness }, { ingested: 2, skipped: 0, runs: 2, completeness: 'ok' })
    eq('C: fills fetched with backfill then incremental', calls, 2)
    const stats = hist.stats('kalshi')
    eq('C: stats exclude venue-fill from denominators', { total: stats.totalTrades, completed: stats.completedTrades, pnl: stats.realizedPnl }, { total: 3, completed: 1, pnl: 0.1 })
    // paper mode: reconciler must not run
    const paperEngine = { getExecutionMode: () => 'paper', getAdapter: () => ({ getFills: async () => fills }) }
    const rec2 = new FillReconciler(paperEngine as never, hist, join(dir, 'recon2.json'), 'kalshi', quiet)
    await rec2.run()
    eq('C: paper mode no-op', rec2.status().runs, 0)
  }
  // ---- D. ladder (prove-first): preconditions, blocked idempotence, manual re-sync, demotion cooldown ----
  {
    let cfg: Record<string, unknown> = { ladderEnabled: true, liveArmed: true, ladderMode: 'prove-first', quoterEnabled: false, convergenceLiveEnabled: false, settleLiveEnabled: false, alertWebhookUrl: '' }
    const setCalls: Record<string, unknown>[] = []
    const autoTrader = {
      getConfig: () => ({ ...cfg }),
      setConfig: (p: Record<string, unknown>) => {
        setCalls.push(p)
        cfg = { ...cfg, ...p }
      },
      detachOpenTrades: () => 0, quoterFilledMarkets: () => new Set<string>(), otherArmMarkets: () => new Set<string>(),
      getStatus: () => ({ killSwitchTripped: false, exchangePaused: false, perfByStrategy: {}, calib: { byStrategy: {} } })
    }
    let shard0 = 0.05
    const engine = {
      getExecutionMode: () => 'live',
      getAdapter: () => ({ getAccount: async () => ({ balance: 50, balanceByShard: { 0: shard0, 2: 25 } }) }),
      getLivePnl: async () => ({ details: [] })
    }
    const minis = new Map<string, unknown>()
    minis.set('polymarket-us', { getConfig: () => ({ microMakerEnabled: true }), setConfig: () => undefined, getStatus: () => ({}) })
    const ladder = new Ladder(engine as never, autoTrader as never, minis as never, dir, dir, quiet)
    const passingQuoterGate = { allowed: { n: 40, events: 45, mean: 2, lo: 0.3, hi: 3.7 }, blocked: null }
    ;(ladder as unknown as { runGate: (s: string) => Promise<unknown> }).runGate = async (s: string) => (s.startsWith('quoter') ? passingQuoterGate : { pass: false, events: 10, graded: 5, lbBonferroni: -2 })
    await ladder.run()
    const st1 = ladder.status().strategies.find((s) => s.id === 'quoter')!
    eq('D: quoter gate passes but shard 0 unfunded → blocked', st1.stage, 'blocked')
    eq('D: no config change while blocked', setCalls.length, 0)
    await ladder.run()
    const st2 = ladder.status().strategies.find((s) => s.id === 'quoter')!
    eq('D: blocked again does not add a transition', st2.history.length, 1)
    shard0 = 20
    await ladder.run()
    const st3 = ladder.status().strategies.find((s) => s.id === 'quoter')!
    eq('D: funded shard → tiny-live', st3.stage, 'tiny-live')
    eq('D: promotion enabled the quoter at micro size', setCalls[setCalls.length - 1], { quoterEnabled: true, quoterMaxContracts: 1, quoterMaxMarkets: 4, quoterMaxExposure: 4 })
    // operator disables it by hand → ladder follows
    cfg.quoterEnabled = false
    await ladder.run()
    const st4 = ladder.status().strategies.find((s) => s.id === 'quoter')!
    eq('D: manual disable re-syncs to shadow', st4.stage, 'shadow')
    // second promotion within 24h of the first is held
    const conv = ladder.status().strategies.find((s) => s.id === 'convergence')!
    eq('D: convergence still shadow (gate FAIL)', conv.stage, 'shadow')
    ;(ladder as unknown as { runGate: (s: string) => Promise<unknown> }).runGate = async (s: string) => (s.startsWith('quoter') ? { allowed: null, blocked: null } : { pass: true, events: 210, graded: 600, lbBonferroni: 1.4 })
    await ladder.run()
    const conv2 = ladder.status().strategies.find((s) => s.id === 'convergence')!
    eq('D: convergence promotion held by 24h stagger', conv2.stage, 'shadow')
    eq('D: held verdict recorded', (conv2.lastVerdict ?? '').includes('promotion held'), true)
    // disarmed operator: promotions impossible, demotions still run
    cfg.liveArmed = false
    ;(ladder as unknown as { state: { lastPromotionAt?: number } }).state.lastPromotionAt = 0
    await ladder.run()
    eq('D: not armed → no promotion', ladder.status().strategies.find((s) => s.id === 'convergence')!.stage, 'shadow')
  }
  // ---- E. trade-small mode: micro tests without the gate, shard-0 top-up, demotion cap, operator hold, micro-maker re-entry ----
  {
    const dir2 = mkdtempSync(join(tmpdir(), 'oracle-adv-e-'))
    let cfg: Record<string, unknown> = { ladderEnabled: true, liveArmed: true, ladderMode: 'trade-small', ladderMaxDemotionsBeforeGate: 2, ladderAutoAllocateUsd: 10, quoterEnabled: false, convergenceLiveEnabled: false, settleLiveEnabled: false, alertWebhookUrl: '' }
    const autoTrader = {
      getConfig: () => ({ ...cfg }),
      setConfig: (p: Record<string, unknown>) => {
        cfg = { ...cfg, ...p }
      },
      detachOpenTrades: () => 0, quoterFilledMarkets: () => new Set<string>(), otherArmMarkets: () => new Set<string>(),
      getStatus: () => ({ killSwitchTripped: false, exchangePaused: false, perfByStrategy: {}, calib: { byStrategy: {} } })
    }
    const shards: Record<number, number> = { 0: 0.05, 2: 25, 3: 40 }
    const transfers: [number, number, number][] = []
    const engine = {
      getExecutionMode: () => 'live',
      getAdapter: () => ({
        getAccount: async () => ({ balance: Object.values(shards).reduce((a, b) => a + b, 0), balanceByShard: { ...shards } }),
        transferBetweenShards: async (from: number, to: number, dollars: number) => {
          transfers.push([from, to, dollars])
          shards[from] -= dollars
          shards[to] = (shards[to] ?? 0) + dollars
          return 'tx1'
        }
      }),
      getLivePnl: async () => ({ details: [] })
    }
    let mm = true
    const minis = new Map<string, unknown>()
    minis.set('polymarket-us', {
      getConfig: () => ({ microMakerEnabled: mm }),
      setConfig: (p: { microMakerEnabled?: boolean }) => {
        mm = p.microMakerEnabled ?? mm
      },
      getStatus: () => ({})
    })
    const ladder = new Ladder(engine as never, autoTrader as never, minis as never, dir2, dir2, quiet)
    let gateCalls = 0
    ;(ladder as unknown as { runGate: (s: string) => Promise<unknown> }).runGate = async () => {
      gateCalls++
      return null
    }
    const L = ladder as unknown as { state: { lastPromotionAt?: number; strategies: Record<string, { cooldownUntil?: number; demotions?: number; operatorHold?: boolean }> } }
    const stage = (id: string): string => ladder.status().strategies.find((s) => s.id === id)!.stage
    const verdict = (id: string): string => ladder.status().strategies.find((s) => s.id === id)!.lastVerdict ?? ''
    await ladder.run()
    eq('E: convergence goes tiny-live without its gate', stage('convergence'), 'tiny-live')
    eq('E: convergence live config at micro size', { live: cfg.convergenceLiveEnabled, max: cfg.convergenceMaxDailyTrades }, { live: true, max: 6 })
    eq('E: quoter held by the 24h stagger', stage('quoter'), 'shadow')
    eq('E: held verdict names the hold', verdict('quoter').includes('promotion held'), true)
    eq('E: no gate scripts run when entry fires', gateCalls, 0)
    eq('E: no collateral moved while held', transfers.length, 0)
    L.state.lastPromotionAt = 0
    await ladder.run()
    eq('E: quoter funded and promoted', stage('quoter'), 'tiny-live')
    eq('E: top-up from shard 3, bounded by the cap, source keeps $1', transfers, [[3, 0, 9.95]])
    eq('E: quoter live at one contract', { on: cfg.quoterEnabled, n: cfg.quoterMaxContracts }, { on: true, n: 1 })
    eq('E: settlement held by stagger', stage('settlement'), 'paper')
    // convergence hits the -$5 stop: demoted, cool-down, demotion counted
    writeFileSync(join(dir2, 'crypto-convergence.json'), JSON.stringify({ trades: [{ ts: new Date().toISOString(), status: 'settled', realizedPnlCents: -510 }] }))
    await ladder.run()
    eq('E: convergence demoted on the stop', { stage: stage('convergence'), on: cfg.convergenceLiveEnabled, n: L.state.strategies.convergence.demotions }, { stage: 'shadow', on: false, n: 1 })
    eq('E: the stop keeps the baseline it replaced in the history row (backlog 81a)', ladder.status().strategies.find((s) => s.id === 'convergence')!.history.slice(-1)[0].baseline !== undefined, true)
    L.state.lastPromotionAt = 0
    await ladder.run()
    eq('E: cool-down blocks the second test', stage('convergence'), 'shadow')
    eq('E: cool-down verdict', verdict('convergence').startsWith('cool-down'), true)
    eq('E: settlement promoted once shard 0 is funded, no second transfer', { stage: stage('settlement'), on: cfg.settleLiveEnabled, transfers: transfers.length }, { stage: 'tiny-live', on: true, transfers: 1 })
    L.state.strategies.convergence.cooldownUntil = 0
    L.state.lastPromotionAt = 0
    await ladder.run()
    eq('E: second test after the cool-down', { stage: stage('convergence'), test: verdict('convergence').includes('micro test 2 ') }, { stage: 'tiny-live', test: true })
    writeFileSync(join(dir2, 'crypto-convergence.json'), JSON.stringify({ trades: [{ ts: new Date().toISOString(), status: 'settled', realizedPnlCents: -500 }] }))
    await ladder.run()
    eq('E: second demotion', { stage: stage('convergence'), n: L.state.strategies.convergence.demotions }, { stage: 'shadow', n: 2 })
    eq('E: second stop starts the 14-day cool-down', (L.state.strategies.convergence.cooldownUntil ?? 0) - Date.now() > 13 * 24 * 3600_000, true)
    L.state.lastPromotionAt = 0
    const before = gateCalls
    await ladder.run()
    eq('E: after the second stop it holds, gate still consulted, and says why', { stage: stage('convergence'), gated: gateCalls > before, why: verdict('convergence').includes('stopped 2 times') }, { stage: 'shadow', gated: true, why: true })
    L.state.strategies.convergence.cooldownUntil = 0
    L.state.lastPromotionAt = 0
    await ladder.run()
    eq('E: after two stops the clock no longer re-arms it - only its gate or the operator (backlog 220)', { stage: stage('convergence'), why: verdict('convergence').includes('stopped 2 times') }, { stage: 'shadow', why: true })
    cfg.convergenceLiveEnabled = false
    await ladder.run()
    // operator switches the quoter off by hand: trade-small must not switch it back on
    cfg.quoterEnabled = false
    L.state.lastPromotionAt = 0
    await ladder.run()
    eq('E: manual off re-syncs to shadow and holds', { stage: stage('quoter'), on: cfg.quoterEnabled, why: verdict('quoter').includes('operator hold') }, { stage: 'shadow', on: false, why: true })
    L.state.lastPromotionAt = 0
    await ladder.run()
    eq('E: operator hold persists', { stage: stage('quoter'), on: cfg.quoterEnabled }, { stage: 'shadow', on: false })
    cfg.quoterEnabled = true
    await ladder.run()
    eq('E: manual on re-syncs to tiny-live', stage('quoter'), 'tiny-live')
    // micro-maker: evidence demotion, then trade-small re-entry after the cool-down
    writeFileSync(join(dir2, 'mini-auto-polymarket-us.json-research.jsonl'), JSON.stringify({ type: 'closed', mode: 'live', strategy: 'micro-maker', ts: new Date().toISOString(), pnl: -6 }))
    await ladder.run()
    eq('E: micro-maker demoted on the stop', { stage: stage('polyus-micro-maker'), on: mm, n: L.state.strategies['polyus-micro-maker'].demotions }, { stage: 'disabled', on: false, n: 1 })
    L.state.strategies['polyus-micro-maker'].cooldownUntil = 0
    L.state.lastPromotionAt = 0
    await ladder.run()
    eq('E: micro-maker re-enters live after the cool-down', { stage: stage('polyus-micro-maker'), on: mm }, { stage: 'live', on: true })
    // top-up off: an unfunded shard blocks instead of moving money
    cfg.ladderAutoAllocateUsd = 0
    cfg.settleLiveEnabled = false
    shards[0] = 0.5
    L.state.lastPromotionAt = 0
    await ladder.run()
    eq('E: settlement manual off holds', stage('settlement'), 'paper')
    delete L.state.strategies.settlement.operatorHold
    L.state.lastPromotionAt = 0
    await ladder.run()
    eq('E: top-up off blocks the weather test without moving money', { stage: stage('settlement'), transfers: transfers.length, why: verdict('settlement').includes('top-up is off') }, { stage: 'blocked', transfers: 1, why: true })
  }
  // ---- F. live-stage rule at runtime: checkpoint scale-up, size reset on stop, settlement calib deltas ----
  {
    const dir3 = mkdtempSync(join(tmpdir(), 'oracle-adv-f-'))
    let cfg: Record<string, unknown> = { ladderEnabled: true, liveArmed: true, ladderMode: 'trade-small', ladderMaxDemotionsBeforeGate: 2, ladderAutoAllocateUsd: 0, quoterEnabled: false, convergenceLiveEnabled: false, settleLiveEnabled: false, alertWebhookUrl: '' }
    const status: Record<string, unknown> = { killSwitchTripped: false, exchangePaused: false, perfByStrategy: {}, calib: { byStrategy: {} } }
    const autoTrader = {
      getConfig: () => ({ ...cfg }),
      setConfig: (p: Record<string, unknown>) => {
        cfg = { ...cfg, ...p }
      },
      detachOpenTrades: () => 0, quoterFilledMarkets: () => new Set<string>(), otherArmMarkets: () => new Set<string>(),
      getStatus: () => status
    }
    let shard0 = 0.5
    const engine = { getExecutionMode: () => 'live', getAdapter: () => ({ getAccount: async () => ({ balance: 30, balanceByShard: { 0: shard0, 2: 25 } }) }), getLivePnl: async () => ({ details: [] }) }
    const minis = new Map<string, unknown>()
    minis.set('polymarket-us', { getConfig: () => ({ microMakerEnabled: true }), setConfig: () => undefined, getStatus: () => ({}) })
    const ladder = new Ladder(engine as never, autoTrader as never, minis as never, dir3, dir3, quiet)
    ;(ladder as unknown as { runGate: (s: string) => Promise<unknown> }).runGate = async () => null
    const L = ladder as unknown as { state: { lastPromotionAt?: number; strategies: Record<string, { notch?: number; lastCheckpoint?: number; operatorHold?: boolean }> } }
    const conv = () => ladder.status().strategies.find((s) => s.id === 'convergence')!
    const settle = () => ladder.status().strategies.find((s) => s.id === 'settlement')!
    await ladder.run()
    eq('F: convergence enters at size 1', { stage: conv().stage, notch: L.state.strategies.convergence.notch, size: cfg.convergenceMaxContractsPerTrade, daily: cfg.convergenceMaxDailyTrades }, { stage: 'tiny-live', notch: 1, size: 1, daily: 6 })
    // a new size table is applied once to an already-live strategy
    cfg.convergenceMaxDailyTrades = 3
    delete (L.state.strategies.convergence as { sizesVersion?: number }).sizesVersion
    await ladder.run()
    eq('F: size table re-applied once', { daily: cfg.convergenceMaxDailyTrades, v: (L.state.strategies.convergence as { sizesVersion?: number }).sizesVersion }, { daily: 6, v: 2 })
    // Five event clusters (2026-09-19: adding size needs >= 4 clusters and the 95% band); every cluster holds three +12 and one -20.
    const trades = (n: number, cents: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ ts: new Date().toISOString(), status: 'settled', realizedPnlCents: cents(i), eventTicker: `EV-${i % 5}` }))
    writeFileSync(join(dir3, 'crypto-convergence.json'), JSON.stringify({ trades: trades(19, () => 6) }))
    await ladder.run()
    eq('F: 19 trades: no checkpoint yet', { stage: conv().stage, cp: L.state.strategies.convergence.lastCheckpoint }, { stage: 'tiny-live', cp: 0 })
    writeFileSync(join(dir3, 'crypto-convergence.json'), JSON.stringify({ trades: trades(20, (i) => (i % 4 === 3 ? -20 : 12)) }))
    await ladder.run()
    eq('F: checkpoint win scales to x2', { stage: conv().stage, notch: L.state.strategies.convergence.notch, size: cfg.convergenceMaxContractsPerTrade, daily: cfg.convergenceMaxDailyTrades, cp: L.state.strategies.convergence.lastCheckpoint }, { stage: 'live', notch: 2, size: 2, daily: 12, cp: 0 })
    eq('F: scale-up recorded', conv().history[conv().history.length - 1].to, 'live')
    // trades before the scale-up no longer count; -$6 at x2 is inside the -$10 stop
    writeFileSync(join(dir3, 'crypto-convergence.json'), JSON.stringify({ trades: trades(2, () => -300) }))
    await ladder.run()
    eq('F: stop scales with size', { stage: conv().stage, notch: L.state.strategies.convergence.notch }, { stage: 'live', notch: 2 })
    writeFileSync(join(dir3, 'crypto-convergence.json'), JSON.stringify({ trades: trades(4, () => -300) }))
    await ladder.run()
    eq('F: -$12 at x2 stops and resets the size', { stage: conv().stage, notch: L.state.strategies.convergence.notch, size: cfg.convergenceMaxContractsPerTrade, daily: cfg.convergenceMaxDailyTrades, on: cfg.convergenceLiveEnabled }, { stage: 'shadow', notch: 1, size: 1, daily: 6, on: false })
    // settlement: promoted once shard 0 holds collateral; judged on calib deltas since promotion
    shard0 = 10
    L.state.strategies.quoter.operatorHold = true
    L.state.lastPromotionAt = 0
    await ladder.run()
    eq('F: settlement enters at multiplier 1', { stage: settle().stage, on: cfg.settleLiveEnabled, mult: (cfg.strategySizeMult as Record<string, number>)?.settlement }, { stage: 'tiny-live', on: true, mult: 1 })
    status.perfByStrategy = { settlement: { trades: 20, realizedPnl: 1.2 } }
    // netSq 1936 -> sd 8c on a mean of 6c: a real winning sample has losers in it. A uniform +6c x20
    // (netSq 720, sd 0) is now correctly refused as a one-sided sample - see the round-63 guard.
    status.calib = { byStrategy: { settlement: { netN: 20, netSum: 120, netSq: 1936, byDay: { d1: { n: 5, sum: 30 }, d2: { n: 5, sum: 30 }, d3: { n: 5, sum: 30 }, d4: { n: 5, sum: 30 } } } } }
    // shard 0 must carry the bigger size first: held (and retried) until it does
    shard0 = 6
    await ladder.run()
    eq('F: settlement scale-up held until shard 0 carries x2', { stage: settle().stage, held: settle().lastVerdict?.includes('scale-up held: shard 0 holds $6.00'), cp: L.state.strategies.settlement.lastCheckpoint }, { stage: 'tiny-live', held: true, cp: 0 })
    shard0 = 10
    await ladder.run()
    eq('F: settlement checkpoint win doubles its stake multiplier', { stage: settle().stage, mult: (cfg.strategySizeMult as Record<string, number>)?.settlement }, { stage: 'live', mult: 2 })
    status.perfByStrategy = { settlement: { trades: 26, realizedPnl: -9.5 } }
    status.calib = { byStrategy: { settlement: { netN: 26, netSum: -950, netSq: 720 + 6 * 178 * 178 } } }
    await ladder.run()
    eq('F: settlement -$10.70 since scale-up stops at x2', { stage: settle().stage, on: cfg.settleLiveEnabled, mult: (cfg.strategySizeMult as Record<string, number>)?.settlement }, { stage: 'paper', on: false, mult: 1 })
  }
  // ---- G. every signal strategy is under the ladder: Kalshi fade via calibration deltas, Polymarket US fade via the research log, lead-lag by contracts ----
  {
    const dir4 = mkdtempSync(join(tmpdir(), 'oracle-adv-g-'))
    let cfg: Record<string, unknown> = { ladderEnabled: true, liveArmed: true, ladderMode: 'trade-small', ladderMaxDemotionsBeforeGate: 2, ladderAutoAllocateUsd: 0, amountPerTrade: 5, quoterEnabled: false, convergenceLiveEnabled: false, settleLiveEnabled: false, fadeEnabled: false, momentumEnabled: false, bookEnabled: false, volumeSpikeEnabled: false, crossVenueEnabled: false, newsEnabled: false, dutchEnabled: true, dutchLiveEnabled: false, leadLagLiveEnabled: false, alertWebhookUrl: '' }
    const status: Record<string, unknown> = { killSwitchTripped: false, exchangePaused: false, perfByStrategy: {}, calib: { byStrategy: {} } }
    const autoTrader = {
      getConfig: () => ({ ...cfg }),
      setConfig: (p: Record<string, unknown>) => {
        cfg = { ...cfg, ...p }
      },
      detachOpenTrades: () => 0, quoterFilledMarkets: () => new Set<string>(), otherArmMarkets: () => new Set<string>(),
      getStatus: () => status
    }
    let mcfg: Record<string, unknown> = { microMakerEnabled: true, fadeEnabled: false, bookEnabled: false, amountPerTrade: 1 }
    const minis = new Map<string, unknown>()
    minis.set('polymarket-us', {
      getConfig: () => ({ ...mcfg }),
      setConfig: (p: Record<string, unknown>) => {
        mcfg = { ...mcfg, ...p }
      },
      getStatus: () => ({})
    })
    const details: { timestamp: number; marketId: string; realizedPnl: number; shares: number }[] = []
    const engine = { getExecutionMode: () => 'live', getAdapter: () => ({ getAccount: async () => ({ balance: 30, balanceByShard: { 0: 0.5, 2: 25 } }) }), getLivePnl: async () => ({ details }) }
    const ladder = new Ladder(engine as never, autoTrader as never, minis as never, dir4, dir4, quiet)
    ;(ladder as unknown as { runGate: (s: string) => Promise<unknown> }).runGate = async () => null
    const L = ladder as unknown as { state: { lastPromotionAt?: number; strategies: Record<string, { operatorHold?: boolean; notch?: number; demotions?: number; cooldownUntil?: number }> } }
    const st = (id: string) => ladder.status().strategies.find((s) => s.id === id)!
    await ladder.run()
    // The count is a drift alarm: a new arm must arrive with its GENERIC_STRATEGIES entry,
    // its config flag and this number, or it is not on the ladder at all.
    // 20 since 2026-09-14 (kalshi-consensus, build-queue item 13); 21 since 2026-09-22 (polyus-lag, section 160).
    eq('G: all twenty-one strategies are tracked', ladder.status().strategies.length, 21)
    eq('G: the Polymarket US lag arm is one of them', ladder.status().strategies.some((s) => s.id === 'polyus-lag'), true)
    eq('G: the consensus arm is one of them', ladder.status().strategies.some((s) => s.id === 'kalshi-consensus'), true)
    // park the four core strategies so the signal strategies get the promotions
    cfg.convergenceLiveEnabled = false
    for (const id of ['quoter', 'settlement']) L.state.strategies[id].operatorHold = true
    L.state.lastPromotionAt = 0
    await ladder.run()
    eq('G: first signal strategy enters at multiplier 1', { stage: st('kalshi-fade').stage, on: cfg.fadeEnabled, mult: (cfg.strategySizeMult as Record<string, number>)?.fade }, { stage: 'tiny-live', on: true, mult: 1 })
    eq('G: the rest wait for the stagger', { m: st('kalshi-momentum').stage, p: st('polyus-fade').stage, why: st('kalshi-momentum').lastVerdict?.includes('promotion held') }, { m: 'disabled', p: 'disabled', why: true })
    // fade: 20 graded trades, +6c each, +$1.20 -> checkpoint win -> stake x2; momentum enters on the same run
    status.perfByStrategy = { fade: { trades: 20, realizedPnl: 1.2 } }
    status.calib = { byStrategy: { fade: { netN: 20, netSum: 120, netSq: 1936, byDay: { d1: { n: 5, sum: 30 }, d2: { n: 5, sum: 30 }, d3: { n: 5, sum: 30 }, d4: { n: 5, sum: 30 } } } } }
    L.state.lastPromotionAt = 0
    await ladder.run()
    eq('G: fade checkpoint win doubles its stake', { stage: st('kalshi-fade').stage, mult: (cfg.strategySizeMult as Record<string, number>)?.fade }, { stage: 'live', mult: 2 })
    eq('G: momentum entered on the same run', { stage: st('kalshi-momentum').stage, on: cfg.momentumEnabled }, { stage: 'tiny-live', on: true })
    // fade at x2 with a $5 stake: stop is max($10, 3 x $10) = $30
    status.perfByStrategy = { fade: { trades: 26, realizedPnl: 1.2 - 31 } }
    status.calib = { byStrategy: { fade: { netN: 26, netSum: 120 - 3100, netSq: 720 + 6 * 517 * 517 } } }
    await ladder.run()
    eq('G: fade stops at three stakes and resets', { stage: st('kalshi-fade').stage, on: cfg.fadeEnabled, mult: (cfg.strategySizeMult as Record<string, number>)?.fade, n: L.state.strategies['kalshi-fade'].demotions, cd: ((L.state.strategies['kalshi-fade'].cooldownUntil ?? 0) - Date.now()) / 3600_000 > 71 }, { stage: 'disabled', on: false, mult: 1, n: 1, cd: true })
    // One promotion per run (the stagger), so every generic arm needs its own
    // run to reach the stage this block asserts on. Counting the arms keeps
    // the loop right when the build queue adds the next one.
    for (let i = 0; i < GENERIC_STRATEGIES.length; i++) {
      L.state.lastPromotionAt = 0
      await ladder.run()
    }
    eq('G: dutch live needs both flags', { on: cfg.dutchEnabled, live: cfg.dutchLiveEnabled, stage: st('kalshi-dutch').stage }, { on: true, live: true, stage: 'tiny-live' })
    // contractsPerNotch: 2 (round 76) - lead-lag sizes at 2 contracts per notch, so tiny-live (notch 1) is 2
// and its first scale-up is 4. It was pinned at the shared MAX_NOTCH ceiling while carrying the account.
eq('G: lead-lag live at one contract (notch 1 baseline sizing)', { live: cfg.leadLagLiveEnabled, n: cfg.leadLagMaxContractsPerOrder, stage: st('kalshi-leadlag').stage }, { live: true, n: 1, stage: 'tiny-live' })
    eq('G: Polymarket US fade and book on at multiplier 1', { fade: mcfg.fadeEnabled, book: mcfg.bookEnabled, mult: mcfg.strategySizeMult }, { fade: true, book: true, mult: { fade: 1, 'book-imbalance': 1, 'weather-fair': 1, lag: 1 } })
    eq('G: fade still in its cool-down', st('kalshi-fade').stage, 'disabled')
    // A registration's FAIL retires an arm (section 163): off now, never re-armed by the clock, not an operator hold.
    await ladder.retire('polyus-lag', 'the registration failed')
    eq('G: retire switches the arm off without an operator hold', { stage: st('polyus-lag').stage, on: mcfg.lagEnabled, hold: st('polyus-lag').operatorHold ?? false, retired: !!st('polyus-lag').retired }, { stage: 'disabled', on: false, hold: false, retired: true })
    ;(L.state.strategies['polyus-lag'] as { cooldownUntil?: number }).cooldownUntil = 0
    await ladder.run()
    eq('G: a retired arm is not re-armed when its cool-down ends', { stage: st('polyus-lag').stage, on: mcfg.lagEnabled }, { stage: 'disabled', on: false })
    mcfg = { ...mcfg, lagEnabled: true }
    await ladder.run()
    eq('G: the operator switching it on brings it back and clears the retirement', { stage: st('polyus-lag').stage, retired: !!st('polyus-lag').retired }, { stage: 'tiny-live', retired: false })
    // Polymarket US fade: 20 closes at +$0.10 in the research log -> x2
    // 16 x +$0.35 and 4 x -$0.50: +$3.60 net, $0.18 mean, two-sided, and wide enough for the 95% band (2026-09-19).
    ;(L.state.strategies['polyus-fade'] as { since?: number }).since = Date.now() - 6 * 86_400_000
    writeFileSync(join(dir4, 'mini-auto-polymarket-us.json-research.jsonl'), Array.from({ length: 20 }, (_, i) => JSON.stringify({ type: 'closed', mode: 'live', strategy: 'fade', ts: new Date(Date.now() - (i % 4) * 86_400_000).toISOString(), marketId: `pm-${i}`, pnl: i % 5 === 4 ? -0.5 : 0.35 })).join(String.fromCharCode(10)))
    await ladder.run()
    eq('G: Polymarket US fade scales on its research log', { stage: st('polyus-fade').stage, mult: (mcfg.strategySizeMult as Record<string, number>)?.fade }, { stage: 'live', mult: 2 })
    // lead-lag: 20 swept markets settled at +$0.05 through the venue ledger -> 2 contracts
    const now = Date.now()
    ;(L.state.strategies['kalshi-leadlag'] as { since?: number }).since = now - 6 * 86_400_000
    // Rows the venue merely ACCEPTED (no fill count) are not evidence: before
    // 2026-09-08 every accepted IOC wrote executed:true and the arm scaled on
    // settlements it never held.
    writeFileSync(join(dir4, 'leadlag-dislocations.jsonl'), Array.from({ length: 20 }, (_, i) => JSON.stringify({ ts: new Date(now - (i % 4) * 86_400_000).toISOString(), kalshiTicker: `KXT-${i}`, executed: true })).join(String.fromCharCode(10)))
    // 16 x +$0.125 and 4 x -$0.25: +$1.00 net, $0.05 mean, sd $0.15 - a winning sample that has lost.
    for (let i = 0; i < 20; i++) details.push({ timestamp: now - (i % 4) * 86_400_000, marketId: `KXT-${i}`, realizedPnl: i % 5 === 4 ? -0.25 : 0.125, shares: 1 })
    await ladder.run()
    eq('G: lead-lag does not scale on zero-fill sweeps', { stage: st('kalshi-leadlag').stage, n: cfg.leadLagMaxContractsPerOrder }, { stage: 'tiny-live', n: 1 })
    writeFileSync(join(dir4, 'leadlag-dislocations.jsonl'), Array.from({ length: 20 }, (_, i) => JSON.stringify({ ts: new Date(now - (i % 4) * 86_400_000).toISOString(), kalshiTicker: `KXT-${i}`, executed: true, filledContracts: 1 })).join(String.fromCharCode(10)))
    await ladder.run()
    eq('G: lead-lag scales by contracts', { stage: st('kalshi-leadlag').stage, n: cfg.leadLagMaxContractsPerOrder }, { stage: 'live', n: 2 })
    // A config on defaults after its file was set aside is not the operator switching arms off (backlog 224).
    ;(autoTrader as unknown as { configDefaulted: () => boolean }).configDefaulted = () => true
    cfg.leadLagLiveEnabled = false
    await ladder.run()
    eq('G: a defaulted config does not create an operator hold', st('kalshi-leadlag').operatorHold ?? false, false)
    ;(autoTrader as unknown as { configDefaulted: () => boolean }).configDefaulted = () => false
    cfg.leadLagLiveEnabled = false
    await ladder.run()
    eq('G: ...while the same switch-off in a healthy config is an operator hold', st('kalshi-leadlag').operatorHold ?? false, true)
  }
  // ---- H. deposits are spread to the shards that trade ----
{
  const dirH = mkdtempSync(join(tmpdir(), 'oracle-adv-h-'))
  let cfgH: Record<string, unknown> = { ladderEnabled: true, liveArmed: true, ladderMode: 'trade-small', ladderMaxDemotionsBeforeGate: 2, ladderAutoAllocateUsd: 20, quoterEnabled: false }
  const shardsH: Record<number, number> = { 0: 62.43, 1: 0, 2: 20.17, 3: 1.01 }
  const movesH: [number, number, number][] = []
  const engineH = {
    getExecutionMode: () => 'live',
    getAdapter: () => ({
      getAccount: async () => ({ balance: Object.values(shardsH).reduce((a, b) => a + b, 0), balanceByShard: { ...shardsH } }),
      transferBetweenShards: async (from: number, to: number, dollars: number) => {
        movesH.push([from, to, dollars])
        shardsH[from] -= dollars
        shardsH[to] = (shardsH[to] ?? 0) + dollars
        return 'txh'
      }
    }),
    getLivePnl: async () => ({ details: [] })
  }
  const autoTraderH = {
    getConfig: () => ({ ...cfgH }),
    setConfig: (p: Record<string, unknown>) => {
      cfgH = { ...cfgH, ...p }
    },
    detachOpenTrades: () => 0, quoterFilledMarkets: () => new Set<string>(), otherArmMarkets: () => new Set<string>(),
    getStatus: () => ({ killSwitchTripped: false, exchangePaused: false, perfByStrategy: {}, calib: { byStrategy: {} } })
  }
  const minisH = new Map<string, unknown>()
  minisH.set('polymarket-us', { getConfig: () => ({ microMakerEnabled: false }), setConfig: () => undefined, getStatus: () => ({}) })
  const ladderH = new Ladder(engineH as never, autoTraderH as never, minisH as never, dirH, dirH, quiet)
  ;(ladderH as unknown as { runGate: (s: string) => Promise<unknown> }).runGate = async () => null
  await ladderH.run()
  eq('H: the sports shard is topped up to its working level from shard 0', movesH, [[0, 3, 13.99]])
  eq('H: the unused shard and the funded shard are left alone', { one: shardsH[1], two: shardsH[2] }, { one: 0, two: 20.17 })
  eq('H: shard 0 keeps the weather cap and the rest', shardsH[0] > 20, true)
  await ladderH.run()
  eq('H: a second run moves nothing', movesH.length, 1)

  // ---- I: the paid-critic budget survives a restart (2026-09-11) ----
  // The cap added on 2026-09-10 lived in a class field, so every app start reset it to zero and
  // "60 paid calls a day" was really "60 per process" — with ~18 boots a day, no cap at all.
  const dirI = mkdtempSync(join(tmpdir(), 'oracle-adv-i-'))
  const budgetI = join(dirI, 'intelligence', 'critic-budget.json')
  const todayI = '2026-09-11'
  eq('I: no file yet means the full budget', paidBudgetRemaining(readPaidBudget(budgetI, todayI), todayI, 60), 60)
  writePaidBudget(budgetI, { date: todayI, n: 57 })
  // A fresh read is exactly what a restarted process does.
  eq('I: a restart reads the day\'s count back off disk', readPaidBudget(budgetI, todayI).n, 57)
  eq('I: and the remaining budget reflects it', paidBudgetRemaining(readPaidBudget(budgetI, todayI), todayI, 60), 3)
  eq('I: the budget is spent, not negative, once the cap is passed',
    paidBudgetRemaining({ date: todayI, n: 75 }, todayI, 60), 0)
  // The roll to a new UTC day must still zero it, which is the behaviour the in-memory version got right.
  eq('I: yesterday\'s record does not count against today', readPaidBudget(budgetI, '2026-09-12').n, 0)
  eq('I: a stale file restores the full budget', paidBudgetRemaining(readPaidBudget(budgetI, '2026-09-12'), '2026-09-12', 60), 60)
  // Telemetry, not credentials: a corrupt file must fail open to zero spent, never crash the critic.
  writeFileSync(budgetI, '{not json')
  eq('I: a corrupt file resets rather than throwing', readPaidBudget(budgetI, todayI), { date: todayI, n: 0 })
  eq('I: a cap of zero blocks every paid call', paidBudgetRemaining({ date: todayI, n: 0 }, todayI, 0), 0)
}

console.log(`adversarial: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
