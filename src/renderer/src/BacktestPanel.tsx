import { useCallback, useEffect, useState } from 'react'
import type { BacktestResult } from '../../shared/ipc'
import type { HistoryStats, PricePoint, TradeRecord, VenueId, VenueMarket } from '../../shared/types'

interface Props {
  markets: VenueMarket[]
  venue: VenueId
  log: (line: string) => void
}

export default function BacktestPanel({ markets, venue, log }: Props) {
  const [marketId, setMarketId] = useState('')
  const [buyBelow, setBuyBelow] = useState(0.4)
  const [sellAbove, setSellAbove] = useState(0.6)
  const [amountPerTrade, setAmountPerTrade] = useState(100)
  const [startBalance, setStartBalance] = useState(10000)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<TradeRecord[]>([])
  const [stats, setStats] = useState<HistoryStats | null>(null)

  const loadHistory = useCallback(async () => {
    const [h, s] = await Promise.all([window.api.history.list(100, venue), window.api.history.stats(venue)])
    setHistory(h)
    setStats(s)
  }, [venue])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  useEffect(() => {
    if (!marketId && markets.length > 0) setMarketId(markets[0].id)
  }, [markets, marketId])

  const run = async () => {
    if (!marketId) {
      setError('Select a market first.')
      return
    }
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const r = await window.api.backtest.run({ venue, marketId, buyBelow, sellAbove, amountPerTrade, startBalance })
      setResult(r)
      log(`Backtest ${r.marketId.slice(0, 12)}...: ${r.returnPct.toFixed(1)}% over ${r.points} points`)
      await loadHistory()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="backtest">
      <div className="bt-row">
        <select value={marketId} onChange={(e) => setMarketId(e.target.value)}>
          {markets.length === 0 && <option value="">(no markets loaded)</option>}
          {markets.map((m) => (
            <option key={m.id} value={m.id}>
              {m.question.slice(0, 60)}
            </option>
          ))}
        </select>
      </div>

      <div className="bt-row">
        <label className="inline">
          Buy below
          <input type="number" min={0.01} max={0.99} step={0.01} value={buyBelow} onChange={(e) => setBuyBelow(Number(e.target.value))} />
        </label>
        <label className="inline">
          Sell above
          <input type="number" min={0.01} max={0.99} step={0.01} value={sellAbove} onChange={(e) => setSellAbove(Number(e.target.value))} />
        </label>
        <label className="inline">
          $ / trade
          <input type="number" min={1} value={amountPerTrade} onChange={(e) => setAmountPerTrade(Number(e.target.value))} />
        </label>
        <label className="inline">
          Start $
          <input type="number" min={1} value={startBalance} onChange={(e) => setStartBalance(Number(e.target.value))} />
        </label>
        <button onClick={run} disabled={busy}>
          {busy ? 'Running...' : 'Run backtest'}
        </button>
      </div>

      {venue !== 'kalshi' && <div className="muted">Historical data is currently available on Kalshi - switch venue to backtest its markets.</div>}
      {error && <div className="bt-error">{error}</div>}

      {result && (
        <div className="bt-result">
          <div className="bt-metrics">
            <div>
              <span className="bt-label">Return</span>
              <span className={result.returnPct >= 0 ? 'bt-pos' : 'bt-neg'}>{result.returnPct.toFixed(2)}%</span>
            </div>
            <div>
              <span className="bt-label">Trades</span>
              <span>{result.trades}</span>
            </div>
            <div>
              <span className="bt-label">Win rate</span>
              <span>{result.winRate.toFixed(0)}%</span>
            </div>
            <div>
              <span className="bt-label">Realized</span>
              <span className={result.realizedPnl >= 0 ? 'bt-pos' : 'bt-neg'}>{result.realizedPnl.toFixed(0)}</span>
            </div>
            <div>
              <span className="bt-label">Max drawdown</span>
              <span className="bt-neg">{result.maxDrawdownPct.toFixed(1)}%</span>
            </div>
            <div>
              <span className="bt-label">End balance</span>
              <span>{result.endBalance.toFixed(0)}</span>
            </div>
          </div>
          <Sparkline points={result.priceSeries} />
        </div>
      )}

      <div className="hist-stats">
        {stats && (
          <span className="muted">
            {stats.completedTrades} trades - realized {stats.realizedPnl >= 0 ? '+' : ''}
            {stats.realizedPnl.toFixed(0)} - win rate {stats.winRate.toFixed(0)}% - volume {fmtNum(stats.totalVolume)}
          </span>
        )}
      </div>

      <ul className="hist">
        {history.map((t) => (
          <li key={t.id}>
            <span className="h-time">{fmtTime(t.timestamp)}</span>
            <span className={`h-side ${t.side}`}>{t.side}</span>
            <span className="h-outcome">{t.outcome}</span>
            <span className="h-market" title={t.marketQuestion ?? t.marketId}>
              {t.marketQuestion ?? t.marketId.slice(0, 16)}
            </span>
            <span className="h-price">{(t.price * 100).toFixed(0)}%</span>
            <span className="h-amount">{(t.amount ?? 0).toFixed(0)}</span>
            {t.realizedPnl != null && (
              <span className={(t.realizedPnl ?? 0) >= 0 ? 'bt-pos' : 'bt-neg'}>
                {(t.realizedPnl ?? 0) >= 0 ? '+' : ''}
                {(t.realizedPnl ?? 0).toFixed(0)}
              </span>
            )}
          </li>
        ))}
        {history.length === 0 && <li className="muted">No paper trades yet - buy/sell a market to populate history.</li>}
      </ul>
    </div>
  )
}

function Sparkline({ points, width = 240, height = 44 }: { points: PricePoint[]; width?: number; height?: number }) {
  if (points.length < 2) return null
  const min = Math.min(...points.map((p) => p.price))
  const max = Math.max(...points.map((p) => p.price))
  const range = max - min || 1
  const pts = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width
      const y = height - ((p.price - min) / range) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={width} height={height} className="sparkline">
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  )
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return n.toFixed(0)
}
