import type { TradingEngine } from '../engine/engine'
import type { PricePoint } from '../../shared/types'
import type { BacktestParams, BacktestResult } from '../../shared/ipc'

/**
 * Simple threshold strategy backtest over a venue's historical price series:
 * buy YES when price <= buyBelow, sell when price >= sellAbove.
 */
export async function runBacktest(engine: TradingEngine, params: BacktestParams): Promise<BacktestResult> {
  const adapter = engine.getAdapter(params.venue)
  if (!adapter) throw new Error(`No adapter for '${params.venue}'`)
  if (!adapter.getPriceHistory) throw new Error(`Historical data is not available for ${params.venue} yet (try Kalshi).`)

  const history = await adapter.getPriceHistory(params.marketId, 500)
  if (history.length < 2) throw new Error('Not enough historical data for this market.')

  let cash = params.startBalance
  let shares = 0
  let cost = 0
  let buys = 0
  let sells = 0
  let wins = 0
  let realized = 0
  let peak = params.startBalance
  let maxDrawdown = 0

  for (const pt of history) {
    if (shares === 0 && pt.price > 0 && pt.price <= params.buyBelow) {
      shares = params.amountPerTrade / pt.price
      cost = params.amountPerTrade
      cash -= params.amountPerTrade
      buys++
    } else if (shares > 0 && pt.price >= params.sellAbove) {
      const proceeds = shares * pt.price
      cash += proceeds
      realized += proceeds - cost
      if (proceeds > cost) wins++
      sells++
      shares = 0
      cost = 0
    }
    const equity = cash + shares * pt.price
    if (equity > peak) peak = equity
    const dd = (peak - equity) / peak
    if (dd > maxDrawdown) maxDrawdown = dd
  }

  const lastPrice = history[history.length - 1].price
  const endBalance = cash + shares * lastPrice

  return {
    venue: params.venue,
    marketId: params.marketId,
    points: history.length,
    trades: buys + sells,
    startBalance: params.startBalance,
    endBalance,
    returnPct: ((endBalance - params.startBalance) / params.startBalance) * 100,
    winRate: sells > 0 ? (wins / sells) * 100 : 0,
    realizedPnl: realized,
    maxDrawdownPct: maxDrawdown * 100,
    priceSeries: downsample(history, 80)
  }
}

function downsample(points: PricePoint[], max: number): PricePoint[] {
  if (points.length <= max) return points
  const step = Math.ceil(points.length / max)
  const out: PricePoint[] = []
  for (let i = 0; i < points.length; i += step) out.push(points[i])
  return out
}
