import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { createWriteStream, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { VenueAdapter } from '../shared/venue'
import { VenueRegistry } from './venues/registry'
import { KalshiAdapter } from './venues/kalshi'
import { startCfReferenceShadow } from './venues/cfReferenceShadow'
import { setCullDir } from './venues/cullRecorder'
import { detectIbkrGateway } from './venues/ibkrGateway'
import { IbkrAdapter } from './venues/ibkrAdapter'
import { IbkrWatchTrader } from './strategies/ibkrWatch'
import { IbkrLab } from './strategies/ibkrLab'
import { PolyPaperLab } from './strategies/polyPaper'
import { PolymarketUsAdapter } from './venues/polymarketUs'
import { IbkrReader } from './venues/ibkr'
import { IBApi } from '@stoqey/ib'
import { vetWithLlm } from './strategies/vetting'
import { setMomentumCandidateDir } from './strategies/momentumCandidates'
import { TradingEngine } from './engine/engine'
import { Scanner } from './strategies/scanner'
import { AutoTrader } from './strategies/autoTrader'
import { MiniAuto } from './strategies/miniAuto'
import { runBacktest } from './strategies/backtester'
import { researchTopic } from './strategies/research'
import { ConfigStore } from './store/config'
import { HistoryStore } from './store/history'
import { FillReconciler } from './store/fillReconciler'
import { Ladder } from './ladder/ladder'
import { fastLeadLagRead, ReadRunner } from './ladder/registeredReads'
import { HttpClient } from './util/http'
import { sendAlert } from './util/alert'
import { NightlyReview } from './intelligence/nightlyReview'
import { IPC } from '../shared/ipc'
import type { AutoTraderConfig, BacktestParams, KalshiConnection, MiniAutoConfig, RiskLimits, SettingsView } from '../shared/ipc'
import type { ExecutionMode, MarketSearchQuery, OrderRequest, SellRequest, VenueId } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let engine: TradingEngine
let config: ConfigStore
let autoTrader: AutoTrader
let reconcilerIbkr: FillReconciler
let ibkrLab: IbkrLab
let polyPaper: PolyPaperLab
const miniAutos = new Map<VenueId, MiniAuto>()

// Two instances would share the same state files and could place duplicate
// orders — refuse to start twice; focus the existing window instead.
const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

/**
 * Make main-process logging pipe-proof. When the app is launched from a shell
 * that later exits (or with no console at all), writes to stdout/stderr can
 * throw EPIPE — Electron turns that into an un-dismissable error dialog.
 * Swallow pipe errors and mirror every line to a rolling log file instead.
 */
function installSafeLogging(): void {
  const logDir = join(app.getPath('userData'), 'logs')
  let stream: ReturnType<typeof createWriteStream> | null = null
  try {
    mkdirSync(logDir, { recursive: true })
    stream = createWriteStream(join(logDir, 'main.log'), { flags: 'a' })
  } catch {
    stream = null
  }
  const write = (level: string, args: unknown[]): void => {
    let line = ''
    try {
      line = `[${new Date().toISOString()}] [${level}] ${args
        .map((a) => {
          if (typeof a === 'string') return a
          try {
            return JSON.stringify(a)
          } catch {
            return String(a)
          }
        })
        .join(' ')}`
    } catch {
      line = `[${new Date().toISOString()}] [${level}] <unserializable>`
    }
    try {
      stream?.write(line + '\n')
    } catch {
      // ignore
    }
    try {
      process.stdout.write(line + '\n')
    } catch {
      // EPIPE etc. — the file already has it
    }
  }
  console.log = (...a: unknown[]) => write('log', a)
  console.warn = (...a: unknown[]) => write('warn', a)
  console.error = (...a: unknown[]) => write('error', a)
  // Belt and braces: swallow pipe errors on the underlying streams.
  process.stdout.on('error', () => undefined)
  process.stderr.on('error', () => undefined)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // surface renderer errors/warnings + crashes to the main-process log
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] process gone:', details.reason, details.exitCode)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Credentials for whichever Kalshi environment is selected. Demo keys
 * authenticate only against demo hosts and production keys only against
 * production, so the two pairs are stored separately and chosen here.
 */
function kalshiCreds(): { apiKeyId?: string; privateKey?: string; demo: boolean } {
  const c = config.get()
  return c.kalshiDemo
    ? { apiKeyId: c.kalshiDemoApiKeyId || undefined, privateKey: c.kalshiDemoPrivateKey || undefined, demo: true }
    : { apiKeyId: c.kalshiApiKeyId || undefined, privateKey: c.kalshiPrivateKey || undefined, demo: false }
}

function registerIpc(): void {
  ipcMain.handle(IPC.engineGetState, () => engine.getState())
  ipcMain.handle(IPC.engineSetMode, (_e, mode: ExecutionMode) => {
    // The renderer can only send the two literals, but an IPC argument is untrusted input and the engine
    // has no validation of its own: anything else would take the live submission path (audit B-40).
    if (mode !== 'paper' && mode !== 'live') throw new Error(`Unknown execution mode ${JSON.stringify(mode)}`)
    const current = engine.getExecutionMode()
    if (mode !== current) {
      // A flip mid-session contaminates the ledgers: paper positions can
      // never settle through the live path and vice versa. Observed
      // 2026-09-02: a click to Paper during a demo run put a paper fill
      // into the demo ledger. Refuse while anything is held; the operator
      // stops the trader (or restores a parked state) first.
      const k = autoTrader.getStatus()
      const held = k.openTrades.length + (k.pendingOrders ?? []).length
      // Resting mini orders count too (audit 2026-09-19, B-11): a live->paper flip while maker orders rested promoted
      // their later fills into a paper-governed ledger that discarded them at settlement.
      const miniHeld = [...miniAutos.values()].reduce((n, m) => { const s = m.getStatus(); return n + s.openTrades.length + (s.pendingOrders ?? []).length }, 0)
      if (held + miniHeld > 0) {
        throw new Error(
          `Cannot switch to ${mode}: Kalshi holds ${k.openTrades.length} open + ${(k.pendingOrders ?? []).length} resting, minis hold ${miniHeld}. ` +
            'Stop the traders and close/park positions before changing execution mode.'
        )
      }
      console.log(`[main] execution mode ${current} -> ${mode} (kalshiDemo=${config.get().kalshiDemo})`)
    }
    engine.setExecutionMode(mode)
    config.update({ executionMode: mode })
    return engine.getState()
  })
  ipcMain.handle(IPC.enginePlaceOrder, (_e, req: OrderRequest) => engine.placeOrder(req))
  ipcMain.handle(IPC.engineSell, (_e, req: SellRequest) => engine.sellPosition(req))
  ipcMain.handle(IPC.marketsSearch, (_e, venue: VenueId, query: MarketSearchQuery) =>
    engine.searchMarkets(venue, query)
  )
  ipcMain.handle(IPC.marketsOrderBook, async (_e, venue: VenueId, marketId: string) => {
    const adapter = engine.getAdapter(venue)
    if (!adapter?.getOrderBook) throw new Error(`Order book is not supported for ${venue}`)
    return adapter.getOrderBook(marketId)
  })
  ipcMain.handle(IPC.portfolioGet, (_e, venue: VenueId, mode?: ExecutionMode) => engine.getPortfolio(venue, mode))
  ipcMain.handle(IPC.portfolioLivePnl, async (_e, venue: VenueId) => {
    const pnl = await engine.getLivePnl(venue)
    // The panel shows the newest rows; the full list stays in the engine for the ladder's evidence (GLM F-04).
    return pnl?.details && pnl.details.length > 1000 ? { ...pnl, details: pnl.details.slice(0, 1000) } : pnl
  })
  ipcMain.handle(IPC.portfolioOpenOrders, async (_e, venue: VenueId) => {
    if (engine.getExecutionMode() !== 'live') return []
    const adapter = engine.getAdapter(venue)
    if (!adapter?.getOpenOrders) return []
    return adapter.getOpenOrders()
  })
  ipcMain.handle(IPC.autoTraderGet, () => autoTrader.getConfig())
  ipcMain.handle(IPC.autoTraderSet, (_e, cfg: Partial<AutoTraderConfig>) => {
    // Config flips (enabled / liveArmed / entry mode) were undiagnosable
    // after the fact - a mini came back enabled mid-demo with no trace.
    // Log the fields that change trading behaviour.
    console.log('[main] autoTrader config set:', JSON.stringify({ enabled: cfg.enabled, liveArmed: cfg.liveArmed, fadeEntryMode: cfg.fadeEntryMode, stopEntry: cfg.stopEntry }))
    return autoTrader.setConfig(cfg)
  })
  ipcMain.handle(IPC.autoTraderScan, () => autoTrader.tick())
  ipcMain.handle(IPC.autoTraderStatus, () => autoTrader.getStatus())
  ipcMain.handle(IPC.quantStatus, () => autoTrader.getQuantStatus())
  ipcMain.handle(IPC.autoTraderReset, () => autoTrader.reset())
  ipcMain.handle(IPC.autoTraderTestVet, () => autoTrader.testVet())
  const requireMini = (venue: VenueId): MiniAuto => {
    const m = miniAutos.get(venue)
    if (!m) throw new Error(`No mini auto-trader for '${venue}'`)
    return m
  }
  ipcMain.handle(IPC.autoMiniGet, (_e, venue: VenueId) => requireMini(venue).getConfig())
  ipcMain.handle(IPC.autoMiniSet, (_e, venue: VenueId, cfg: Partial<MiniAutoConfig>) => {
    console.log(`[main] mini ${venue} config set:`, JSON.stringify({ enabled: cfg.enabled, liveArmed: cfg.liveArmed, fadeEntryMode: cfg.fadeEntryMode }))
    return requireMini(venue).setConfig(cfg)
  })
  ipcMain.handle(IPC.autoMiniScan, (_e, venue: VenueId) => requireMini(venue).tick())
  ipcMain.handle(IPC.autoMiniStatus, (_e, venue: VenueId) => requireMini(venue).getStatus())
  ipcMain.handle(IPC.autoMiniReset, (_e, venue: VenueId) => requireMini(venue).reset())
  ipcMain.handle(IPC.autoMiniPreview, async (_e, venue: VenueId, req: OrderRequest) => {
    // No-money proof of the order contract: the venue validates the exact
    // payload placeOrder would send and returns the calculated order.
    const adapter = engine.getAdapter(venue) as { previewOrder?: (o: OrderRequest) => Promise<unknown> } | undefined
    if (!adapter?.previewOrder) throw new Error(`${venue} has no order preview`)
    console.log('[main] order PREVIEW (nothing placed):', JSON.stringify({ venue, marketId: req.marketId, outcome: req.outcome, limitPrice: req.limitPrice, amount: req.amount }))
    return adapter.previewOrder(req)
  })
  ipcMain.handle(IPC.historyList, (_e, limit: number | undefined, venue: VenueId | undefined) => engine.getHistory(limit, venue))
  ipcMain.handle(IPC.historyStats, (_e, venue: VenueId | undefined) => engine.getHistoryStats(venue))
  ipcMain.handle(IPC.categoriesGet, async () => {
    const adapter = engine.getAdapter('kalshi')
    return adapter?.getCategories ? adapter.getCategories() : []
  })
  ipcMain.handle(IPC.backtestRun, (_e, params: BacktestParams) => runBacktest(engine, params))
  ipcMain.handle(IPC.researchRun, (_e, topic: string) => researchTopic(engine, topic))
  ipcMain.handle(IPC.shellOpen, (_e, url: string) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url)
  })
  ipcMain.handle(IPC.settingsGet, async () => {
    const cfg = config.get()
    let kalshiBalance: number | undefined
    if (cfg.kalshiApiKeyId && cfg.kalshiPrivateKey) {
      try {
        const acc = await engine.getAdapter('kalshi')?.getAccount()
        kalshiBalance = acc?.balance
      } catch {
        // ignore — credentials may be stale/invalid
      }
    }
    let polymarketUsBalance: number | undefined
    if (cfg.polymarketUsApiKeyId && cfg.polymarketUsPrivateKey) {
      try {
        const acc = await engine.getAdapter('polymarket-us')?.getAccount()
        polymarketUsBalance = acc?.balance
      } catch {
        // ignore — credentials may be stale/invalid
      }
    }
    return {
      executionMode: cfg.executionMode,
      hasKalshiKey: !!(cfg.kalshiApiKeyId && cfg.kalshiPrivateKey),
      kalshiBalance,
      kalshiDemo: cfg.kalshiDemo,
      hasKalshiDemoKey: !!(cfg.kalshiDemoApiKeyId && cfg.kalshiDemoPrivateKey),
      hasPolymarketUsKey: !!(cfg.polymarketUsApiKeyId && cfg.polymarketUsPrivateKey),
      polymarketUsBalance,
      riskLimits: cfg.riskLimits
    } as SettingsView
  })
  ipcMain.handle(IPC.settingsTestIbkrGateway, () => detectIbkrGateway())
  const ibkrVenue = engine.getAdapter('ibkr') as IbkrAdapter
  const ibkr = ibkrVenue.reader
  ipcMain.handle(IPC.ibkrSnapshot, () => ibkr.snapshot())
  ipcMain.handle(IPC.ibkrMarkets, (_e, symbol: unknown, month: unknown) => ibkr.markets(symbol, month))
  ipcMain.handle(IPC.ibkrQuote, (_e, conId: unknown) => ibkr.quote(conId))
  ipcMain.handle(IPC.ibkrPreview, (_e, req: OrderRequest) => ibkrVenue.preview(req))
  ipcMain.handle(IPC.ibkrCancel, (_e, id: string) => ibkrVenue.cancelOrder(id))
  const ibkrWatch = new IbkrWatchTrader(engine, ibkrVenue, join(app.getPath('userData'), 'ibkr-watches.json'))
  ipcMain.handle(IPC.ibkrWatches, () => ibkrWatch.list())
  ipcMain.handle(IPC.ibkrLabStatus, () => ibkrLab.status())
  ipcMain.handle(IPC.polyPaperStatus, () => polyPaper.status())
  ipcMain.handle(IPC.polyPaperEnabled, (_e, enabled) => polyPaper.setEnabled(enabled))
  ipcMain.handle(IPC.ibkrLabConfigure, (_e, patch) => ibkrLab.configure(patch))
  ipcMain.handle(IPC.ibkrLabScan, () => { void ibkrLab.scan(); return ibkrLab.status() })
  ipcMain.handle(IPC.ibkrReconciliation, () => reconcilerIbkr.status())
  ipcMain.handle(IPC.ibkrWatchAdd, (_e, req: OrderRequest, expiresAt: number) => ibkrWatch.add(req, expiresAt))
  ipcMain.handle(IPC.ibkrWatchStop, (_e, id: string) => ibkrWatch.stop(id))
  const ibkrWatchTimer = setInterval(() => void ibkrWatch.tick().catch(e=>console.error('[ibkr-watch]',String(e))),60_000)
  app.once('before-quit',()=>clearInterval(ibkrWatchTimer))
  ipcMain.handle(IPC.settingsSaveKalshi, async (_e, apiKeyId: string, privateKey: string) => {
    const id = typeof apiKeyId === 'string' ? apiKeyId.trim() : ''
    const pk = typeof privateKey === 'string' ? privateKey : ''
    // Writes to the DEMO slot while demo mode is on, so switching back never
    // loses the production key.
    config.update(config.get().kalshiDemo ? { kalshiDemoApiKeyId: id, kalshiDemoPrivateKey: pk } : { kalshiApiKeyId: id, kalshiPrivateKey: pk })
    await engine.setCredentials('kalshi', kalshiCreds())
    if (!id || !pk) return { connected: false } as KalshiConnection
    try {
      const acc = await engine.getAdapter('kalshi')!.getAccount()
      return { connected: true, balance: acc.balance } as KalshiConnection
    } catch (err) {
      return { connected: false, error: err instanceof Error ? err.message : String(err) } as KalshiConnection
    }
  })
  ipcMain.handle(IPC.settingsSetKalshiDemo, async (_e, demo: boolean) => {
    // Flipping the exchange host while orders rest is the most dangerous click
    // in the app: demo -> production with liveArmed=true and executionMode=live
    // would send the NEXT scan's orders with real money, while the ledger's
    // resting orders belong to the other exchange. Refuse while anything is held.
    if ((demo === true) !== (config.get().kalshiDemo === true)) {
      const k = autoTrader.getStatus()
      const held = k.openTrades.length + (k.pendingOrders ?? []).length
      if (held > 0) {
        throw new Error(
          `Cannot switch Kalshi to ${demo ? 'DEMO' : 'PRODUCTION'}: the trader holds ${k.openTrades.length} open + ${(k.pendingOrders ?? []).length} resting on the current exchange. ` +
            'Stop the trader and close or park them first.'
        )
      }
      console.log(`[main] kalshi exchange -> ${demo ? 'DEMO' : 'PRODUCTION'} (executionMode=${engine.getExecutionMode()})`)
    }
    config.update({ kalshiDemo: demo === true })
    const creds = kalshiCreds()
    await engine.setCredentials('kalshi', creds)
    if (!creds.apiKeyId || !creds.privateKey) {
      return {
        connected: false,
        error: demo
          ? 'No DEMO credentials saved yet — generate a key at demo.kalshi.co and save it here.'
          : 'No production credentials saved.'
      } as KalshiConnection
    }
    try {
      const acc = await engine.getAdapter('kalshi')!.getAccount()
      return { connected: true, balance: acc.balance } as KalshiConnection
    } catch (err) {
      return { connected: false, error: err instanceof Error ? err.message : String(err) } as KalshiConnection
    }
  })
  ipcMain.handle(IPC.settingsSavePolymarketUs, async (_e, apiKeyId: string, secretKey: string) => {
    const id = typeof apiKeyId === 'string' ? apiKeyId.trim() : ''
    const sk = typeof secretKey === 'string' ? secretKey.trim() : ''
    config.update({ polymarketUsApiKeyId: id, polymarketUsPrivateKey: sk })
    await engine.setCredentials('polymarket-us', { apiKeyId: id || undefined, privateKey: sk || undefined })
    if (!id || !sk) return { connected: false } as KalshiConnection
    try {
      const acc = await engine.getAdapter('polymarket-us')!.getAccount()
      return { connected: true, balance: acc.balance } as KalshiConnection
    } catch (err) {
      return { connected: false, error: err instanceof Error ? err.message : String(err) } as KalshiConnection
    }
  })
  ipcMain.handle(IPC.settingsRiskLimits, (_e, r: RiskLimits) => {
    // MERGE, never replace. The renderer sends only the two fields it knows about; replacing the stored
    // object with that literal silently wiped any per-venue override on the next settings save.
    const next = config.update({ riskLimits: { ...config.get().riskLimits, ...r } }).riskLimits
    engine.setRiskLimits(next)
    return next
  })
  ipcMain.handle(IPC.settingsResetPaper, () => {
    // The traders' reset() cancels every resting order and drops every
    // tracked position. In live mode those are REAL. The button says paper.
    if (engine.getExecutionMode() === 'live') {
      throw new Error('Reset is paper-only: switch execution mode to paper first.')
    }
    engine.resetPaperAccounts()
    engine.clearHistory()
    // Also clear every strategy's own open-trade ledger so the whole paper
    // simulation starts from a single consistent blank slate.
    autoTrader.reset()
    for (const m of miniAutos.values()) m.reset()
  })
  ipcMain.handle(IPC.scannerScan, (_e, venue: VenueId, query: MarketSearchQuery) =>
    new Scanner(engine).scan(venue, query)
  )
}

app.whenReady().then(async () => {
  if (!singleInstance) return
  installSafeLogging()
  config = new ConfigStore()
  // The venue adapter records what the anti-flood cap discards, but must not import electron itself — it is
  // pulled into the test suite. Hand it the directory here; unset means inert.
  setCullDir(join(app.getPath('userData'), 'universe-culled'))
  setMomentumCandidateDir(join(app.getPath('userData'), 'momentum-candidates'))
  const history = new HistoryStore(join(app.getPath('userData'), 'history.json'))
  const registry = new VenueRegistry()
  engine = new TradingEngine(registry, history, {
    paperStateDir: app.getPath('userData'),
    paperStartingBalances: config.get().paperStartingBalances
  })
  await engine.init({
    kalshi: kalshiCreds(),
    'polymarket-us': { apiKeyId: config.get().polymarketUsApiKeyId, privateKey: config.get().polymarketUsPrivateKey }
  })
  engine.setExecutionMode(config.get().executionMode)
  engine.setRiskLimits(config.get().riskLimits)
  // Background Polymarket US catalog walk (§118): started here, not in the adapter's init, so tests never touch the gateway.
  const polyUs = engine.getAdapter('polymarket-us')
  if (polyUs instanceof PolymarketUsAdapter) polyUs.startCatalogRefresh(join(app.getPath('userData'), 'polyus-moneylines.json'))



  autoTrader = new AutoTrader(engine, join(app.getPath('userData'), 'kalshi-auto.json'))
  // Research uses its own client and ledger; Kalshi's live mode never becomes an IBKR paper setting.
  const ibkrResearch = new IbkrReader(port => new IBApi({host:'127.0.0.1',port,clientId:17093}))
  ibkrLab = new IbkrLab(join(app.getPath('userData'),'ibkr-lab.json'),ibkrResearch,engine,engine.getAdapter('ibkr') as IbkrAdapter,{
    forecastProvider: process.env.OPENROUTER_API_KEY ? 'OpenRouter / deepseek/deepseek-v4-pro' : 'Configured Oracle model',
    forecast: async (market,probability) => {
      const cfg=autoTrader.getConfig()
      const labModel=process.env.OPENROUTER_API_KEY?{...cfg,llmBaseUrl:'https://openrouter.ai/api/v1',llmApiKey:process.env.OPENROUTER_API_KEY,llmModel:'deepseek/deepseek-v4-pro'}:cfg
      const verdict = await vetWithLlm(labModel,{
        id:`ibkr:${market.id}`,strategy:'news',marketId:market.id,question:market.question,outcome:'YES',price:probability,score:0,confidence:0,executed:false,
        details:{venue:'IBKR ForecastEx',purpose:'Independent paper forecast; abstain if evidence is insufficient',rulesUrl:market.rulesUrl}
      },{marketId:market.id,question:market.question,yesProb:probability,closeInMinutes:(market.closeTime-Date.now())/60000,category:market.category,costCents:4,recentTrades:[],rules:`Exact exchange question: ${market.question}. Contract specification URL (not fetched): ${market.rulesUrl}. Do not assume rules not supplied.`},
      {executionMode:'paper',balance:1000,openPositions:0,stake:1,maxOpenPositions:4,dailyTradesLeft:8})
      return verdict.impliedProb!==undefined ? {p:verdict.impliedProb,reason:verdict.reason,approved:verdict.approve} : undefined
    }
  })
  const labStart=setTimeout(()=>void ibkrLab.scan(),10000)
  const labTimer=setInterval(()=>void ibkrLab.scan(),30000)
  const polyVenue=new PolymarketUsAdapter(1500)
  const polyPaperPath=join(app.getPath('userData'),'poly-paper.json')
  const polyPaperVenue:Pick<VenueAdapter,'searchMarkets'|'getMarket'|'getOrderBook'>={
    // Discovery goes through the ENGINE's adapter, the one instance that carries the catalog index (§118); the paced
    // instance was never indexed, so the lab's "whole venue" walk was still the 3,000-row fallback (audit B-18).
    searchMarkets:q=>(polyUs instanceof PolymarketUsAdapter?polyUs:polyVenue).searchMarkets(q),getMarket:id=>polyVenue.getMarket(id),getOrderBook:id=>polyVenue.getOrderBook!(id)
  }
  try{polyPaper=new PolyPaperLab(polyPaperPath,polyPaperVenue)}
  catch(err){
    // A paper lab's state file must never keep the live Kalshi trader from starting: the constructor throws on a
    // BOM or a missing cash entry, and it ran before autoTrader.start() with no catch (audit 2026-09-19, B-30).
    const aside=`${polyPaperPath}.corrupt-${Date.now()}`
    console.warn(`[poly-paper] state unreadable (${err instanceof Error?err.message:String(err)}); moving to ${aside} and starting fresh`)
    try{renameSync(polyPaperPath,aside)}catch{/* missing or locked: the fresh lab overwrites on its first save */}
    polyPaper=new PolyPaperLab(polyPaperPath,polyPaperVenue)
  }
  const polyStart=setTimeout(()=>void polyPaper.scan(),20000)
  const polyTimer=setInterval(()=>void polyPaper.scan(),60000)
  app.once('before-quit',()=>{clearTimeout(polyStart);clearInterval(polyTimer)})
  app.once('before-quit',()=>{clearTimeout(labStart);clearInterval(labTimer)})
  autoTrader.setEventHandler((type, payload) => {
    mainWindow?.webContents.send(IPC.event, { type, payload })
  })
  autoTrader.start()
  const referenceVenue = engine.getAdapter('kalshi')
  if (referenceVenue instanceof KalshiAdapter) {
    const stopReference = startCfReferenceShadow(referenceVenue, join(app.getPath('userData'), 'cf-reference-shadow'))
    app.once('before-quit', stopReference)
  }

  for (const venue of ['polymarket-us'] as VenueId[]) {
    const mini = new MiniAuto(engine, venue, join(app.getPath('userData'), `mini-auto-${venue}.json`))
    mini.setEventHandler((type, payload) => {
      mainWindow?.webContents.send(IPC.event, { type, payload })
    })
    mini.start()
    miniAutos.set(venue, mini)
  }

  // Venue-fill reconciler: publishes every Kalshi fill the shared ledger has
  // not seen (resting orders fill after placement) into history.json,
  // regardless of which strategy placed it or whether it is still enabled.
  // First run backfills; then every 5 minutes with overlap.
  const reconciler = new FillReconciler(engine, history, join(app.getPath('userData'), 'fill-reconciler-kalshi.json'), 'kalshi')
  setTimeout(() => void reconciler.run(), 40_000)
  setInterval(() => void reconciler.run(), 5 * 60_000)
  // Polymarket US too: its activity feed carried 168 automated fills the local
  // ledger had never seen (found 2026-09-06).
  const reconcilerUs = new FillReconciler(engine, history, join(app.getPath('userData'), 'fill-reconciler-polymarket-us.json'), 'polymarket-us')
  setTimeout(() => void reconcilerUs.run(), 70_000)
  setInterval(() => void reconcilerUs.run(), 5 * 60_000)
  reconcilerIbkr = new FillReconciler(engine, history, join(app.getPath('userData'), 'fill-reconciler-ibkr.json'), 'ibkr')
  setTimeout(() => void reconcilerIbkr.run(), 90_000)
  setInterval(() => void reconcilerIbkr.run(), 60_000)

  // Promotion ladder: evaluates every tested strategy's pre-registered gate
  // (2 minutes after start, then hourly) and moves it between shadow,
  // tiny-live and disabled on its own. The operator's global arm is never
  // touched; without it no promotion can spend, and demotions always run.
  const ladder = new Ladder(engine, autoTrader, miniAutos, app.getAppPath(), app.getPath('userData'))
  setTimeout(() => void ladder.levelShards(), 90_000)
  setTimeout(() => void ladder.run(), 2 * 60_000)
  setInterval(() => void ladder.run(), 60 * 60_000)

  // Pre-registered reads run themselves (section 163): each from its date, once a UTC day, applying the registered
  // action on PASS or FAIL and pushing the verdict. Nobody has to remember a date or flip a switch.
  const kalshiPublic = new HttpClient({ baseUrl: 'https://api.elections.kalshi.com/trade-api/v2', rateLimit: 1, rateLimitWindowMs: 1100, timeoutMs: 20_000 })
  const reads = new ReadRunner(
    join(app.getPath('userData'), 'registered-reads.json'),
    [
      fastLeadLagRead({
        shadowPath: join(app.getPath('userData'), 'leadlag-fast-shadow.jsonl'),
        kalshiSettled: async (series, minCloseTs) => {
          const out: { ticker: string; result?: string }[] = []
          let cursor = ''
          for (let page = 0; page < 20; page++) {
            const d = await kalshiPublic.get<{ markets?: { ticker: string; result?: string }[]; cursor?: string }>(
              `/markets?series_ticker=${series}&status=settled&limit=1000&min_close_ts=${minCloseTs}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
            )
            out.push(...(d.markets ?? []))
            cursor = d.cursor ?? ''
            if (!cursor || !(d.markets ?? []).length) break
          }
          return out
        },
        setFastLive: (on) => void autoTrader.setConfig({ leadLagFastLive: on })
      })
    ],
    (title, message) => {
      const url = autoTrader.getConfig().alertWebhookUrl
      if (url) void sendAlert(url, title, message)
    }
  )
  setTimeout(() => void reads.tick(Date.now()), 5 * 60_000)
  setInterval(() => void reads.tick(Date.now()), 60 * 60_000)

  // Nightly LLM strategy review: checked hourly, runs once per UTC day after
  // the configured hour; files under userData/reviews; applies only bounded
  // numeric parameters of non-live strategies.
  const review = new NightlyReview(engine, autoTrader, miniAutos, ladder, app.getPath('userData'))
  setTimeout(() => void review.runIfDue(), 10 * 60_000)
  setInterval(() => void review.runIfDue(), 60 * 60_000)

  autoTrader.setAuxStatus(() => ({ ladder: ladder.status(), lastReview: review.status() }))
  autoTrader.setShardLeveller(() => ladder.levelShards())

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
