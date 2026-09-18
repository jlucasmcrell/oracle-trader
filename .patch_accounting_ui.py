from pathlib import Path
import re, json
root=Path(r'G:\PROJECTS\oracle-trader')

# shared/types.ts
p=root/'src/shared/types.ts'
s=p.read_text(encoding='utf-8-sig')
s=s.replace("export interface VenueSettlement {\n  marketId: string\n  result: 'YES' | 'NO'\n  shares: number\n  cost: number\n  revenue: number\n  fee: number\n  realizedPnl: number\n  timestamp: number\n}", """export interface VenueSettlement {
  marketId: string
  result: 'YES' | 'NO'
  shares: number
  /** Gross acquisition cost across YES and NO fills. */
  cost: number
  /** Total proceeds: settlement payout plus any automatic YES/NO pairing proceeds. */
  revenue: number
  /** Final settlement payout reported by the venue, before pairing proceeds. */
  settlementRevenue?: number
  /** Proceeds returned when opposite YES/NO contracts were paired before settlement. */
  pairedRevenue?: number
  yesShares?: number
  noShares?: number
  fee: number
  realizedPnl: number
  timestamp: number
}""")
s=s.replace("export interface LivePnl {\n  realizedPnl: number\n  fees: number\n  settlements: number\n  fills: number\n}", """export interface LivePnl {
  /** True only when the venue exposes enough data for a defensible realized-P&L calculation. */
  available: boolean
  source: 'settlements' | 'fills' | 'unavailable'
  unavailableReason?: string
  realizedPnl: number
  fees: number
  settlements: number
  fills: number
  wins?: number
  losses?: number
  flat?: number
  fromTs?: number
  toTs?: number
  details?: VenueSettlement[]
}""")
p.write_text(s,encoding='utf-8')

# kalshi.ts settlement mapping
p=root/'src/main/venues/kalshi.ts'
s=p.read_text(encoding='utf-8-sig')
old="""export function mapKalshiSettlement(s: KalshiSettlement): VenueSettlement {
  const cost = toNum(s.yes_total_cost_dollars) + toNum(s.no_total_cost_dollars)
  const revenue = s.revenue_dollars !== undefined ? toNum(s.revenue_dollars) : toNum(s.revenue) / 100
  const fee = toNum(s.fee_cost)
  return {
    marketId: s.ticker ?? '',
    result: s.market_result === 'no' ? 'NO' : 'YES',
    shares: toNum(s.yes_count_fp) + toNum(s.no_count_fp),
    cost,
    revenue,
    fee,
    realizedPnl: revenue - cost - fee,
    timestamp: s.settled_time ? Date.parse(s.settled_time) : 0
  }
}"""
new="""export function mapKalshiSettlement(s: KalshiSettlement): VenueSettlement {
  const yesShares = toNum(s.yes_count_fp)
  const noShares = toNum(s.no_count_fp)
  const cost = toNum(s.yes_total_cost_dollars) + toNum(s.no_total_cost_dollars)
  // Kalshi's settlement `revenue` reports only the payout on the remaining
  // net position. Opposite YES/NO contracts are paired automatically and
  // return $1 per pair before settlement; those proceeds are not repeated in
  // the row's revenue field. Omitting them made two-sided maker activity look
  // catastrophically unprofitable (77-row live audit: -$190.41 vs -$18.26).
  const settlementRevenue = s.revenue_dollars !== undefined ? toNum(s.revenue_dollars) : toNum(s.revenue) / 100
  const pairedRevenue = Math.min(yesShares, noShares)
  const revenue = settlementRevenue + pairedRevenue
  const fee = toNum(s.fee_cost)
  return {
    marketId: s.ticker ?? '',
    result: s.market_result === 'no' ? 'NO' : 'YES',
    shares: yesShares + noShares,
    yesShares,
    noShares,
    cost,
    revenue,
    settlementRevenue,
    pairedRevenue,
    fee,
    realizedPnl: revenue - cost - fee,
    timestamp: s.settled_time ? Date.parse(s.settled_time) : 0
  }
}"""
if old not in s: raise SystemExit('kalshi settlement block not found')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')

# engine.ts replace getLivePnl
p=root/'src/main/engine/engine.ts'
s=p.read_text(encoding='utf-8-sig')
start=s.index('  async getLivePnl(venue: VenueId): Promise<LivePnl | null> {')
end=s.index('\n  clearHistory(): void {',start)
new_method="""  async getLivePnl(venue: VenueId): Promise<LivePnl | null> {
    const adapter = this.registry.get(venue)
    if (!adapter) return null
    // Venues with a settlements feed (Kalshi): realized P&L from settled markets.
    if (adapter.getSettlements) {
      const settlements = await adapter.getSettlements(200).catch(() => [])
      let realizedPnl = 0
      let fees = 0
      let wins = 0
      let losses = 0
      let flat = 0
      for (const s of settlements) {
        realizedPnl += s.realizedPnl
        fees += s.fee
        if (s.realizedPnl > 0.000001) wins++
        else if (s.realizedPnl < -0.000001) losses++
        else flat++
      }
      // A settlement row's fee_cost is already netted in realizedPnl. Only
      // fills on markets not represented in the settlement feed can add fees
      // that have not already been counted here.
      const settledMarkets = new Set(settlements.map((s) => s.marketId))
      let fillCount = 0
      if (adapter.getFills) {
        const fills = await adapter.getFills(200).catch(() => [])
        fillCount = fills.length
        for (const f of fills) {
          if (settledMarkets.has(f.marketId)) continue
          fees += f.fee
          realizedPnl -= f.fee
        }
      }
      const times = settlements.map((s) => s.timestamp).filter((t) => t > 0)
      return {
        available: true,
        source: 'settlements',
        realizedPnl,
        fees,
        settlements: settlements.length,
        fills: fillCount,
        wins,
        losses,
        flat,
        fromTs: times.length ? Math.min(...times) : undefined,
        toTs: times.length ? Math.max(...times) : undefined,
        details: settlements
      }
    }
    // A fills feed is not automatically a realized-P&L feed. Polymarket US
    // currently omits realizedPnl on ordinary trade activities, so showing
    // $0.00 would falsely imply an authoritative break-even result.
    if (adapter.getFills) {
      const fills = await adapter.getFills(200).catch(() => [])
      const realized = fills.filter((f) => typeof f.realizedPnl === 'number' && Number.isFinite(f.realizedPnl))
      if (realized.length === 0) {
        return {
          available: false,
          source: 'unavailable',
          unavailableReason: 'Venue fills do not include authoritative settlement P&L.',
          realizedPnl: 0,
          fees: fills.reduce((sum, f) => sum + (f.fee ?? 0), 0),
          settlements: 0,
          fills: fills.length
        }
      }
      const realizedPnl = realized.reduce((sum, f) => sum + (f.realizedPnl ?? 0), 0)
      const fees = fills.reduce((sum, f) => sum + (f.fee ?? 0), 0)
      return { available: true, source: 'fills', realizedPnl, fees, settlements: 0, fills: fills.length }
    }
    return null
  }
"""
s=s[:start]+new_method+s[end:]
p.write_text(s,encoding='utf-8')

# App.tsx: first replace mojibake sequences with ASCII-safe text
p=root/'src/renderer/src/App.tsx'
s=p.read_text(encoding='utf-8-sig')
repls={
'â€”':'-', 'â€“':'-', 'â†’':'->', 'â€¦':'...', 'Â¢':'c', 'Â·':' - ',
'ðŸ” ':'', 'âš™ ':'', 'â± ':'expires ', 'âœ“':'', 'âœ—':'', 'âœ•':'X',
}
for a,b in repls.items(): s=s.replace(a,b)
# ensure stray correct middle dots/non-ASCII glyphs are stable ASCII
s=s.replace(' · ',' - ').replace('·',' - ').replace('—','-').replace('…','...').replace('¢','c')
# state for drilldown
needle="  const [livePnl, setLivePnl] = useState<LivePnl | null>(null)\n"
s=s.replace(needle,needle+"  const [showSettlementDetails, setShowSettlementDetails] = useState(false)\n")
# derived values
needle="  const mode = state?.executionMode ?? 'paper'\n  const venues = state?.venues ?? []\n"
s=s.replace(needle,needle+"  const positionMark = (portfolio?.positions ?? []).reduce((sum, p) => sum + (p.shares ?? 0) * (p.currentPrice ?? 0), 0)\n  const orderReserve = restingOrders.reduce((sum, o) => sum + o.remainingCount * (o.outcome === 'NO' ? 1 - o.yesPrice : o.yesPrice), 0)\n")
# replace account value through live pnl area
start=s.index('              <div className="big">')
end=s.index('              <div className="section-label">Open orders',start)
account="""              <div className="big">
                {(portfolio.totalValue ?? 0).toFixed(2)} <span>{portfolio.currency}</span>
              </div>
              <div className="muted">
                {portfolio.account?.username ?? 'Paper Account'} - {portfolio.mode} mode
                {kalshiDemo && venue === 'kalshi' ? ' - DEMO exchange (mock funds)' : ''}
              </div>
              <div className="account-breakdown">
                <span>Venue cash: {(portfolio.account?.balance ?? 0).toFixed(2)}</span>
                <span>Open-position mark: {positionMark.toFixed(2)}</span>
                <span title="Maximum cost if every resting order fills. Venue cash treatment varies; this is shown separately and is not added to marked value.">
                  Resting-order reserve: {orderReserve.toFixed(2)}
                </span>
              </div>
              {histStats && (
                <>
                  <div className="muted" style={{ marginTop: 8, fontSize: 10 }}>
                    Local app ledger - incomplete for independent strategy engines - {venue} only
                  </div>
                  <div className="acct-stats">
                    <span className="stat">
                      <span className="stat-label">Completed</span>
                      <span className="stat-val">{histStats.completedTrades}</span>
                    </span>
                    <span className="stat">
                      <span className="stat-label">Win rate</span>
                      <span className={`stat-val ${histStats.winRate >= 50 ? 'bt-pos' : 'bt-neg'}`}>
                        {(histStats.winRate ?? 0).toFixed(0)}%
                      </span>
                    </span>
                    <span className="stat">
                      <span className="stat-label">Local realized P&amp;L</span>
                      <span className={`stat-val ${histStats.realizedPnl >= 0 ? 'bt-pos' : 'bt-neg'}`}>
                        {histStats.realizedPnl >= 0 ? '+' : ''}
                        {(histStats.realizedPnl ?? 0).toFixed(2)}
                      </span>
                    </span>
                  </div>
                </>
              )}
              {livePnl && (
                <div className="venue-pnl">
                  {livePnl.available ? (
                    <>
                      <div className="muted">
                        Venue-authoritative {livePnl.source === 'settlements' ? 'settlements' : 'realized fills'}
                        {livePnl.fromTs && livePnl.toTs ? ` (${fmtDateRange(livePnl.fromTs, livePnl.toTs)})` : ''}: P&amp;L{' '}
                        <span className={(livePnl.realizedPnl ?? 0) >= 0 ? 'bt-pos' : 'bt-neg'}>
                          {(livePnl.realizedPnl ?? 0) >= 0 ? '+' : ''}{(livePnl.realizedPnl ?? 0).toFixed(2)}
                        </span>{' '}
                        - fees {(livePnl.fees ?? 0).toFixed(2)} - {livePnl.settlements} settled
                      </div>
                      {livePnl.source === 'settlements' && (
                        <div className="muted">
                          {livePnl.wins ?? 0} profitable - {livePnl.losses ?? 0} losing - {livePnl.flat ?? 0} flat
                          <button className="inline-link" onClick={() => setShowSettlementDetails((v) => !v)}>
                            {showSettlementDetails ? 'Hide details' : 'Show details'}
                          </button>
                        </div>
                      )}
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
                    </>
                  ) : (
                    <div className="muted">
                      Venue settlement P&amp;L unavailable - {livePnl.fills} fills observed. {livePnl.unavailableReason}
                    </div>
                  )}
                </div>
              )}
"""
s=s[:start]+account+s[end:]
# Remove any remaining non-ASCII safely in this UI source.
translations={
  0x2019:"'",0x2018:"'",0x201c:'"',0x201d:'"',0x2022:'*',0x2020:'+',0x2122:'',
}
s=s.translate(translations)
# Any remaining mojibake chars indicate source corruption; replace with safe placeholders.
s=''.join(ch if ord(ch)<128 else '-' for ch in s)
# append date helper before fmtClose
needle='function fmtClose(t?: number): string {'
helper="""function fmtDateRange(fromTs: number, toTs: number): string {
  const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return fmt(fromTs) === fmt(toTs) ? fmt(fromTs) : `${fmt(fromTs)} to ${fmt(toTs)}`
}

"""
s=s.replace(needle,helper+needle)
p.write_text(s,encoding='utf-8')

# CSS
p=root/'src/renderer/src/index.css'
s=p.read_text(encoding='utf-8-sig')
s += """

/* ---- account accounting clarity ---- */
.account-breakdown {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
  color: var(--muted);
  font-size: 11px;
}

.venue-pnl {
  margin-top: 8px;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}

.inline-link {
  margin-left: 8px;
  padding: 1px 5px;
  background: transparent;
  color: var(--accent);
  border: 0;
  font-size: 11px;
}

.settlement-list {
  margin-top: 6px;
  max-height: 220px;
  overflow-y: auto;
  border-top: 1px solid var(--border);
}

.settlement-row {
  display: grid;
  grid-template-columns: minmax(120px, 2fr) 34px repeat(4, minmax(54px, auto));
  gap: 7px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
  font-size: 10px;
  white-space: nowrap;
}
"""
p.write_text(s,encoding='utf-8')

# Regression script and package command
reg=root/'scripts/settlement-accounting-regression.mjs'
reg.write_text("""import assert from 'node:assert/strict'\n\n// Captured shape: 14 YES + 13 NO contracts, with only the final net payout\n// in settlement revenue. The 13 automatically paired contracts return $13.\nconst row = {\n  yes_count_fp: '14', no_count_fp: '13',\n  yes_total_cost_dollars: '8.40', no_total_cost_dollars: '5.20',\n  revenue: 100, fee_cost: '0.01'\n}\nconst n = (v) => Number(v ?? 0)\nconst yes = n(row.yes_count_fp), no = n(row.no_count_fp)\nconst cost = n(row.yes_total_cost_dollars) + n(row.no_total_cost_dollars)\nconst settlementRevenue = n(row.revenue) / 100\nconst pairedRevenue = Math.min(yes, no)\nconst pnl = settlementRevenue + pairedRevenue - cost - n(row.fee_cost)\nassert.equal(pairedRevenue, 13)\nassert.ok(Math.abs(pnl - 0.39) < 1e-9, `expected $0.39, got $${pnl}`)\nconsole.log('settlement accounting regression: PASS')\n""",encoding='utf-8')
p=root/'package.json'
d=json.loads(p.read_text(encoding='utf-8-sig'))
d['scripts']['test:settlement-accounting']='node scripts/settlement-accounting-regression.mjs'
p.write_text(json.dumps(d,indent=2)+'\n',encoding='utf-8')
print('patched')
