import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { Api, AutoTraderConfig, BacktestParams, MiniAutoConfig, RiskLimits } from '../shared/ipc'
import type { ExecutionMode, MarketSearchQuery, OrderRequest, SellRequest, VenueId } from '../shared/types'

const api: Api = {
  engine: {
    getState: () => ipcRenderer.invoke(IPC.engineGetState),
    setExecutionMode: (mode: ExecutionMode) => ipcRenderer.invoke(IPC.engineSetMode, mode),
    placeOrder: (req: OrderRequest) => ipcRenderer.invoke(IPC.enginePlaceOrder, req),
    sellPosition: (req: SellRequest) => ipcRenderer.invoke(IPC.engineSell, req)
  },
  markets: {
    search: (venue: VenueId, query: MarketSearchQuery) => ipcRenderer.invoke(IPC.marketsSearch, venue, query),
    orderBook: (venue: VenueId, marketId: string) => ipcRenderer.invoke(IPC.marketsOrderBook, venue, marketId)
  },
  portfolio: {
    get: (venue: VenueId) => ipcRenderer.invoke(IPC.portfolioGet, venue),
    livePnl: (venue: VenueId) => ipcRenderer.invoke(IPC.portfolioLivePnl, venue),
    openOrders: (venue: VenueId) => ipcRenderer.invoke(IPC.portfolioOpenOrders, venue)
  },
  autoTrader: {
    getConfig: () => ipcRenderer.invoke(IPC.autoTraderGet),
    setConfig: (cfg: AutoTraderConfig) => ipcRenderer.invoke(IPC.autoTraderSet, cfg),
    scan: () => ipcRenderer.invoke(IPC.autoTraderScan),
    getStatus: () => ipcRenderer.invoke(IPC.autoTraderStatus),
    reset: () => ipcRenderer.invoke(IPC.autoTraderReset),
    testVet: () => ipcRenderer.invoke(IPC.autoTraderTestVet)
  },
  autoMini: {
    getConfig: (venue: VenueId) => ipcRenderer.invoke(IPC.autoMiniGet, venue),
    setConfig: (venue: VenueId, cfg: MiniAutoConfig) => ipcRenderer.invoke(IPC.autoMiniSet, venue, cfg),
    scan: (venue: VenueId) => ipcRenderer.invoke(IPC.autoMiniScan, venue),
    getStatus: (venue: VenueId) => ipcRenderer.invoke(IPC.autoMiniStatus, venue),
    reset: (venue: VenueId) => ipcRenderer.invoke(IPC.autoMiniReset, venue),
    preview: (venue: VenueId, req: OrderRequest) => ipcRenderer.invoke(IPC.autoMiniPreview, venue, req)
  },
  history: {
    list: (limit?: number, venue?: VenueId) => ipcRenderer.invoke(IPC.historyList, limit, venue),
    stats: (venue?: VenueId) => ipcRenderer.invoke(IPC.historyStats, venue)
  },
  categories: {
    get: () => ipcRenderer.invoke(IPC.categoriesGet)
  },
  backtest: {
    run: (params: BacktestParams) => ipcRenderer.invoke(IPC.backtestRun, params)
  },
  research: {
    run: (topic: string) => ipcRenderer.invoke(IPC.researchRun, topic)
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke(IPC.shellOpen, url)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    testIbkrGateway: () => ipcRenderer.invoke(IPC.settingsTestIbkrGateway),
    ibkrSnapshot: () => ipcRenderer.invoke(IPC.ibkrSnapshot),
    ibkrMarkets: (symbol, month) => ipcRenderer.invoke(IPC.ibkrMarkets, symbol, month),
    ibkrQuote: (conId) => ipcRenderer.invoke(IPC.ibkrQuote, conId),
    ibkrPreview: (req) => ipcRenderer.invoke(IPC.ibkrPreview, req),
    ibkrCancel: (orderId) => ipcRenderer.invoke(IPC.ibkrCancel, orderId),
    ibkrWatches: () => ipcRenderer.invoke(IPC.ibkrWatches),
    ibkrLabStatus: () => ipcRenderer.invoke(IPC.ibkrLabStatus),
    polyPaperStatus: () => ipcRenderer.invoke(IPC.polyPaperStatus),
    polyPaperEnabled: (enabled) => ipcRenderer.invoke(IPC.polyPaperEnabled,enabled),
    ibkrLabConfigure: (patch) => ipcRenderer.invoke(IPC.ibkrLabConfigure, patch),
    ibkrLabScan: () => ipcRenderer.invoke(IPC.ibkrLabScan),
    ibkrReconciliation: () => ipcRenderer.invoke(IPC.ibkrReconciliation),
    ibkrWatchAdd: (request, expiresAt) => ipcRenderer.invoke(IPC.ibkrWatchAdd, request, expiresAt),
    ibkrWatchStop: (id) => ipcRenderer.invoke(IPC.ibkrWatchStop, id),
    saveKalshiCredentials: (apiKeyId: string, privateKey: string) =>
      ipcRenderer.invoke(IPC.settingsSaveKalshi, apiKeyId, privateKey),
    setKalshiDemo: (demo: boolean) => ipcRenderer.invoke(IPC.settingsSetKalshiDemo, demo),
    savePolymarketUsCredentials: (apiKeyId: string, secretKey: string) =>
      ipcRenderer.invoke(IPC.settingsSavePolymarketUs, apiKeyId, secretKey),
    setRiskLimits: (r: RiskLimits) => ipcRenderer.invoke(IPC.settingsRiskLimits, r),
    resetPaper: () => ipcRenderer.invoke(IPC.settingsResetPaper)
  },
  quant: {
    getStatus: () => ipcRenderer.invoke(IPC.quantStatus)
  },
  scanner: {
    scan: (venue: VenueId, query: MarketSearchQuery) => ipcRenderer.invoke(IPC.scannerScan, venue, query)
  },
  onEvent: (channel: string, listener: (payload: unknown) => void) => {
    const wrapped = (_e: unknown, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('api', api)
