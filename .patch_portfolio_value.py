from pathlib import Path
root=Path(r'G:\PROJECTS\oracle-trader')
# types AccountInfo
p=root/'src/shared/types.ts'; s=p.read_text(encoding='utf-8')
s=s.replace("  balance: number\n  /** Kalshi: balance per exchange shard", "  balance: number\n  /** Venue-reported marked portfolio value, excluding available cash. */\n  portfolioValue?: number\n  /** Kalshi: balance per exchange shard")
p.write_text(s,encoding='utf-8')
# ipc snapshot
p=root/'src/shared/ipc.ts'; s=p.read_text(encoding='utf-8-sig')
s=s.replace("  positions: Position[]\n  totalValue: number\n  currency: string", "  positions: Position[]\n  /** Venue-authoritative position value where available; otherwise reconstructed mark. */\n  positionValue: number\n  /** Maximum cash committed to currently resting orders (zero in paper mode). */\n  openOrderReserve: number\n  /** Estimated total equity = available cash + position value + resting-order reserve. */\n  totalValue: number\n  currency: string")
p.write_text(s,encoding='utf-8')
# kalshi account portfolio_value
p=root/'src/main/venues/kalshi.ts'; s=p.read_text(encoding='utf-8')
s=s.replace("      balance: parseBalance(data),\n      // Collateral", "      balance: parseBalance(data),\n      portfolioValue: typeof data.portfolio_value === 'number' ? data.portfolio_value / 100 : undefined,\n      // Collateral")
p.write_text(s,encoding='utf-8')
# engine portfolio method
p=root/'src/main/engine/engine.ts'; s=p.read_text(encoding='utf-8')
s=s.replace("""      return {
        mode: 'paper',
        account: broker.getAccount(),
        positions,
        totalValue: broker.getBalance() + positionsValue,
        currency: broker.currency
      }""", """      return {
        mode: 'paper',
        account: broker.getAccount(),
        positions,
        positionValue: positionsValue,
        openOrderReserve: 0,
        totalValue: broker.getBalance() + positionsValue,
        currency: broker.currency
      }""")
old="""    const positions = await this.enrichPositions(venue, rawPositions)
    const positionsValue = positions.reduce((sum, p) => sum + p.shares * (p.currentPrice ?? 0), 0)
    return {
      mode: 'live',
      account,
      positions,
      totalValue: (account?.balance ?? 0) + positionsValue,
      currency: adapter.currency
    }"""
new="""    const positions = await this.enrichPositions(venue, rawPositions)
    const reconstructedPositionValue = positions.reduce((sum, p) => sum + p.shares * (p.currentPrice ?? 0), 0)
    const positionValue = account?.portfolioValue ?? reconstructedPositionValue
    // Kalshi reports available balance and portfolio value separately; cash
    // committed to resting orders is in neither. Add it back to total equity
    // while showing it separately in the UI. Other venues retain the prior
    // conservative calculation until they expose an authoritative portfolio value.
    let openOrderReserve = 0
    if (account?.portfolioValue !== undefined && adapter.getOpenOrders) {
      const orders = await adapter.getOpenOrders().catch(() => [])
      openOrderReserve = orders.reduce(
        (sum, o) => sum + o.remainingCount * (o.outcome === 'NO' ? 1 - o.yesPrice : o.yesPrice),
        0
      )
    }
    return {
      mode: 'live',
      account,
      positions,
      positionValue,
      openOrderReserve,
      totalValue: (account?.balance ?? 0) + positionValue + openOrderReserve,
      currency: adapter.currency
    }"""
if old not in s: raise SystemExit('portfolio block missing')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
# UI use authoritative fields
p=root/'src/renderer/src/App.tsx'; s=p.read_text(encoding='utf-8')
s=s.replace("  const positionMark = (portfolio?.positions ?? []).reduce((sum, p) => sum + (p.shares ?? 0) * (p.currentPrice ?? 0), 0)\n  const orderReserve = restingOrders.reduce((sum, o) => sum + o.remainingCount * (o.outcome === 'NO' ? 1 - o.yesPrice : o.yesPrice), 0)", "  const positionMark = portfolio?.positionValue ?? (portfolio?.positions ?? []).reduce((sum, p) => sum + (p.shares ?? 0) * (p.currentPrice ?? 0), 0)\n  const orderReserve = portfolio?.openOrderReserve ?? restingOrders.reduce((sum, o) => sum + o.remainingCount * (o.outcome === 'NO' ? 1 - o.yesPrice : o.yesPrice), 0)")
s=s.replace('Open-position mark: {positionMark.toFixed(2)}','Venue portfolio value: {positionMark.toFixed(2)}')
s=s.replace('Maximum cost if every resting order fills. Venue cash treatment varies; this is shown separately and is not added to marked value.','Maximum cost if every resting order fills. This is excluded from available cash and included in estimated total equity.')
p.write_text(s,encoding='utf-8')
print('portfolio accounting patched')
