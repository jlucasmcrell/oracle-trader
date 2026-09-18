import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC } from '../../shared/ipc'
import type { EngineState, PortfolioSnapshot } from '../../shared/ipc'
import type { HistoryStats, LivePnl, OpenOrder, OrderBook, Position, VenueId, VenueMarket } from '../../shared/types'
import AutoTraderPanel from './AutoTraderPanel'
import MiniAutoPanel from './MiniAutoPanel'
import BacktestPanel from './BacktestPanel'
import ResearchPanel from './ResearchPanel'
import SettingsPanel from './SettingsPanel'
import QuantPanel from './QuantPanel'
import IbkrPanel from './IbkrPanel'
import PolyPaperPanel from './PolyPaperPanel'

export default function App() {
  const [state, setState] = useState<EngineState | null>(null)
  const [portfolio, setPortfolio] = useState<PortfolioSnapshot | null>(null)
  const [histStats, setHistStats] = useState<HistoryStats | null>(null)
  /** Kalshi adapter is pointed at demo.kalshi.co (mock funds). Same call the Settings panel makes. */
  const [kalshiDemo, setKalshiDemo] = useState(false)
  const [livePnl, setLivePnl] = useState<LivePnl | null>(null)
  const [showSettlementDetails, setShowSettlementDetails] = useState(false)
  /** Resting (unfilled) maker orders for the selected venue - the pre-fill state of a position. */
  const [restingOrders, setRestingOrders] = useState<OpenOrder[]>([])
  const [markets, setMarkets] = useState<VenueMarket[]>([])
  const [venue, setVenue] = useState<VenueId>('kalshi')
  // The venue whose numbers the panel is allowed to show; responses that
  // arrive for another venue after a tab switch are dropped.
  const venueRef = useRef<VenueId>(venue)
  venueRef.current = venue
  const [term, setTerm] = useState('')
  const [sort, setSort] = useState('liquidity')
  const [category, setCategory] = useState('')
  const [categoryList, setCategoryList] = useState<string[]>([])
  const [stake, setStake] = useState(1)
  const [vetTopic, setVetTopic] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showIbkr, setShowIbkr] = useState(false)
  const [showResearch, setShowResearch] = useState(false)
  const [showQuant, setShowQuant] = useState(false)
  const [book, setBook] = useState<OrderBook | null>(null)
  const [bookQuestion, setBookQuestion] = useState('')
  const [mcMarket, setMcMarket] = useState<VenueMarket | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const addLog = useCallback((line: string) => {
    setLog((prev) => [new Date().toLocaleTimeString() + '  ' + line, ...prev].slice(0, 80))
  }, [])

  const refresh = useCallback(async (v: VenueId) => {
    const [s, p, h] = await Promise.all([
      window.api.engine.getState(),
      window.api.portfolio.get(v),
      window.api.history.stats(v)
    ])
    if (venueRef.current !== v) return
    setState(s)
    setPortfolio(p)
    setHistStats(h)
    // Venue-authoritative and fetched in the same portfolio snapshot, avoiding
    // a duplicate authenticated open-orders request every 15 seconds.
    setRestingOrders(p.openOrders ?? [])
    window.api.settings
      .get()
      .then((cfg) => setKalshiDemo(cfg.kalshiDemo === true))
      .catch(() => undefined)
    if (s.executionMode === 'live') {
      window.api.portfolio
        .livePnl(v)
        .then((lp) => {
          if (venueRef.current === v) setLivePnl(lp)
        })
        .catch(() => {
          if (venueRef.current === v) setLivePnl(null)
        })
    } else {
      setLivePnl(null)
    }
  }, [])

  const doSearch = useCallback(
    async (v: VenueId, q: string, s: string, c: string) => {
      try {
        const results = await window.api.markets.search(v, {
          term: q || undefined,
          limit: 100,
          sort: s,
          status: 'open',
          category: c || undefined
        })
        setMarkets(results)
      } catch (err) {
        addLog(`Search failed: ${String(err)}`)
      }
    },
    [addLog]
  )

  // A tab switch must never show the previous venue's numbers while the new
  // venue's calls are in flight.
  useEffect(() => {
    setPortfolio(null)
    setHistStats(null)
    setLivePnl(null)
    setRestingOrders([])
  }, [venue])

  useEffect(() => {
    refresh(venue)
    doSearch(venue, term, sort, category)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, doSearch, venue, sort, category])

  // Balance/positions are cheap and are what the tab is watched for - poll
  // them often. The market search is a full venue scan, so it stays slow;
  // running both on one 60s timer made the whole tab feel stale.
  useEffect(() => {
    const t = setInterval(() => refresh(venue), 15_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, venue])

  useEffect(() => {
    const t = setInterval(() => doSearch(venue, term, sort, category), 5 * 60_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doSearch, venue, term, sort, category])

  // live strategy events from the main process
  useEffect(() => {
    const off = window.api.onEvent(IPC.event, (raw) => {
      const p = raw as { type: string; payload: Record<string, unknown> }
      if (p.type === 'autoopened') {
        addLog(
          `AutoTrader ${String(p.payload.strategy)} -> ${String(p.payload.outcome)} $${String(p.payload.amount)} on "${String(p.payload.question).slice(0, 36)}..."`
        )
      } else if (p.type === 'autoexited') {
        addLog(`AutoTrader exit: ${String(p.payload.reason)} (${String(p.payload.marketId).slice(0, 20)}...)`)
      } else if (p.type === 'autoresting') {
        addLog(
          `AutoTrader resting ${String(p.payload.outcome)} @ ${String(p.payload.legCost !== undefined ? Math.round(Number(p.payload.legCost) * 100) : '?')}c on "${String(p.payload.question).slice(0, 36)}..."`
        )
      } else if (p.type === 'autoexpired') {
        addLog(`AutoTrader pulled/expired: ${String(p.payload.question ?? p.payload.marketId).slice(0, 48)}`)
      } else if (p.type === 'killswitch') {
        addLog(`KILL SWITCH: ${String(p.payload.reason ?? JSON.stringify(p.payload)).slice(0, 80)}`)
      } else if (p.type === 'orphanorder' || p.type === 'orphanposition') {
        addLog(`Reconcile: ${p.type} on ${String(p.payload.marketId).slice(0, 28)}`)
      } else if (p.type === 'autoscan') {
        addLog(`AutoTrader scan: ${p.payload.scanned} seen  -  ${p.payload.candidates} candidates  -  ${p.payload.approved} approved  -  ${p.payload.executed} executed`)
      } else if (p.type === 'miniopened') {
        addLog(
          `Mini ${String(p.payload.venue)}: ${String(p.payload.strategy)} -> ${String(p.payload.outcome)} on "${String(p.payload.question).slice(0, 34)}..."`
        )
      } else if (p.type === 'miniexited') {
        addLog(`Mini ${String(p.payload.venue)} exit: ${String(p.payload.reason)} (${String(p.payload.marketId).slice(0, 20)}...)`)
      } else if (p.type === 'miniscan') {
        addLog(`Mini ${String(p.payload.venue)} scan: ${p.payload.scanned} seen  -  ${p.payload.candidates} candidates  -  ${p.payload.executed} executed`)
      }
    })
    return off
  }, [addLog])

  // load Kalshi's category list for the dropdown
  useEffect(() => {
    if (venue === 'kalshi') {
      window.api.categories
        .get()
        .then(setCategoryList)
        .catch(() => setCategoryList([]))
    }
  }, [venue])

  const selectVenue = (v: VenueId) => {
    setShowIbkr(false)
    setVenue(v)
    addLog(`Venue -> ${v}`)
  }

  const setMode = async (mode: 'paper' | 'live') => {
    let s
    try {
      s = await window.api.engine.setExecutionMode(mode)
    } catch (err) {
      addLog(`Mode change refused: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    setState(s)
    addLog(`Execution mode -> ${mode}`)
    await refresh(venue)
  }

  const openBook = async (m: VenueMarket) => {
    try {
      const b = await window.api.markets.orderBook(venue, m.id)
      setBook(b)
      setBookQuestion(m.question)
    } catch (err) {
      addLog(`Order book failed: ${String(err)}`)
    }
  }

  const buy = async (m: VenueMarket, outcome: 'YES' | 'NO', amount: number) => {
    setBusy(true)
    try {
      const res = await window.api.engine.placeOrder({ venue, marketId: m.id, outcome, amount, feeRate: m.feeRate })
      const state = res.status === 'filled' ? 'filled' : res.status === 'partial' ? 'partially filled' : 'resting'
      addLog(
        `Buy ${outcome} ${amount} on "${m.question.slice(0, 40)}" -> ${state} ${res.shares.toFixed(2)} shares @ ${(res.avgPrice * 100).toFixed(1)}%`
      )
      await refresh(venue)
    } catch (err) {
      addLog(`Order failed: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const buyAnswer = async (m: VenueMarket, answer: { id: string; text: string }, amount: number) => {
    setBusy(true)
    try {
      const res = await window.api.engine.placeOrder({
        venue,
        marketId: m.id,
        outcome: answer.text,
        answerId: answer.id,
        amount,
        feeRate: m.feeRate
      })
      addLog(`Buy "${answer.text}" ${amount} on "${m.question.slice(0, 40)}" -> ${res.shares.toFixed(2)} shares`)
      await refresh(venue)
    } catch (err) {
      addLog(`Order failed: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const sell = async (pos: Position) => {
    setBusy(true)
    try {
      await window.api.engine.sellPosition({
        venue,
        marketId: pos.marketId,
        outcome: pos.outcome,
        answerId: pos.answerId
      })
      addLog(`Closed ${pos.outcome} position on "${(pos.marketQuestion ?? pos.marketId).slice(0, 40)}"`)
      await refresh(venue)
    } catch (err) {
      addLog(`Sell failed: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const mode = state?.executionMode ?? 'paper'
  const venues = state?.venues ?? []
  const positionMark = portfolio?.positionValue ?? (portfolio?.positions ?? []).reduce((sum, p) => sum + (p.shares ?? 0) * (p.currentPrice ?? 0), 0)
  const orderReserve = portfolio?.openOrderReserve ?? restingOrders.reduce((sum, o) => sum + o.remainingCount * (o.outcome === 'NO' ? 1 - o.yesPrice : o.yesPrice), 0)
  const positionCost = (portfolio?.positions ?? []).reduce((sum, p) => sum + (p.shares ?? 0) * (p.avgPrice ?? 0), 0)

  return (
    <div className="app">
      <header className="topbar">
        <h1>Oracle Trader</h1>
        <div className="venue-toggle">
          {venues.map((v) => (
            v.id !== 'ibkr' && <button key={v.id} className={!showIbkr && venue === v.id ? 'active' : ''} onClick={() => selectVenue(v.id)}>
              {v.name}
            </button>
          ))}
          <button className={showIbkr ? 'active' : ''} onClick={() => setShowIbkr(true)}>IBKR</button>
        </div>
        <div className="mode-toggle" style={showIbkr?{display:'none'}:undefined}>
          <button className={mode === 'paper' ? 'active' : ''} onClick={() => setMode('paper')}>
            Paper
          </button>
          <button className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')}>
            Live
          </button>
          {kalshiDemo && (
            <span
              title="Kalshi orders go to demo.kalshi.co (mock funds). Click to open Settings -> Kalshi -> Demo exchange."
              onClick={() => setShowSettings(true)}
              style={{
                cursor: 'pointer',
                marginLeft: 8,
                padding: '2px 8px',
                borderRadius: 4,
                background: '#b45309',
                color: '#fff',
                fontWeight: 700,
                fontSize: 11,
                letterSpacing: 1
              }}
            >
              KALSHI DEMO
            </span>
          )}
        </div>
        <button className="ghost" onClick={() => setShowQuant(true)} style={{ color: "#60a5fa", borderColor: "#2563eb" }} title="Quant Hub">
           Quant Hub
        </button>
        <button className="ghost" onClick={() => setShowResearch(true)} title="Research">
          Research
        </button>
        <button className="ghost" onClick={() => setShowSettings(true)} title="Settings">
          Settings
        </button>
      </header>

      {showIbkr ? <IbkrPanel /> : <main>
        {venue==='polymarket-us'&&<PolyPaperPanel />}
        <section className="panel summary">
          <h2>Account</h2>
          {portfolio ? (
            <div>
              {(() => {
                const cash = portfolio.account?.balance ?? 0
                const unrealized = positionMark - positionCost
                const live = portfolio.mode === 'live'
                const pnl = livePnl?.available ? livePnl : null
                // Net result from the venue's own records. Settlements and the cash ledger exclude open positions, so
                // add their mark-to-market; 'account-cash' already counts their cost as spent, so add their full mark.
                const net = pnl ? pnl.realizedPnl + (pnl.source === 'account-cash' ? positionMark : unrealized) : undefined
                const since = (ms: number) => (pnl?.details ?? []).filter((d) => d.timestamp >= Date.now() - ms).reduce((n, d) => n + d.realizedPnl, 0)
                const signed = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`
                const tone = (v: number) => (v >= 0 ? 'bt-pos' : 'bt-neg')
                return (
                  <>
                    <div className={`acct-mode ${live ? 'acct-live' : 'acct-paper'}`}>
                      {live ? 'LIVE · real money' : 'PAPER · simulated'} · {portfolio.account?.username ?? venue}
                      {kalshiDemo && venue === 'kalshi' ? ' · DEMO exchange (mock funds)' : ''}
                    </div>
                    <div className="acct-headline">
                      <div>
                        <div className="stat-label">Account value</div>
                        <div className="big">${(portfolio.totalValue ?? 0).toFixed(2)} <span>{portfolio.currency}</span></div>
                        <div className="muted">cash + open positions at current prices</div>
                      </div>
                      {net !== undefined && (
                        <div style={{ textAlign: 'right' }}>
                          <div className="stat-label">Net result</div>
                          <div className={`big ${tone(net)}`}>{signed(net)}</div>
                          <div className="muted">
                            {pnl!.fromTs ? `since ${new Date(pnl!.fromTs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : 'all recorded trading'}, after fees
                          </div>
                        </div>
                      )}
                    </div>
                    {pnl ? (
                      <div className="acct-stats acct-grid">
                        <span className="stat" title={pnl.source === 'settlements' ? "Profit or loss on every market that has settled, from the venue's settlement records, after fees." : "Realized profit from the venue's cash records, excluding deposits and credits."}>
                          <span className="stat-label">Settled P&amp;L</span>
                          <span className={`stat-val ${tone(pnl.realizedPnl)}`}>{signed(pnl.realizedPnl)}</span>
                        </span>
                        <span className="stat" title="Open positions at current prices minus what they cost. Not locked in until they settle or are sold.">
                          <span className="stat-label">Open P&amp;L</span>
                          <span className={`stat-val ${tone(unrealized)}`}>{signed(unrealized)}</span>
                        </span>
                        {pnl.details && pnl.details.length > 0 && (
                          <>
                            <span className="stat" title="Settled P&L on markets that settled in the last 24 hours.">
                              <span className="stat-label">Last 24 h</span>
                              <span className={`stat-val ${tone(since(86_400_000))}`}>{signed(since(86_400_000))}</span>
                            </span>
                            <span className="stat" title="Settled P&L on markets that settled in the last 7 days.">
                              <span className="stat-label">Last 7 days</span>
                              <span className={`stat-val ${tone(since(7 * 86_400_000))}`}>{signed(since(7 * 86_400_000))}</span>
                            </span>
                          </>
                        )}
                        <span className="stat" title="Trading fees paid to the venue; already subtracted from the P&L figures.">
                          <span className="stat-label">Fees paid</span>
                          <span className="stat-val">${(pnl.fees ?? 0).toFixed(2)}</span>
                        </span>
                        <span className="stat" title="Settled markets (Kalshi) or settlement records (Polymarket US).">
                          <span className="stat-label">Settled</span>
                          <span className="stat-val">{pnl.settlements}</span>
                        </span>
                      </div>
                    ) : live ? (
                      <div className="muted" style={{ marginTop: 8 }}>
                        {livePnl ? `Venue P&L unavailable: ${livePnl.unavailableReason ?? 'not enough venue data'} (${livePnl.fills} fills seen).` : 'Loading P&L from the venue...'}
                      </div>
                    ) : null}
                    <div className="account-breakdown">
                      <span>Cash ${cash.toFixed(2)} · free ${Math.max(0, cash - orderReserve).toFixed(2)} · in resting orders ${orderReserve.toFixed(2)}</span>
                      <span>Open positions ${positionMark.toFixed(2)} at current prices (cost ${positionCost.toFixed(2)})</span>
                    </div>
                    {pnl?.source === 'settlements' && (
                      <div className="muted">
                        {pnl.wins ?? 0} settled profitable · {pnl.losses ?? 0} losing · {pnl.flat ?? 0} flat
                        <button className="inline-link" onClick={() => setShowSettlementDetails((v) => !v)}>
                          {showSettlementDetails ? 'Hide settlements' : 'Show settlements'}
                        </button>
                      </div>
                    )}
                    {histStats && (
                      <details className="muted" style={{ marginTop: 6 }}>
                        <summary>In-app trade log (partial: most strategy engines do not write to it)</summary>
                        {histStats.completedTrades} completed · win rate {(histStats.winRate ?? 0).toFixed(0)}% · realized {signed(histStats.realizedPnl ?? 0)}. Use the venue figures above.
                      </details>
                    )}
                  </>
                )
              })()}
              {livePnl && livePnl.available && (
                <div>
                      {showSettlementDetails && livePnl.details && (
                        <div className="settlement-list">
                          {[...livePnl.details].sort((a, b) => b.timestamp - a.timestamp).map((row) => (
                            <div className="settlement-row" key={`${row.marketId}-${row.timestamp}`}>
                              <span title={row.marketId}>{row.marketId.slice(0, 29)}</span>
                              <span>{row.result}</span>
                              <span>cost {row.cost.toFixed(2)}</span>
                              <span>proceeds {row.revenue.toFixed(2)}</span>
                              {(row.pairedRevenue ?? 0) > 0 && <span>paired {(row.pairedRevenue ?? 0).toFixed(2)}</span>}
                              <span className={row.realizedPnl >= 0 ? 'bt-pos' : 'bt-neg'}>
                                {row.realizedPnl >= 0 ? '+' : ''}{row.realizedPnl.toFixed(2)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                </div>
              )}
              <div className="section-label">Open orders ({restingOrders.length})</div>
              {restingOrders.length === 0 ? (
                <div className="muted">No resting orders. Maker orders appear here until they fill or are pulled.</div>
              ) : (
                <ul className="positions">
                  {restingOrders.map((o) => (
                    <li key={o.orderId} className="position-card">
                      <div className="pos-head">
                        <span className={`p-outcome ${o.outcome === 'YES' ? 'bt-pos' : 'bt-neg'}`}>{o.outcome}</span>
                        <span className="p-shares">
                          resting @ {((o.outcome === 'NO' ? 1 - o.yesPrice : o.yesPrice) * 100).toFixed(0)}c
                        </span>
                        {(o.expirationTs ?? 0) > 0 && <span className="pos-expiry">expires {fmtClose((o.expirationTs ?? 0) * 1000)}</span>}
                      </div>
                      <div className="pos-q" title={o.marketId}>
                        {o.marketId.slice(0, 64)}
                      </div>
                      <div className="pos-foot">
                        <span className="muted">venue order - {o.remainingCount} remaining  -  order {o.orderId.slice(0, 8)}...</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="section-label">Open positions ({portfolio.positions.length})</div>
              {portfolio.positions.length === 0 ? (
                <div className="muted">No open positions.</div>
              ) : (
                <ul className="positions">
                  {portfolio.positions.map((p, i) => (
                    <li key={i} className="position-card">
                      <div className="pos-head">
                        <span className={`p-outcome ${p.outcome === 'YES' ? 'bt-pos' : 'bt-neg'}`}>{p.outcome}</span>
                        <span className="p-shares">{(p.shares ?? 0).toFixed(0)} sh @ {((p.avgPrice ?? 0) * 100).toFixed(0)}%</span>
                        {p.closeTime && <span className="pos-expiry">expires {fmtClose(p.closeTime)}</span>}
                      </div>
                      <div className="pos-q" title={p.marketQuestion ?? p.marketId}>
                        {(p.marketQuestion ?? p.marketId).slice(0, 64)}
                      </div>
                      <div className="pos-foot">
                        {p.currentPrice !== undefined && (
                          <span className="pos-now">now {(p.currentPrice * 100).toFixed(0)}%</span>
                        )}
                        {p.unrealizedPnl !== undefined && (
                          <span className={`pos-pnl ${(p.unrealizedPnl ?? 0) >= 0 ? 'bt-pos' : 'bt-neg'}`}>
                            {(p.unrealizedPnl ?? 0) >= 0 ? '+' : ''}
                            {(p.unrealizedPnl ?? 0).toFixed(0)}
                          </span>
                        )}
                        {p.resolution !== undefined && (
                          <span className="muted">{p.resolution === 'YES' || p.resolution === 'yes' ? ' won' : ' lost'}</span>
                        )}
                        <button className="sell" disabled={busy} onClick={() => sell(p)}>
                          Sell
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="muted">Loading...</div>
          )}
        </section>

        <section className="panel">
          <h2>Kalshi AutoTrader</h2>
          <AutoTraderPanel log={addLog} onChanged={() => refresh(venue)} />
        </section>

        <section className="panel">
          <h2>Mini AutoTrader (Manifold  -  Polymarket US)</h2>
          <MiniAutoPanel venue={venue === 'kalshi' ? 'manifold' : venue} log={addLog} onChanged={() => refresh(venue)} />
        </section>

        <section className="panel">
          <h2>Event Scanner</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              doSearch(venue, term, sort, category)
            }}
          >
            <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search markets..." />
            <button type="submit">Search</button>
          </form>
          <div className="filters">
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="liquidity">Liquidity</option>
              <option value="volume">Volume (24h)</option>
              <option value="prob-descending">Probability (high)</option>
              <option value="ending-soon">Ending soon</option>
              <option value="newest">Newest</option>
              <option value="signal">Signal</option>
            </select>
            {venue === 'kalshi' ? (
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All categories</option>
                {categoryList.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Category (e.g. politics, crypto, economics)..."
              />
            )}
            <label className="stake">
              Order size
              <input type="number" min={0.01} step={0.01} value={stake} onChange={(e) => setStake(Number(e.target.value))} />
            </label>
          </div>
          <ul className="markets">
            {(sort === 'signal' ? [...markets].sort((a, b) => signalScore(b) - signalScore(a)) : markets).map((m) => {
              const isBinary = !m.outcomeType || m.outcomeType === 'BINARY'
              return (
                <li key={m.id}>
                  <div className="q" title={m.question}>
                    {m.question}
                  </div>
                  <div className="meta">
                    <span
                      className="prob"
                      title="Market-implied probability of YES (from the last trade). Buy YES if you think it's too low; buy NO if you think it's too high. Not a guaranteed payout."
                    >
                      {m.probability !== undefined ? `${(m.probability * 100).toFixed(0)}%` : '-'}
                    </span>
                    <span className="muted">
                      vol24h {fmtNum(m.volume24h)}
                      {m.liquidity !== undefined
                        ? `  -  liq ${fmtNum(m.liquidity)}`
                        : m.spread !== undefined
                          ? `  -  spread ${(m.spread * 100).toFixed(1)}c`
                          : ''}
                      {m.feeRate !== undefined ? `  -  fee ${(m.feeRate * 100).toFixed(1)}%` : ''}
                    </span>
                    <span className="close-time">expires {fmtClose(m.closeTime)}</span>
                    <span className="sig" title="Signal: liquidity + volume + price + horizon">
                      Sig {signalScore(m)}
                    </span>
                    <button
                      className="vet"
                      onClick={() => {
                        setVetTopic(m.question)
                        setShowResearch(true)
                      }}
                    >
                      Vet
                    </button>
                    <button className="vet" onClick={() => openBook(m)}>
                      Book
                    </button>
                    {isBinary ? (
                      <span className="buy-buttons">
                        <button disabled={busy} onClick={() => buy(m, 'YES', stake)}>
                          Buy YES {fmtStake(stake, portfolio?.currency)}
                        </button>
                        <button disabled={busy} onClick={() => buy(m, 'NO', stake)}>
                          Buy NO {fmtStake(stake, portfolio?.currency)}
                        </button>
                      </span>
                    ) : (
                      <button className="vet" onClick={() => setMcMarket(m)}>
                        Outcomes ({m.outcomes?.length ?? 0})
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>

        <section className="panel">
          <h2>Trade History</h2>
          <BacktestPanel markets={markets} venue={venue} log={addLog} />
        </section>

        <section className="panel">
          <h2>Activity Log</h2>
          <ul className="log">
            {log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      </main>}

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Settings</h2>
              <button className="ghost" onClick={() => setShowSettings(false)}>
                X
              </button>
            </div>
            <SettingsPanel log={addLog} />
          </div>
        </div>
      )}

      {showQuant && <QuantPanel onClose={() => setShowQuant(false)} />}

      {showResearch && (
        <div className="modal-overlay" onClick={() => setShowResearch(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Research &amp; Arbitrage</h2>
              <button className="ghost" onClick={() => setShowResearch(false)}>
                X
              </button>
            </div>
            <ResearchPanel seed={vetTopic} log={addLog} />
          </div>
        </div>
      )}

      {mcMarket && (
        <div className="modal-overlay" onClick={() => setMcMarket(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Outcomes</h2>
              <button className="ghost" onClick={() => setMcMarket(null)}>
                X
              </button>
            </div>
            <div className="muted" style={{ marginBottom: 8 }}>
              {mcMarket.question}
            </div>
            <ul className="markets" style={{ maxHeight: 420 }}>
              {(mcMarket.outcomes ?? []).map((o) => (
                <li key={o.id} className="mc-row">
                  <span className="prob">{(o.probability ?? 0) >= 0 ? `${((o.probability ?? 0) * 100).toFixed(0)}%` : '-'}</span>
                  <span className="q">{o.text}</span>
                  <button disabled={busy} onClick={() => buyAnswer(mcMarket, o, stake)}>
                    Buy {fmtStake(stake, portfolio?.currency)}
                  </button>
                </li>
              ))}
              {!(mcMarket.outcomes?.length) && <li className="muted">No outcomes listed.</li>}
            </ul>
          </div>
        </div>
      )}

      {book && (
        <div className="modal-overlay" onClick={() => setBook(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Order Book</h2>
              <button className="ghost" onClick={() => setBook(null)}>
                X
              </button>
            </div>
            <div className="muted" style={{ marginBottom: 8 }}>
              {bookQuestion}
            </div>
            <div className="book">
              <div className="book-side">
                <div className="section-label">Sell YES (asks)</div>
                {book.asks.length === 0 && <div className="muted">empty</div>}
                {book.asks.slice(0, 12).map((a, i) => (
                  <div key={i} className="book-row">
                    <span className="bt-neg">{(a.price * 100).toFixed(0)}%</span>
                    <span>{a.size.toFixed(0)}</span>
                  </div>
                ))}
              </div>
              <div className="book-side">
                <div className="section-label">Buy YES (bids)</div>
                {book.bids.length === 0 && <div className="muted">empty</div>}
                {book.bids.slice(0, 12).map((b, i) => (
                  <div key={i} className="book-row">
                    <span className="bt-pos">{(b.price * 100).toFixed(0)}%</span>
                    <span>{b.size.toFixed(0)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtStake(n: number, currency?: string): string {
  const sym = currency === 'M$' ? 'M$' : currency === 'USDC' ? 'USDC' : '$'
  return `${n}${sym}`
}

function fmtNum(n?: number): string {
  if (n === undefined || n === null) return '-'
  const num = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(num)) return '-'
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M'
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'k'
  if (num >= 10) return num.toFixed(0)
  return num.toFixed(2)
}

function fmtClose(t?: number): string {
  if (!t) return 'n/a'
  const ms = t - Date.now()
  if (ms < 0) return 'closed'
  const mins = ms / 60_000
  if (mins < 60) return `${Math.round(mins)}m`
  const hours = mins / 60
  if (hours < 48) return `${Math.round(hours)}h`
  const days = hours / 24
  if (days < 60) return `${Math.round(days)}d`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

/** Heuristic 0-100 quality score: liquidity + recent volume + priced + tradable horizon. */
function signalScore(m: VenueMarket): number {
  let s = 0
  if (m.liquidity) s += Math.min(40, Math.log10(m.liquidity + 1) * 6)
  if (m.volume24h) s += Math.min(25, Math.log10(m.volume24h + 1) * 5)
  if (m.probability !== undefined) s += 15
  const ms = m.closeTime ? m.closeTime - Date.now() : 0
  if (ms > 86_400_000 && ms < 365 * 86_400_000) s += 20
  else if (ms > 0) s += 5
  return Math.round(Math.min(100, s))
}

