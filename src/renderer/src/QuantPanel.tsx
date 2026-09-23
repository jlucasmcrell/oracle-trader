import { useEffect, useState } from 'react'
import type { QuantStatus } from '../../shared/ipc'

interface Props {
  onClose: () => void
}

export default function QuantPanel({ onClose }: Props) {
  const [status, setStatus] = useState<QuantStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    try {
      const s = await window.api.quant.getStatus()
      setStatus(s)
    } catch (e) {
      console.error('Failed to get quant status:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal quant-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '92vw',
          maxWidth: 1200,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          background: '#0f1117',
          color: '#e2e8f0',
          border: '1px solid #2d3748',
          borderRadius: 12,
          padding: 24,
          overflowY: 'auto'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 20, color: '#60a5fa', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span></span> Institutional Quant Alpha Hub
            </h2>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 4,
                background: '#1e293b',
                color: '#94a3b8',
                border: '1px solid #334155'
              }}
            >
              Auto-refresh 3s
            </span>
          </div>
          <button
            className="ghost"
            onClick={onClose}
            style={{ fontSize: 18, padding: '4px 12px', cursor: 'pointer', color: '#94a3b8' }}
          >
            
          </button>
        </div>

        {loading && !status ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>Loading live engine feeds...</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(540px, 1fr))', gap: 16 }}>
            {/* 1. Lead-Lag Latency Monitor */}
            <div
              style={{
                background: '#131824',
                border: '1px solid #1e293b',
                borderRadius: 8,
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 12
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: 15, color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span></span> Cross-Venue Lead-Lag Sweeper
                </h3>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: status?.leadLag.active ? '#064e3b' : '#334155',
                    color: status?.leadLag.active ? '#34d399' : '#94a3b8'
                  }}
                >
                  {status?.leadLag.active ? 'ACTIVE' : 'IDLE'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>{status?.leadLag.note}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div style={{ background: '#0b0f19', padding: '10px 12px', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Dislocations Logged</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#f8fafc' }}>
                    {status?.leadLag.dislocationsLogged ?? 0}
                  </div>
                </div>
                <div style={{ background: '#0b0f19', padding: '10px 12px', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>IOC Trades Executed</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#f8fafc' }}>
                    {status?.leadLag.tradesExecuted ?? 0}
                  </div>
                </div>
              </div>
              {status?.leadLag.lastDislocation ? (
                <div style={{ background: '#0b0f19', border: '1px solid #1e293b', padding: 12, borderRadius: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, color: '#38bdf8' }}>
                      {status.leadLag.lastDislocation.underlying}
                    </span>
                    <span style={{ color: '#eab308', fontWeight: 600 }}>
                      +{status.leadLag.lastDislocation.dislocationCents.toFixed(1)} Lead
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 12 }}>
                    <span>Poly: {(status.leadLag.lastDislocation.polyPrice * 100).toFixed(0)}</span>
                    <span>Kalshi: {(status.leadLag.lastDislocation.kalshiPrice * 100).toFixed(0)}</span>
                    <span style={{ color: '#34d399' }}>Action: {status.leadLag.lastDislocation.suggestedAction}</span>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#64748b', fontStyle: 'italic' }}>
                  Monitoring Polymarket CLOB vs Kalshi for probability lags &gt; 3...
                </div>
              )}
            </div>

            {/* 2. T-5m Crypto Convergence Radar */}
            <div
              style={{
                background: '#131824',
                border: '1px solid #1e293b',
                borderRadius: 8,
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 12
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: 15, color: '#a78bfa', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span></span> T-5m Spot Convergence Engine
                </h3>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: status?.convergence.active ? '#064e3b' : '#334155',
                    color: status?.convergence.active ? '#34d399' : '#94a3b8'
                  }}
                >
                  {status?.convergence.active ? 'ACTIVE' : 'IDLE'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>{status?.convergence.note}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                <div style={{ background: '#0b0f19', padding: '10px 12px', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Trades / Wins</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc' }}>
                    {status?.convergence.gradedTrades ?? 0} / {status?.convergence.wins ?? 0}
                    <div style={{ fontSize: 10, color: '#64748b' }}>{status?.convergence.fills ?? 0} fills / {status?.convergence.attempts ?? 0} attempts / {status?.convergence.noFills ?? 0} no-fills</div>
                  </div>
                </div>
                <div style={{ background: '#0b0f19', padding: '10px 12px', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Losses / Adverse</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#f87171' }}>
                    {status?.convergence.losses ?? 0}
                  </div>
                </div>
                <div style={{ background: '#0b0f19', padding: '10px 12px', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Realized Edge</div>
                  <div
                    style={{
                      fontSize: 16,
                      fontWeight: 700,
                      color: (status?.convergence.realizedPnlCents ?? 0) >= 0 ? '#34d399' : '#f87171'
                    }}
                  >
                    {(status?.convergence.realizedPnlCents ?? 0) >= 0 ? '+' : ''}
                    {(status?.convergence.realizedPnlCents ?? 0).toFixed(1)}
                  </div>
                </div>
              </div>
              <div style={{ background: '#0b0f19', padding: 10, borderRadius: 6, fontSize: 11, color: '#94a3b8' }}>
                <span style={{ color: '#a78bfa', fontWeight: 600 }}>Live Coinbase Feeds: </span>
                {status?.convergence.lastSpot && Object.keys(status.convergence.lastSpot).length > 0
                  ? Object.entries(status.convergence.lastSpot)
                      .map(([coin, px]) => `${coin}: $${(px ?? 0).toLocaleString()}`)
                      .join(' | ')
                  : 'Connecting to feeds...'}
              </div>
            </div>

            {/* 3. Combinatorial Dutch Book Arbitrageur */}
            <div
              style={{
                background: '#131824',
                border: '1px solid #1e293b',
                borderRadius: 8,
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 12
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: 15, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span></span> Multi-Outcome Dutch-Book Arb
                </h3>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: status?.dutch.active ? '#064e3b' : '#334155',
                    color: status?.dutch.active ? '#34d399' : '#94a3b8'
                  }}
                >
                  {status?.dutch.active ? 'ACTIVE' : 'IDLE'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>{status?.dutch.note}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                <div style={{ background: '#0b0f19', padding: '10px 12px', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Events Scanned</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc' }}>
                    {status?.dutch.scannedEvents ?? 0}
                  </div>
                </div>
                <div style={{ background: '#0b0f19', padding: '10px 12px', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Arb Slates Found</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#34d399' }}>
                    {status?.dutch.opportunitiesFound ?? 0}
                  </div>
                </div>
                <div style={{ background: '#0b0f19', padding: '10px 12px', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Baskets Executed</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc' }}>
                    {status?.dutch.executedBaskets ?? 0}
                  </div>
                </div>
              </div>
              {status?.dutch.lastOpportunity ? (
                <div style={{ background: '#0b0f19', border: '1px solid #1e293b', padding: 12, borderRadius: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, color: '#f59e0b' }}>
                      {status.dutch.lastOpportunity.title}
                    </span>
                    <span style={{ color: '#34d399', fontWeight: 600 }}>
                      +{status.dutch.lastOpportunity.netEdgeCents.toFixed(1)} Yield
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>
                    {status.dutch.lastOpportunity.numLegs} legs | Sum Ask: ${(status.dutch.lastOpportunity.sumPrice / 100).toFixed(2)} | Fee: {status.dutch.lastOpportunity.feeCents.toFixed(1)}
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#64748b', fontStyle: 'italic' }}>
                  Scanning 4,000+ Kalshi events for sum(asks) + fees &lt; $1.00 risk-free baskets...
                </div>
              )}
            </div>

            {/* 4. Avellaneda-Stoikov Market Maker Matrix */}
            <div
              style={{
                background: '#131824',
                border: '1px solid #1e293b',
                borderRadius: 8,
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 12
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: 15, color: '#34d399', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span></span> Avellaneda-Stoikov (AS) Quoter Matrix
                </h3>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: status?.quoter.active ? '#064e3b' : '#334155',
                    color: status?.quoter.active ? '#34d399' : '#94a3b8'
                  }}
                >
                  {status?.quoter.active ? '0% FEE MAKER' : 'IDLE'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>{status?.quoter.note}</div>
              {(status?.quoter.lossLockBlocks?.length ?? 0) > 0 && (
                <div style={{ background: '#451a03', border: '1px solid #b45309', color: '#fdba74', padding: '9px 11px', borderRadius: 6, fontSize: 11 }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>Loss-locking complement blocked</div>
                  {status!.quoter.lossLockBlocks.slice(0, 4).map((warning) => <div key={warning}>{warning}</div>)}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                <div style={{ background: '#0b0f19', padding: '8px 10px', borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: '#64748b' }}>Quoted Ladders</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#f8fafc' }}>
                    {status?.quoter.quoting ?? 0}
                  </div>
                </div>
                <div style={{ background: '#0b0f19', padding: '8px 10px', borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: '#64748b' }}>Resting Quotes</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#38bdf8' }}>
                    {status?.quoter.resting ?? 0}
                  </div>
                </div>
                <div style={{ background: '#0b0f19', padding: '8px 10px', borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: '#64748b' }}>Live Exposure</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#f59e0b' }}>
                    ${(status?.quoter.exposure ?? 0).toFixed(2)}
                    <div style={{ fontSize: 10, color: '#64748b' }}>active pos ${(status?.quoter.positionExposure ?? 0).toFixed(2)} + rest ${(status?.quoter.restingExposure ?? 0).toFixed(2)} / cap ${(status?.quoter.totalExposureCap ?? 0).toFixed(2)}</div>
                    <div style={{ fontSize: 10, color: '#64748b' }}>all venue weather cost ${(status?.quoter.accountingPositionExposure ?? 0).toFixed(2)} (includes settlement-pending)</div>
                  </div>
                </div>
                <div style={{ background: '#0b0f19', padding: '8px 10px', borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: '#64748b' }}>Fills Captured</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#34d399' }}>
                    {status?.quoter.filled ?? 0}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', background: '#0b0f19', padding: 8, borderRadius: 6 }}>
                Dynamic Reservation Skew: <code style={{ color: '#34d399' }}>r(p,q,) = (d2)  q2</code> | Capturing 1 inside touch at 0.00% maker fee drag.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
