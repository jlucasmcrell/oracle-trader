import { useCallback, useEffect, useState } from 'react'
import type { MiniAutoConfig, MiniStatus } from '../../shared/ipc'
import type { VenueId } from '../../shared/types'

interface Props {
  log: (line: string) => void
  onChanged: () => void
  /** Driven by the header venue tabs - the panel no longer has its own selector. */
  venue: VenueId
}

export default function MiniAutoPanel({ log, onChanged, venue }: Props) {
  const [cfg, setCfg] = useState<MiniAutoConfig | null>(null)
  const [status, setStatus] = useState<MiniStatus | null>(null)
  const [busy, setBusy] = useState(false)
  /** Market slug for the no-money order preview (paste from the Event Scanner). */
  const [previewSlug, setPreviewSlug] = useState('')

  const load = useCallback(async (v: VenueId) => {
    try {
      const [c, s] = await Promise.all([window.api.autoMini.getConfig(v), window.api.autoMini.getStatus(v)])
      setCfg(c)
      setStatus(s)
    } catch (err) {
      setCfg(null)
      setStatus(null)
      log(`Mini auto-trader load failed: ${String(err)}`)
    }
  }, [log])

  useEffect(() => {
    load(venue)
    const t = setInterval(() => load(venue), 10_000)
    return () => clearInterval(t)
  }, [load, venue])

  // Only the changed keys (audit 2026-09-19, B-08): setConfig merges, and a stale full copy reverted ladder writes.
  const patch = async (p: Partial<MiniAutoConfig>) => {
    if (!cfg) return
    const next = await window.api.autoMini.setConfig(venue, p)
    setCfg(next)
    await load(venue)
  }

  const scan = async () => {
    setBusy(true)
    try {
      const res = await window.api.autoMini.scan(venue)
      log(`Mini ${venue}: ${res.scanned} seen, ${res.candidates} candidates, ${res.executed} executed${res.errors.length ? `, ${res.errors.length} errors` : ''}`)
      await load(venue)
      onChanged()
    } catch (err) {
      log(`Mini scan failed: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    await window.api.autoMini.reset(venue)
    log(`Mini ${venue} state reset`)
    await load(venue)
    onChanged()
  }

  const closeTrade = async (marketId: string, outcome: string) => {
    try {
      await window.api.engine.sellPosition({ venue, marketId, outcome })
      log(`Mini ${venue}: manually closed ${outcome} on ${marketId.slice(0, 24)}...`)
      await load(venue)
      onChanged()
    } catch (err) {
      log(`Close failed: ${String(err)}`)
    }
  }

  return (
    <div className="auto">
      {!cfg || !status ? (
        <div className="muted">Loading...</div>
      ) : (
        <>
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={cfg.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
              Enabled
            </label>
            <label className="check">
              <input type="checkbox" checked={cfg.autoPoll} onChange={(e) => patch({ autoPoll: e.target.checked })} />
              Auto-poll
            </label>
            <label className="inline">
              every
              <input type="number" min={15} value={cfg.pollIntervalSeconds} onChange={(e) => patch({ pollIntervalSeconds: Number(e.target.value) })} />
              s
            </label>
            <label className="check">
              <input type="checkbox" checked={cfg.dryRun} onChange={(e) => patch({ dryRun: e.target.checked })} />
              Dry run
            </label>
            {venue === 'polymarket-us' && (
              <input
                value={previewSlug}
                onChange={(e) => setPreviewSlug(e.target.value)}
                placeholder="market slug for preview (paste from scanner)"
                style={{ minWidth: 260 }}
              />
            )}
            {venue === 'polymarket-us' && (
              <button
                className="ghost"
                disabled={busy || previewSlug.trim() === ''}
                title="Sends the exact maker payload to POST /v1/order/preview with your real keys. The venue validates it and returns the calculated order. NOTHING is placed."
                onClick={async () => {
                  const slug = previewSlug.trim()
                  if (!slug) return
                  setBusy(true)
                  try {
                    const res = await window.api.autoMini.preview(venue, {
                      venue,
                      marketId: slug,
                      outcome: 'NO',
                      amount: cfg.amountPerTrade,
                      limitPrice: 0.05,
                      timeInForce: 'good_till_canceled',
                      postOnly: true
                    })
                    log(`PREVIEW (no money) NO @ YES 0.05 on ${slug.slice(0, 40)}: ${JSON.stringify(res).slice(0, 400)}`)
                  } catch (err) {
                    log(`PREVIEW failed: ${err instanceof Error ? err.message : String(err)}`)
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Preview order (no money)
              </button>
            )}
            <label className="check" title="Live orders only when global mode is Live AND this is armed.">
              <input
                type="checkbox"
                checked={cfg.liveArmed}
                onChange={(e) => {
                  if (e.target.checked && !window.confirm('Arm LIVE trading for this venue? When the global mode is Live, this places REAL-MONEY orders.')) return
                  patch({ liveArmed: e.target.checked })
                }}
              />
              Arm LIVE
            </label>
            <span className="badge" data-on={status.running}>
              {status.running ? 'RUNNING' : 'IDLE'}
            </span>
            <span className="badge warn">{cfg.dryRun ? 'DRY RUN' : 'CAN ORDER'}</span>
            <span className="badge" data-on={cfg.liveArmed}>
              {cfg.liveArmed ? 'LIVE ARMED' : 'LIVE SAFE'}
            </span>
          </div>

          <div className="booklab perf">
            <span className="booklab-title"> TEST RECORD</span>
            {status.perfByStrategy && Object.keys(status.perfByStrategy).length > 0 ? (
              <div className="muted">
                by strategy:{' '}
                {Object.entries(status.perfByStrategy).map(([k, v]) => `${k} ${v.wins}W/${v.losses}L ${v.realizedPnl >= 0 ? '+' : ''}${v.realizedPnl.toFixed(2)}`).join(' - ')}
              </div>
            ) : null}
            {status.perf && status.perf.trades > 0 ? (
              <span className="booklab-nums">
                {status.perf.trades} closed - {status.perf.wins}W / {status.perf.losses}L - win{' '}
                {((status.perf.winRate ?? 0) * 100).toFixed(0)}% - net{' '}
                <span className={(status.perf.realizedPnl ?? 0) >= 0 ? 'bt-pos' : 'bt-neg'}>
                  {(status.perf.realizedPnl ?? 0) >= 0 ? '+' : ''}
                  {(status.perf.realizedPnl ?? 0).toFixed(2)}
                </span>
              </span>
            ) : (
              <span className="muted">no closed trades yet</span>
            )}
            <span className="muted">USD - paper or live, whichever the mode was</span>
          </div>

          <div className="row">
            <label className="check">
              <input type="checkbox" checked={cfg.fadeEnabled} onChange={(e) => patch({ fadeEnabled: e.target.checked })} />
              Longshot fade (buy NO)
            </label>
            <label className="inline">
              p &lt;=
              <input type="number" min={0.03} max={0.2} step={0.01} value={cfg.fadeMaxPrice} onChange={(e) => patch({ fadeMaxPrice: Number(e.target.value) })} />
            </label>
            <label className="inline">
              p &gt;=
              <input type="number" min={0.01} max={0.1} step={0.01} value={cfg.fadeMinPrice} onChange={(e) => patch({ fadeMinPrice: Number(e.target.value) })} />
            </label>
            <label className="check" title="Also buy YES on favorites at the mirror band (90-97%).">
              <input type="checkbox" checked={cfg.fadeFavoritesEnabled} onChange={(e) => patch({ fadeFavoritesEnabled: e.target.checked })} />
              favorites
            </label>
            {venue === 'polymarket-us' && (
              <>
                <label className="check" title="One-contract passive maker research. Stable hash assigns YES/NO; fills hold to settlement.">
                  <input type="checkbox" checked={cfg.microMakerEnabled} onChange={(e) => patch({ microMakerEnabled: e.target.checked })} />
                  Micro maker
                </label>
                <label className="inline">maker markets
                  <input type="number" min={1} max={5} value={cfg.microMakerMaxMarkets} onChange={(e) => patch({ microMakerMaxMarkets: Number(e.target.value) })} />
                </label>
                <label className="inline">maker spread c
                  <input type="number" min={0.1} step={0.1} value={cfg.microMakerMinSpreadCents} onChange={(e) => patch({ microMakerMinSpreadCents: Number(e.target.value) })} />
                  -
                  <input type="number" min={0.2} step={0.5} value={cfg.microMakerMaxSpreadCents} onChange={(e) => patch({ microMakerMaxSpreadCents: Number(e.target.value) })} />
                </label>
                <label
                  className="inline"
                  title="LIVE entry style. Maker rests a post-only limit inside the spread - the maker fee here is a REBATE. Taker crosses immediately. Paper always simulates taker."
                >
                  entry
                  <select value={cfg.fadeEntryMode} onChange={(e) => patch({ fadeEntryMode: e.target.value as 'taker' | 'maker' })}>
                    <option value="maker">maker (rest)</option>
                    <option value="taker">taker (cross)</option>
                  </select>
                </label>
                <label className="inline" title="Fade requires a two-sided book at most this wide.">
                  spread &lt;= c
                  <input type="number" min={1} step={1} value={cfg.fadeMaxSpreadCents} onChange={(e) => patch({ fadeMaxSpreadCents: Number(e.target.value) })} />
                </label>
                <label className="inline" title="Minimum top-3 dollar depth on BOTH sides of the book.">
                  side $ &gt;=
                  <input type="number" min={0} step={10} value={cfg.fadeMinSideDollars} onChange={(e) => patch({ fadeMinSideDollars: Number(e.target.value) })} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={cfg.bookEnabled} onChange={(e) => patch({ bookEnabled: e.target.checked })} />
                  Book imbalance
                </label>
              </>
            )}
            <label
              className="check"
              title="OFF (default) = fades hold to settlement, which the evidence favours: settlement is free while a round trip costs half a spread plus a fee, and exiting early only wins if the pre-close price overstates the favourite - the opposite of the entry signal. ON = apply TP/SL and the pre-close exit. Manifold defaults ON because its markets are creator-resolved."
            >
              <input type="checkbox" checked={cfg.fadeExitEnabled} onChange={(e) => patch({ fadeExitEnabled: e.target.checked })} />
              exit fades early
            </label>
            <label className="inline" title="Hard ceiling per trade. The equity % below usually binds first - leave this high unless you want a fixed cap.">
              Stake
              <input type="number" min={0.5} step={0.5} value={cfg.amountPerTrade} onChange={(e) => patch({ amountPerTrade: Number(e.target.value) })} />
            </label>
            <label className="inline" title="Stake as a % of account EQUITY (cash + open positions). 10% across 10 slots deploys the whole account; sizing off equity keeps bets stable instead of shrinking as cash is spent.">
              bal &lt;= %
              <input type="number" min={0} max={100} value={cfg.maxBalancePct} onChange={(e) => patch({ maxBalancePct: Number(e.target.value) })} />
            </label>
            <label className="inline">
              Max open
              <input type="number" min={1} value={cfg.maxOpenPositions} onChange={(e) => patch({ maxOpenPositions: Number(e.target.value) })} />
            </label>
            <label className="inline">
              Daily cap
              <input type="number" min={1} value={cfg.maxDailyTrades} onChange={(e) => patch({ maxDailyTrades: Number(e.target.value) })} />
            </label>
            <label
              className="inline"
              title="How far out markets may expire. Anything above 24h admits LONG-HOLD positions - longer horizons are your explicit choice."
            >
              horizon
              <select
                value={[6, 12, 24, 48, 72].includes(cfg.maxHoursToClose) ? String(cfg.maxHoursToClose) : 'custom'}
                onChange={(e) => {
                  if (e.target.value === 'custom') return
                  patch({ maxHoursToClose: Number(e.target.value) })
                }}
              >
                <option value={6}>&lt;= 6h</option>
                <option value={12}>&lt;= 12h</option>
                <option value={24}>&lt;= 24h</option>
                <option value={48}>&lt;= 2 days</option>
                <option value={72}>&lt;= 3 days</option>
                {![6, 12, 24, 48, 72].includes(cfg.maxHoursToClose) && <option value="custom">custom ({cfg.maxHoursToClose}h)</option>}
              </select>
            </label>
            <label className="inline" title="Minimum minutes to expiry.">
              &gt;=
              <input type="number" min={15} value={cfg.minMinutesToClose} onChange={(e) => patch({ minMinutesToClose: Number(e.target.value) })} />
              m
            </label>
            {cfg.maxHoursToClose > 24 && <span className="badge warn">LONG HOLDS ON</span>}
            <label className="inline">
              TP %
              <input type="number" min={0} value={cfg.takeProfitPct} onChange={(e) => patch({ takeProfitPct: Number(e.target.value) })} />
            </label>
            <label className="inline">
              SL %
              <input type="number" min={0} value={cfg.stopLossPct} onChange={(e) => patch({ stopLossPct: Number(e.target.value) })} />
            </label>
            <span className="muted">fade buys NO on p {Math.round(cfg.fadeMinPrice * 100)}-{Math.round(cfg.fadeMaxPrice * 100)}%</span>
          </div>

          <div className="row">
            <button onClick={scan} disabled={busy}>
              {busy ? 'Scanning...' : 'Scan now'}
            </button>
            <button className="ghost" onClick={reset}>
              Reset
            </button>
            <span className="muted stats">
              {status.scans} scans - {status.dailyTrades} today - {status.executed} executed
              {status.lastScanMs !== undefined ? ` - ${status.lastScanMs}ms/scan` : ''}
              {status.lastError ? ` - WARNING ${status.lastError}` : ''}
            </span>
          </div>

          {(status.pendingOrders?.length ?? 0) > 0 && (
            <>
              <div className="section-label">Resting maker orders</div>
              <ul className="at-table">
                {status.pendingOrders!.map((p) => (
                  <li key={p.orderId}>
                    <span className="at-strat">{p.strategy}</span>
                    <span className="at-outcome">{p.outcome}</span>
                    <span className="at-q" title={p.question ?? p.marketId}>
                      {(p.question ?? p.marketId).slice(0, 44)}
                    </span>
                    <span className="at-num">
                      {p.outcome === 'NO' ? 'NO' : 'YES'} @ {((p.outcome === 'NO' ? 1 - p.yesPrice : p.yesPrice) * 100).toFixed(1)}c
                    </span>
                    <span className="muted">expires {new Date(p.expirationTs * 1000).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {status.openTrades.length > 0 && (
            <>
              <div className="section-label">Open trades</div>
              <ul className="at-table">
                {status.openTrades.map((t) => (
                  <li key={t.id}>
                    <span className="at-strat">{t.strategy}</span>
                    <span className="at-outcome">{t.outcome}</span>
                    <span className="at-q" title={t.question ?? t.marketId}>
                      {(t.question ?? t.marketId).slice(0, 48)}
                    </span>
                    <span className="at-num" title="Stake committed to this position">
                      {(t.amount ?? 0).toFixed(2)}
                    </span>
                    <span className="at-num">{(t.shares ?? 0).toFixed(2)} sh</span>
                    <span className="at-num">@ {((t.entryPrice ?? 0) * 100).toFixed(0)}%</span>
                    {t.closeTime !== undefined && (
                      <span className="muted">closes {new Date(t.closeTime).toLocaleDateString()}</span>
                    )}
                    <button className="sell" onClick={() => closeTrade(t.marketId, t.outcome)}>
                      Close
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  )
}
