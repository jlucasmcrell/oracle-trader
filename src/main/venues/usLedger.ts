import type { LivePnl, Position } from '../../shared/types'
import type { UsActivity } from './polymarketUs'

/** Replay actual executions and netting, then prove both cash and inventory match the account. */
export function reconcileUsLedger(activities: UsActivity[], positions: Position[], balance: number, fundingPnl: LivePnl): LivePnl {
  if (!fundingPnl.available) return fundingPnl
  const inventory = new Map<string, { net: number; cost: number }>()
  let cashFlow = 0, realized = 0, pairedCash = 0
  const seen = new Set<string>()
  const number = (value: unknown) => {
    if (value === undefined || value === null || value === '') throw new Error('Missing ledger amount')
    const n = Number(value)
    if (!Number.isFinite(n)) throw new Error('Invalid ledger amount')
    return n
  }
  const dated = activities.filter(a => a.trade || a.positionResolution).map(a => {
    const stamp = a.trade?.createTime ?? a.positionResolution?.updateTime ?? ''
    const at = Date.parse(stamp)
    if (!Number.isFinite(at)) throw new Error('Missing ledger timestamp')
    const nanos = Number((stamp.match(/\.(\d+)/)?.[1] ?? '').padEnd(9, '0').slice(3, 9))
    return { a, at, nanos }
  }).sort((a, b) => a.at - b.at || a.nanos - b.nanos)
  for (const { a } of dated) {
    const t = a.trade, r = a.positionResolution
    const market = t?.marketSlug ?? r?.marketSlug
    if (!market) throw new Error('Missing ledger market')
    const held = inventory.get(market) ?? { net: 0, cost: 0 }
    if (t) {
      if (!t.id || seen.has(t.id)) throw new Error('Missing or duplicate trade ID')
      seen.add(t.id)
      const execution = t.isAggressor ? t.aggressorExecution : t.passiveExecution
      const intent = execution?.order?.intent
      if (!['ORDER_INTENT_BUY_LONG', 'ORDER_INTENT_BUY_SHORT', 'ORDER_INTENT_SELL_LONG', 'ORDER_INTENT_SELL_SHORT'].includes(intent ?? '')) throw new Error('Unknown execution intent')
      const shares = number(execution?.lastShares), yes = number(execution?.lastPx?.value)
      const fee = number(execution?.commissionNotionalCollected?.value ?? 0)
      if (shares <= 0 || yes < 0 || yes > 1) throw new Error('Invalid execution quantity or price')
      const sign = intent!.endsWith('SHORT') ? -1 : 1
      const price = sign === 1 ? yes : 1 - yes
      if (intent!.includes('_BUY_')) {
        const paired = held.net * sign < 0 ? Math.min(Math.abs(held.net), shares) : 0
        const removedCost = paired ? held.cost * paired / Math.abs(held.net) : 0
        cashFlow += -shares * price - fee + paired
        pairedCash += paired
        realized += paired * (1 - price) - removedCost - fee * paired / shares
        held.cost = held.cost - removedCost + (shares - paired) * (price + fee / shares)
        held.net += sign * shares
      } else {
        if (held.net * sign <= 0 || shares > Math.abs(held.net) + 1e-6) throw new Error('Sale exceeds reconstructed inventory')
        const removedCost = held.cost * shares / Math.abs(held.net)
        cashFlow += shares * price - fee
        realized += shares * price - fee - removedCost
        held.cost -= removedCost; held.net -= sign * shares
      }
    } else if (r) {
      const before = number(r.beforePosition?.netPositionDecimal)
      const after = number(r.afterPosition?.netPositionDecimal)
      if (Math.abs(before - held.net) > 1e-6 || Math.abs(after) > 1e-6) throw new Error('Resolution inventory does not reconcile')
      if (!['POSITION_RESOLUTION_SIDE_LONG', 'POSITION_RESOLUTION_SIDE_SHORT'].includes(r.side ?? '')) throw new Error('Unsupported settlement result')
      const payout = (held.net > 0 && r.side === 'POSITION_RESOLUTION_SIDE_LONG') || (held.net < 0 && r.side === 'POSITION_RESOLUTION_SIDE_SHORT') ? Math.abs(held.net) : 0
      cashFlow += payout; realized += payout - held.cost
      held.net = 0; held.cost = 0
    }
    if (Math.abs(held.net) < 1e-6) { held.net = 0; held.cost = 0 }
    inventory.set(market, held)
  }
  for (const a of activities) if (['ACTIVITY_TYPE_TAKER_FEE_REBATE', 'ACTIVITY_TYPE_LIQUIDITY_PROGRAM'].includes(a.type ?? '')) {
    const earned = number(a.accountBalanceChange?.amount?.value)
    cashFlow += earned; realized += earned
  }
  const actual = new Map(positions.map(p => [p.marketId, (p.outcome === 'NO' ? -1 : 1) * p.shares]))
  for (const market of new Set([...inventory.keys(), ...actual.keys()])) {
    if (Math.abs((inventory.get(market)?.net ?? 0) - (actual.get(market) ?? 0)) > 1e-6) throw new Error('Current inventory does not reconcile')
  }
  const funding = balance - fundingPnl.realizedPnl
  const cashDifference = balance - (funding + cashFlow)
  if (Math.abs(cashDifference) > 0.005) throw new Error(`Cash ledger mismatch: ${cashDifference.toFixed(4)} USD`)
  const openCostBasis = [...inventory.values()].reduce((sum, p) => sum + p.cost, 0)
  return { ...fundingPnl, source: 'cash-ledger', realizedPnl: realized, openCostBasis, pairedCash, cashDifference }
}
