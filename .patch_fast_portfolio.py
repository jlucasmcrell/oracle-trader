from pathlib import Path
root=Path(r'G:\PROJECTS\oracle-trader')
# IPC add openOrders payload
p=root/'src/shared/ipc.ts'; s=p.read_text(encoding='utf-8')
s=s.replace("  openOrderReserve: number\n  /** Estimated total equity", "  openOrderReserve: number\n  /** Venue-authoritative resting orders fetched with this snapshot. */\n  openOrders: OpenOrder[]\n  /** Estimated total equity")
p.write_text(s,encoding='utf-8')
# Engine: paper and live fast path + one order request
p=root/'src/main/engine/engine.ts'; s=p.read_text(encoding='utf-8')
s=s.replace("        openOrderReserve: 0,\n        totalValue:", "        openOrderReserve: 0,\n        openOrders: [],\n        totalValue:")
s=s.replace("""    const rawPositions = account ? await adapter.getPositions().catch(() => []) : []
    const positions = await this.enrichPositions(venue, rawPositions)
    const reconstructedPositionValue = positions.reduce((sum, p) => sum + p.shares * (p.currentPrice ?? 0), 0)""", """    const rawPositions = account ? await adapter.getPositions().catch(() => []) : []
    // Kalshi already reports an authoritative aggregate portfolio value. Do
    // not issue two market requests for every position on every 15-second UI
    // refresh: 54 positions meant 108 sequential calls, minutes of "Loading",
    // and avoidable 429s. Other venues still use best-effort enrichment.
    const positions = account?.portfolioValue !== undefined ? rawPositions : await this.enrichPositions(venue, rawPositions)
    const reconstructedPositionValue = positions.reduce((sum, p) => sum + p.shares * (p.currentPrice ?? 0), 0)""")
s=s.replace("""    let openOrderReserve = 0
    if (account?.portfolioValue !== undefined && adapter.getOpenOrders) {
      const orders = await adapter.getOpenOrders().catch(() => [])
      openOrderReserve = orders.reduce(
        (sum, o) => sum + o.remainingCount * (o.outcome === 'NO' ? 1 - o.yesPrice : o.yesPrice),
        0
      )
    }""", """    let openOrderReserve = 0
    const openOrders = engineLiveOrders(adapter, account?.portfolioValue !== undefined)
      ? await adapter.getOpenOrders!().catch(() => [])
      : []
    openOrderReserve = openOrders.reduce(
      (sum, o) => sum + o.remainingCount * (o.outcome === 'NO' ? 1 - o.yesPrice : o.yesPrice),
      0
    )""")
s=s.replace("      openOrderReserve,\n      totalValue:", "      openOrderReserve,\n      openOrders,\n      totalValue:")
# Add tiny type-narrowing helper before class end? Better module helper near bottom.
insert="""
function engineLiveOrders(adapter: VenueAdapter, hasAuthoritativePortfolioValue: boolean): boolean {
  return hasAuthoritativePortfolioValue && typeof adapter.getOpenOrders === 'function'
}

"""
pos=s.rfind('\n}')
# rfind is class close at end; helper after class is cleaner
s=s+insert
p.write_text(s,encoding='utf-8')
# App: use snapshot orders and remove second duplicate request
p=root/'src/renderer/src/App.tsx'; s=p.read_text(encoding='utf-8')
old="""    setPortfolio(p)
    setHistStats(h)
    // Venue-authoritative: independent strategy engines and manual/API orders
    // do not necessarily appear in the central AutoTrader ledger.
    try {
      setRestingOrders(await window.api.portfolio.openOrders(v))
    } catch {
      setRestingOrders([])
    }"""
new="""    setPortfolio(p)
    setHistStats(h)
    // Venue-authoritative and fetched in the same portfolio snapshot, avoiding
    // a duplicate authenticated open-orders request every 15 seconds.
    setRestingOrders(p.openOrders ?? [])"""
if old not in s: raise SystemExit('App refresh block missing')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
print('fast portfolio patched')
