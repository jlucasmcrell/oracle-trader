from pathlib import Path

ROOT=Path(r'G:\PROJECTS\oracle-trader')

def load(rel, sig=False):
    p=ROOT/rel
    return p.read_text(encoding='utf-8-sig' if sig else 'utf-8')

def save(rel, s):
    (ROOT/rel).write_text(s, encoding='utf-8', newline='\n')

def rep(s, old, new, name):
    if old not in s:
        raise SystemExit(f'missing pattern {name}')
    return s.replace(old,new,1)

# shared IPC/types
rel='src/shared/ipc.ts'; s=load(rel)
s=rep(s, '  OrderResult,\n  Position,', '  OrderResult,\n  OpenOrder,\n  Position,', 'OpenOrder import')
s=rep(s, '  quoterMaxExposure?: number\n  quoterMaxInventory?: number', '  /** Max collateral committed to currently resting quoter orders. */\n  quoterMaxExposure?: number\n  /** Max acquisition-cost exposure in filled weather positions plus resting quotes. */\n  quoterMaxPositionExposure?: number\n  quoterMaxInventory?: number', 'quoter config field')
s=rep(s, '  portfolio: {\n    get(venue: VenueId): Promise<PortfolioSnapshot>\n    livePnl(venue: VenueId): Promise<LivePnl | null>\n  }', '  portfolio: {\n    get(venue: VenueId): Promise<PortfolioSnapshot>\n    livePnl(venue: VenueId): Promise<LivePnl | null>\n    /** Venue-authoritative resting orders; includes every strategy and manual/API order. */\n    openOrders(venue: VenueId): Promise<OpenOrder[]>\n  }', 'Api openOrders')
s=rep(s, "  portfolioLivePnl: 'portfolio:livePnl',", "  portfolioLivePnl: 'portfolio:livePnl',\n  portfolioOpenOrders: 'portfolio:openOrders',", 'IPC open orders')
# richer statuses
s=s.replace("  note: string\n}\n\nexport interface LeadLagDislocation", "  note: string\n  attempts: number\n  fills: number\n  noFills: number\n  openTrades: number\n  dailyFills: number\n}\n\nexport interface LeadLagDislocation",1)
s=s.replace("  exposure: number\n  inventory: number", "  /** Total filled-position plus resting-order acquisition-cost exposure. */\n  exposure: number\n  positionExposure: number\n  restingExposure: number\n  restingBudget: number\n  totalExposureCap: number\n  inventory: number",1)
s=s.replace("  lastError?: string | null\n}\n\nexport interface QuantStatus", "  lastError?: string | null\n  blockedReason?: string | null\n}\n\nexport interface QuantStatus",1)
s=s.replace("quoter?: { enabled: boolean; active: boolean; note: string; candidates: number; quoting: number; resting: number; exposure: number; inventory: number; placed: number; amended: number; canceled: number; filled: number; lastTick?: number; lastError?: string | null }", "quoter?: QuoterStatus")
save(rel,s)

# preload
rel='src/preload/index.ts'; s=load(rel)
s=rep(s, "    livePnl: (venue: VenueId) => ipcRenderer.invoke(IPC.portfolioLivePnl, venue)\n", "    livePnl: (venue: VenueId) => ipcRenderer.invoke(IPC.portfolioLivePnl, venue),\n    openOrders: (venue: VenueId) => ipcRenderer.invoke(IPC.portfolioOpenOrders, venue)\n", 'preload open orders')
save(rel,s)

# main IPC
rel='src/main/index.ts'; s=load(rel)
s=rep(s, "  ipcMain.handle(IPC.portfolioLivePnl, (_e, venue: VenueId) => engine.getLivePnl(venue))\n", "  ipcMain.handle(IPC.portfolioLivePnl, (_e, venue: VenueId) => engine.getLivePnl(venue))\n  ipcMain.handle(IPC.portfolioOpenOrders, async (_e, venue: VenueId) => {\n    if (engine.getExecutionMode() !== 'live') return []\n    const adapter = engine.getAdapter(venue)\n    if (!adapter?.getOpenOrders) return []\n    return adapter.getOpenOrders()\n  })\n", 'main open orders')
save(rel,s)

# App authoritative venue orders
rel='src/renderer/src/App.tsx'; s=load(rel)
s=rep(s, "import type { HistoryStats, LivePnl, OrderBook, Position, VenueId, VenueMarket } from '../../shared/types'", "import type { HistoryStats, LivePnl, OpenOrder, OrderBook, Position, VenueId, VenueMarket } from '../../shared/types'", 'App import')
s=rep(s, "  const [restingOrders, setRestingOrders] = useState<\n    { orderId: string; marketId: string; question?: string; outcome: string; yesPrice: number; expirationTs: number; strategy?: string }[]\n  >([])", "  const [restingOrders, setRestingOrders] = useState<OpenOrder[]>([])", 'App state')
old="""    // Resting orders are the venue's pre-fill state; without them the card
    // read 'No open positions' while three live orders sat at the exchange.
    try {
      const st = v === 'kalshi' ? await window.api.autoTrader.getStatus() : await window.api.autoMini.getStatus(v)
      setRestingOrders((st.pendingOrders ?? []) as typeof restingOrders)
    } catch {
      setRestingOrders([])
    }"""
new="""    // Venue-authoritative: independent strategy engines and manual/API orders
    // do not necessarily appear in the central AutoTrader ledger.
    try {
      setRestingOrders(await window.api.portfolio.openOrders(v))
    } catch {
      setRestingOrders([])
    }"""
s=rep(s,old,new,'App refresh orders')
s=s.replace("{o.expirationTs > 0 && <span className=\"pos-expiry\">", "{(o.expirationTs ?? 0) > 0 && <span className=\"pos-expiry\">")
s=s.replace("fmtClose(o.expirationTs * 1000)", "fmtClose((o.expirationTs ?? 0) * 1000)")
s=s.replace("title={o.question ?? o.marketId}", "title={o.marketId}")
s=s.replace("{(o.question ?? o.marketId).slice(0, 64)}", "{o.marketId.slice(0, 64)}")
s=s.replace("{o.strategy ?? 'maker'}  order", "venue order  {o.remainingCount} remaining  order")
save(rel,s)

# Quoter separated resting budget and total position cap
rel='src/main/strategies/quoter.ts'; s=load(rel)
s=rep(s, "  quoterMaxExposure: number\n  quoterMaxInventory: number", "  /** New/resting quote collateral budget. */\n  quoterMaxExposure: number\n  /** Filled weather positions + resting quotes may not exceed this acquisition-cost cap. */\n  quoterMaxPositionExposure: number\n  quoterMaxInventory: number", 'QuoterConfig cap')
s=rep(s, "  exposure: number\n  inventory: number", "  exposure: number\n  positionExposure: number\n  restingExposure: number\n  restingBudget: number\n  totalExposureCap: number\n  inventory: number", 'QuoterStatus fields')
s=rep(s, "  lastError?: string | null\n}", "  lastError?: string | null\n  blockedReason?: string | null\n}", 'QuoterStatus blocked')
s=rep(s, "  private note = 'idle'\n  private running = false", "  private note = 'idle'\n  private blockedReason: string | null = null\n  private positionExposure = 0\n  private restingBudget = 0\n  private totalExposureCap = 0\n  private running = false", 'Quoter runtime status')
old="""  status(cfg: QuoterConfig): QuoterStatus {
    const exposure = this.state.quotes.reduce((s, q) => s + q.count * (q.outcome === 'YES' ? q.yesPrice : 1 - q.yesPrice), 0)
    return {"""
new="""  status(cfg: QuoterConfig): QuoterStatus {
    const restingExposure = this.state.quotes.reduce((s, q) => s + q.count * (q.outcome === 'YES' ? q.yesPrice : 1 - q.yesPrice), 0)
    return {"""
s=rep(s,old,new,'status exposure calc')
s=rep(s, "      exposure: r2(exposure),\n      inventory: 0,", "      exposure: r2(this.positionExposure + restingExposure),\n      positionExposure: r2(this.positionExposure),\n      restingExposure: r2(restingExposure),\n      restingBudget: r2(this.restingBudget),\n      totalExposureCap: r2(this.totalExposureCap || cfg.quoterMaxPositionExposure),\n      inventory: 0,", 'status exposure values')
s=rep(s, "      lastError: this.state.lastError ?? null\n", "      lastError: this.state.lastError ?? null,\n      blockedReason: this.blockedReason\n", 'status blocked value')
# Capture position exposure and replace budget logic
s=rep(s, "      let freeBalance = 0", "      this.positionExposure = positionRisk\n      let freeBalance = 0", 'position exposure set')
old="""      let exposure = positionRisk + this.state.quotes.reduce((s, q) => s + q.count * (q.outcome === 'YES' ? q.yesPrice : 1 - q.yesPrice), 0)
      const exposureCap = Math.min(cfg.quoterMaxExposure, Math.max(0, freeBalance * 0.25))
      let quoting = 0"""
new="""      const restingExposureNow = this.state.quotes.reduce((s, q) => s + q.count * (q.outcome === 'YES' ? q.yesPrice : 1 - q.yesPrice), 0)
      let exposure = positionRisk + restingExposureNow
      // Do not let old filled positions permanently consume the separate
      // resting-order research budget. Both rails apply: a small incremental
      // quote budget and a hard total weather-position cap.
      const restingBudget = Math.min(cfg.quoterMaxExposure, Math.max(0, freeBalance * 0.25))
      const totalExposureCap = Math.max(cfg.quoterMaxExposure, cfg.quoterMaxPositionExposure)
      this.restingBudget = restingBudget
      this.totalExposureCap = totalExposureCap
      this.blockedReason = null
      let newRestingExposure = restingExposureNow
      let quoting = 0"""
s=rep(s,old,new,'budget separation')
s=rep(s, "          if (freeBalance < legCost + 0.25 || exposure + count * legCost > exposureCap) continue", "          if (freeBalance < legCost + 0.25) { this.blockedReason = 'available cash below order cost plus reserve'; continue }\n          if (newRestingExposure + count * legCost > restingBudget) { this.blockedReason = `resting budget $${restingBudget.toFixed(2)} reached`; continue }\n          if (exposure + count * legCost > totalExposureCap) { this.blockedReason = `total weather exposure cap $${totalExposureCap.toFixed(2)} reached`; continue }", 'quoter budget rails')
s=rep(s, "            exposure += count * legCost\n            quoting++", "            exposure += count * legCost\n            newRestingExposure += count * legCost\n            quoting++", 'budget increment')
s=rep(s, "      this.note = `quoting ${quoting} sides on ${chosen.length} markets (${cands.length} candidates), AS-exposure $${r2(exposure).toFixed(2)}`", "      this.note = `quoting ${quoting} sides on ${chosen.length} markets (${cands.length} candidates), total $${r2(exposure).toFixed(2)} (positions $${r2(positionRisk).toFixed(2)} + resting $${r2(newRestingExposure).toFixed(2)})${this.blockedReason ? '; ' + this.blockedReason : ''}`", 'quoter status note')
save(rel,s)

# Convergence lifecycle and safe retries
rel='src/main/strategies/cryptoConvergence.ts'; s=load(rel)
s=rep(s, "  status: 'pending' | 'filled' | 'settled'", "  status: 'no_fill' | 'error' | 'shadow' | 'filled' | 'settled'", 'convergence status union')
s=rep(s, "  note: string\n}", "  note: string\n  attempts: number\n  fills: number\n  noFills: number\n  openTrades: number\n  dailyFills: number\n}", 'Convergence status fields')
old="""  status(cfg: CryptoConvergenceConfig): CryptoConvergenceStatus {
    return {
      enabled: cfg.convergenceEnabled,"""
new="""  status(cfg: CryptoConvergenceConfig): CryptoConvergenceStatus {
    const today = new Date().toISOString().slice(0, 10)
    return {
      enabled: cfg.convergenceEnabled,"""
s=rep(s,old,new,'Convergence status today')
s=rep(s, "      note: this.note\n", "      note: this.note,\n      attempts: this.state.trades.filter((t) => t.status !== 'shadow').length,\n      fills: this.state.trades.filter((t) => t.status === 'filled' || t.status === 'settled').length,\n      noFills: this.state.trades.filter((t) => t.status === 'no_fill').length,\n      openTrades: this.state.trades.filter((t) => t.status === 'filled').length,\n      dailyFills: this.state.trades.filter((t) => (t.status === 'filled' || t.status === 'settled') && t.ts.slice(0, 10) === today).length\n", 'Convergence status data')
# migrate legacy pending after load
needle="""    } catch {
      // fresh state
    }

    // Initialize live sub-second spot websocket feed"""
repl="""    } catch {
      // fresh state
    }
    // Legacy IOC misses were stored as "pending" even though no exchange
    // order remained. Normalize them so the UI and retry logic are truthful.
    for (const t of this.state.trades as Array<ConvergenceTrade & { status: string }>) {
      if (t.status === 'pending') t.status = 'no_fill'
    }

    // Initialize live sub-second spot websocket feed"""
s=rep(s,needle,repl,'legacy pending migration')
# one decision restriction -> retry max 3 only if no fill
old="""          // One independent decision per event, across all strikes and all
          // repeated 30-second scans. Never re-enter after a fill or no-fill.
          if (this.state.trades.some((t) => (t.eventTicker ?? t.marketTicker) === eventTicker)) continue

          const openLive = this.state.trades.filter((t) => t.status === 'filled' && Date.parse(t.closeTime) > now).length
          const today = new Date(now).toISOString().slice(0, 10)
          const liveToday = this.state.trades.filter((t) => t.status !== 'pending' && t.ts.slice(0, 10) === today).length"""
new="""          // One FILLED position per event. IOC zero-fills are execution
          // observations, not positions; permit up to three bounded retries
          // in the fixed T-5 window instead of idling after one missed quote.
          const sameEvent = this.state.trades.filter((t) => (t.eventTicker ?? t.marketTicker) === eventTicker)
          if (sameEvent.some((t) => t.status === 'filled' || t.status === 'settled')) continue
          if (sameEvent.filter((t) => t.status === 'no_fill' || t.status === 'error').length >= 3) continue

          const openLive = this.state.trades.filter((t) => t.status === 'filled' && Date.parse(t.closeTime) > now).length
          const today = new Date(now).toISOString().slice(0, 10)
          const liveToday = this.state.trades.filter((t) => (t.status === 'filled' || t.status === 'settled') && t.ts.slice(0, 10) === today).length"""
s=rep(s,old,new,'event retry logic')
s=rep(s, "            status: 'pending'\n", "            status: canTrade ? 'no_fill' : 'shadow'\n", 'initial status')
# canTrade is currently declared after object, move declaration before object
# The above introduced use-before-declaration. Insert declaration before object and remove later.
s=rep(s, "          const trade: ConvergenceTrade = {", "          const canTrade = mode === 'live' && armed && !killed && cfg.convergenceLiveEnabled\n          const trade: ConvergenceTrade = {", 'canTrade before trade')
s=rep(s, "          const canTrade = mode === 'live' && armed && !killed && cfg.convergenceLiveEnabled\n          if (canTrade) {", "          if (canTrade) {", 'remove later canTrade')
s=rep(s, "              trade.status = res.shares > 0 ? 'filled' : 'pending'", "              trade.status = res.shares > 0 ? 'filled' : 'no_fill'", 'convergence fill status')
old="""            } catch (e) {
              this.log(`[convergence] place failed on ${m.ticker}: ${e instanceof Error ? e.message : String(e)}`)
            }"""
new="""            } catch (e) {
              trade.status = 'error'
              this.log(`[convergence] place failed on ${m.ticker}: ${e instanceof Error ? e.message : String(e)}`)
            }"""
s=rep(s,old,new,'error status')
save(rel,s)

# AutoTrader config/migration/wiring
rel='src/main/strategies/autoTrader.ts'; s=load(rel, sig=True)
s=rep(s, "  quoterMaxExposure: 20,\n  quoterMaxInventory: 3,", "  quoterMaxExposure: 3,\n  quoterMaxPositionExposure: 25,\n  quoterMaxInventory: 1,", 'default quoter caps')
s=rep(s, "  convergenceMaxDailyTrades: 3,", "  convergenceMaxDailyTrades: 6,", 'default convergence cap')
s=s.replace('configVersion: 19','configVersion: 20',1)
insert="""    if ((persisted.configVersion ?? 1) < 20) {
      // v20: improve research throughput without increasing per-order size.
      // Resting quote collateral is separate from already-filled weather
      // positions, while a hard total cap prevents unbounded accumulation.
      this.config.quoterMaxContracts = 1
      this.config.quoterMaxMarkets = 4
      this.config.quoterMaxExposure = 3
      this.config.quoterMaxPositionExposure = 25
      this.config.quoterMaxInventory = 1
      this.config.convergenceMaxDailyTrades = 6
      this.persist(20)
    }
"""
s=rep(s, "    if ((persisted.configVersion ?? 1) < 19) {", insert+"    if ((persisted.configVersion ?? 1) < 19) {", 'v20 migration insert')
# Note order means v20 persist then v19 condition checks persisted old and persists 19, bad. Move insert after v19 block instead.
# Undo structurally by replacing the combined section placement: remove inserted and add after exact v19 closing block.
s=s.replace(insert,'',1)
marker="""      this.config.intelligenceMinEdgeCents = 2
      this.persist(19)
    }
  }
"""
s=rep(s,marker,"""      this.config.intelligenceMinEdgeCents = 2
      this.persist(19)
    }
"""+insert+"  }\n",'v20 after v19')
s=rep(s, "      quoterMaxExposure: cfg.quoterMaxExposure ?? 3,\n      quoterMaxInventory:", "      quoterMaxExposure: cfg.quoterMaxExposure ?? 3,\n      quoterMaxPositionExposure: cfg.quoterMaxPositionExposure ?? 25,\n      quoterMaxInventory:", 'quoterCfg total cap')
save(rel,s)

# Quant UI richer telemetry
rel='src/renderer/src/QuantPanel.tsx'; s=load(rel)
s=rep(s, "                    {status?.convergence.gradedTrades ?? 0} / {status?.convergence.wins ?? 0}", "                    {status?.convergence.gradedTrades ?? 0} / {status?.convergence.wins ?? 0}\n                    <div style={{ fontSize: 10, color: '#64748b' }}>{status?.convergence.fills ?? 0} fills / {status?.convergence.attempts ?? 0} attempts / {status?.convergence.noFills ?? 0} no-fills</div>", 'convergence telemetry UI')
s=rep(s, "                    ${(status?.quoter.exposure ?? 0).toFixed(2)}", "                    ${(status?.quoter.exposure ?? 0).toFixed(2)}\n                    <div style={{ fontSize: 10, color: '#64748b' }}>pos ${(status?.quoter.positionExposure ?? 0).toFixed(2)} + rest ${(status?.quoter.restingExposure ?? 0).toFixed(2)} / cap ${(status?.quoter.totalExposureCap ?? 0).toFixed(2)}</div>", 'quoter telemetry UI')
save(rel,s)

print('patched')
