import { useCallback, useEffect, useState } from 'react'
import type { AutoStatus, AutoTraderConfig, AutoVetTest } from '../../shared/ipc'

interface Props {
  log: (line: string) => void
  onChanged: () => void
}

type Profile = 'conservative' | 'balanced' | 'aggressive'

const PRESETS: Record<Profile, Partial<AutoTraderConfig>> = {
  conservative: {
    amountPerTrade: 2,
    maxOpenPositions: 3,
    maxDailyTrades: 8,
    takeProfitPct: 4,
    stopLossPct: 8,
    minScore: 65,
    maxSpreadPct: 0.03,
    minLiquidity: 300,
    reversalExitPct: 0.05
  },
  balanced: {
    amountPerTrade: 5,
    maxOpenPositions: 6,
    maxDailyTrades: 20,
    takeProfitPct: 5,
    stopLossPct: 10,
    minScore: 55,
    maxSpreadPct: 0.04,
    minLiquidity: 150,
    reversalExitPct: 0.08
  },
  aggressive: {
    amountPerTrade: 10,
    maxOpenPositions: 10,
    maxDailyTrades: 40,
    takeProfitPct: 7,
    stopLossPct: 12,
    minScore: 48,
    maxSpreadPct: 0.05,
    minLiquidity: 100,
    reversalExitPct: 0.06
  }
}

/** Search-horizon presets: how far out a market may expire. >24h = long holds. */
const HORIZON_PRESETS: { minutes: number; label: string }[] = [
  { minutes: 120, label: '<= 2h' },
  { minutes: 360, label: '<= 6h' },
  { minutes: 720, label: '<= 12h' },
  { minutes: 1440, label: '<= 24h' },
  { minutes: 2880, label: '<= 2 days' },
  { minutes: 4320, label: '<= 3 days' }
]

const PROVIDERS: { name: string; baseUrl: string; model: string; needsKey: boolean }[] = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', needsKey: true },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', needsKey: true },
  { name: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1', needsKey: false }
]

export default function AutoTraderPanel({ log, onChanged }: Props) {
  const [cfg, setCfg] = useState<AutoTraderConfig | null>(null)
  // The day-loss field is committed on blur/Enter, not per keystroke: an intermediate digit ('1' on the way to
  // '10') was persisted and could trip the sticky daily kill switch mid-scan (audit 2026-09-19, B-29).
  const [lossDraft, setLossDraft] = useState<string | null>(null)
  const [status, setStatus] = useState<AutoStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile>('balanced')
  const [advanced, setAdvanced] = useState(false)
  const [vetTest, setVetTest] = useState<AutoVetTest | null>(null)
  const [testing, setTesting] = useState(false)

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([window.api.autoTrader.getConfig(), window.api.autoTrader.getStatus()])
      setCfg(c)
      setStatus(s)
      setLoadError(null)
    } catch (err) {
      setLoadError(String(err))
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [load])

  // Send ONLY the changed keys: setConfig merges. Spreading the panel's <=10 s-old copy over the top silently reverted
  // ladder stops and nightly-review applies that landed in between (audit 2026-09-19, B-08).
  const patch = async (p: Partial<AutoTraderConfig>) => {
    if (!cfg) return
    const next = await window.api.autoTrader.setConfig(p)
    setCfg(next)
    await load()
  }

  const applyPreset = async (p: Profile) => {
    setProfile(p)
    await patch(PRESETS[p])
    log(`AutoTrader profile -> ${p}`)
  }

  const scan = async () => {
    setBusy(true)
    try {
      const res = await window.api.autoTrader.scan()
      log(
        `AutoTrader scan: ${res.scanned} seen, ${res.candidates} candidates, ${res.approved} approved, ${res.executed} executed` +
          (res.errors.length ? `, ${res.errors.length} errors` : '')
      )
      await load()
      onChanged()
    } catch (err) {
      log(`AutoTrader scan failed: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    await window.api.autoTrader.reset()
    log('AutoTrader state reset')
    await load()
    onChanged()
  }

  const closeTrade = async (marketId: string, outcome: string) => {
    try {
      await window.api.engine.sellPosition({ venue: 'kalshi', marketId, outcome })
      log(`AutoTrader: manually closed ${outcome} on ${marketId.slice(0, 20)}...`)
      await load()
      onChanged()
    } catch (err) {
      log(`Close failed: ${String(err)}`)
    }
  }

  const testVet = async () => {
    setTesting(true)
    setVetTest(null)
    try {
      const res = await window.api.autoTrader.testVet()
      setVetTest(res)
      if (res.ok && res.verdict) {
        log(`AI test: ${res.verdict.approve ? 'APPROVE' : 'VETO'} ${res.verdict.direction} (${res.verdict.reason})`)
      } else {
        log(`AI test failed: ${res.error}`)
      }
    } catch (err) {
      setVetTest({ ok: false, error: String(err) })
    } finally {
      setTesting(false)
    }
  }

  if (!cfg || !status) {
    return (
      <div>
        {loadError && <div className="bt-error">Panel error: {loadError}</div>}
        <div className="muted">Loading...</div>
      </div>
    )
  }

  const num = (v: number) => (Number.isFinite(v) ? v : 0)

  return (
    <div className="auto">
      {loadError && <div className="bt-error">Panel error: {loadError}</div>}

      {/* Orders and positions FIRST, always rendered: the owner scrolled past six
          config blocks and could not find three resting orders. An empty state
          teaches where they will appear before any order exists. */}
      <div className="section-label">Resting maker orders ({status.pendingOrders?.length ?? 0})</div>
      <ul className="at-table">
        {(status.pendingOrders?.length ?? 0) === 0 && <li className="muted">None resting. Maker orders wait here for a counterparty.</li>}
        {(status.pendingOrders ?? []).map((p) => (
          <li key={p.orderId}>
            <span className="at-strat">{p.strategy}</span>
            <span className="at-outcome">{p.outcome}</span>
            <span className="at-q" title={p.question ?? p.marketId}>
              {(p.question ?? p.marketId).slice(0, 44)}
            </span>
            <span className="at-num">
              {p.outcome} @ {((p.outcome === 'NO' ? 1 - p.yesPrice : p.yesPrice) * 100).toFixed(0)}c
            </span>
            <span className="muted">expires {new Date(p.expirationTs * 1000).toLocaleTimeString()}</span>
          </li>
        ))}
      </ul>

      <div className="section-label">Open auto-trades ({status.openTrades.length})</div>
      <ul className="at-table">
        {status.openTrades.length === 0 && <li className="muted">No filled positions held by the trader.</li>}
        {status.openTrades.map((t) => (
          <li key={t.id}>
            <span className="at-strat">{t.strategy}</span>
            <span className="at-outcome">{t.outcome}</span>
            <span className="at-q" title={t.question ?? t.marketId}>
              {(t.question ?? t.marketId).slice(0, 44)}
            </span>
            <span className="at-num">{num(t.shares).toFixed(2)} sh</span>
            <span className="at-num">@ {(t.entryPrice * 100).toFixed(0)}%</span>
            {typeof t.pnlPct === 'number' && (
              <span className={t.pnlPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                {t.pnlPct >= 0 ? '+' : ''}
                {t.pnlPct.toFixed(1)}%
              </span>
            )}
            <button className="sell" onClick={() => closeTrade(t.marketId, t.outcome)}>
              Close
            </button>
          </li>
        ))}
      </ul>

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
          <input type="number" min={10} value={cfg.pollIntervalSeconds} onChange={(e) => patch({ pollIntervalSeconds: Number(e.target.value) })} />
          s
        </label>
        <label className="check">
          <input type="checkbox" checked={cfg.dryRun} onChange={(e) => patch({ dryRun: e.target.checked })} />
          Dry run (no orders)
        </label>
        <label className="check" title="REAL-MONEY switch: live orders only happen when the global mode is Live AND this is armed.">
          <input
            type="checkbox"
            checked={cfg.liveArmed}
            onChange={(e) => {
              if (e.target.checked && !window.confirm('Arm LIVE trading? When the global mode is Live, the auto-trader will place REAL-MONEY orders on Kalshi.')) {
                return
              }
              patch({ liveArmed: e.target.checked })
            }}
          />
          Arm LIVE
        </label>
        <label className="check" title="Graceful de-risk: stop opening NEW positions while exits, settlement, and resting-order management keep running. The middle setting between running and the kill switch.">
          <input type="checkbox" checked={cfg.stopEntry} onChange={(e) => patch({ stopEntry: e.target.checked })} />
          Stop entry
        </label>
        <span className="badge" data-on={status.running}>
          {status.running ? 'RUNNING' : 'IDLE'}
        </span>
        {cfg.stopEntry && (
          <span className="badge warn" title="New entries halted by choice; exits still managed.">
             NO NEW ENTRIES
          </span>
        )}
        <span className="badge warn">{cfg.dryRun ? 'DRY RUN' : 'CAN ORDER'}</span>
        <span className="badge" data-on={cfg.liveArmed}>
          {cfg.liveArmed ? 'LIVE ARMED' : 'LIVE SAFE'}
        </span>
        {status.killSwitchTripped && (
          <span className="badge warn" title="Daily loss limit hit - new entries halted and LIVE disarmed. Re-arm manually when ready.">
            STOP KILL SWITCH
          </span>
        )}
        {status.exchangePaused && (
          <span className="badge warn" title="Kalshi reports trading paused (weekly maintenance is Thursday 3-5 AM ET). Every engine holds until it resumes.">
            EXCHANGE PAUSED
          </span>
        )}
        <span
          className="muted"
          title="Today's realized P&L per the VENUE's settlement feed (covers the quoter, convergence, lead-lag and Dutch engines as well as this trader). In live mode the kill switch reads whichever ledger is worse."
        >
          venue day{' '}
          {status.venueDailyRealized === undefined ? 'n/a' : `${status.venueDailyRealized >= 0 ? '+' : ''}${status.venueDailyRealized.toFixed(2)}`}
          {status.venueDailySettlements !== undefined ? ` (${status.venueDailySettlements} settled)` : ''}
          {status.killSource ? ` - kill reads ${status.killSource}` : ''}
          {status.openDayMtm !== undefined && status.openDayMtm !== 0 ? ` - open today ${status.openDayMtm >= 0 ? '+' : ''}${status.openDayMtm.toFixed(2)}` : ''}
        </span>
      </div>

      {status.ladder && (
        <div className="booklab" title="Promotion ladder, evaluated hourly. trade-small: every tested strategy goes to a real-money micro test (one contract) as soon as the global arm and collateral allow. Live stages are judged on net profit after fees: hard stop at -$5 x size; every 20 settled trades a checkpoint scales the size up (x2, x4) when it makes money with 80% confidence, stops it when it loses with 80% confidence, else keeps testing; at 100 trades the sign of the net decides. Every strategy on Kalshi and Polymarket US is under it. After two stops the cool-down grows to 14 days, doubling per stop; nothing is dead for good. prove-first: shadow/paper until the gate passes.">
          <span className="booklab-title"> LADDER</span>
          <label title="trade-small: real-money micro tests without waiting for the gate (stop -$5 per strategy, gate required after 2 demotions). prove-first: shadow/paper until the pre-registered gate passes.">
            mode{' '}
            <select value={cfg.ladderMode ?? 'trade-small'} onChange={(e) => patch({ ladderMode: e.target.value as AutoTraderConfig['ladderMode'] })}>
              <option value="trade-small">trade-small</option>
              <option value="prove-first">prove-first</option>
            </select>
          </label>
          <label title="Dollars the ladder may move onto Kalshi shard 0 (weather) from another shard when it starts a weather micro test. 0 = never move collateral.">
            {' '}shard-0 top-up ${' '}
            <input type="number" min={0} step={1} style={{ width: 50 }} value={cfg.ladderAutoAllocateUsd ?? 20} onChange={(e) => patch({ ladderAutoAllocateUsd: Number(e.target.value) })} />
          </label>
          <span className="muted">
            {status.ladder.strategies.map((s) => `${s.id}: ${s.stage}${(s.notch ?? 1) > 1 ? ` x${s.notch}` : ''}${s.lastVerdict ? ` (${s.lastVerdict.slice(0, 70)})` : ''}`).join(' | ') || 'first evaluation pending'}
            {status.ladder.lastRunAt ? ` - evaluated ${new Date(status.ladder.lastRunAt).toLocaleTimeString()}` : ''}
          </span>
          {status.lastReview?.date && (
            <span className="muted" title={status.lastReview.error ? `review error: ${status.lastReview.error}` : status.lastReview.summary}>
              {' '}- nightly review {status.lastReview.date}
              {status.lastReview.error ? ' failed' : `: ${(status.lastReview.summary ?? '').slice(0, 120)} (${status.lastReview.applied ?? 0} applied, ${status.lastReview.skipped ?? 0} filed)`}
            </span>
          )}
        </div>
      )}

      <div className="booklab">
        <span className="booklab-title"> BOOK LAB</span>
        <span className="muted">order-book imbalance forward test - snapshots every minute - </span>
        {status.bookStats ? (
          <span className="booklab-nums">
            {status.bookStats.observations} obs - hit {((status.bookStats.hitRate ?? 0) * 100).toFixed(1)}% - mean{' '}
            {(status.bookStats.meanMoveCents ?? 0) >= 0 ? '+' : ''}
            {(status.bookStats.meanMoveCents ?? 0).toFixed(1)}c - {status.bookStats.yesSignals}Y/{status.bookStats.noSignals}N
          </span>
        ) : (
          <span className="muted">waiting for first snapshots...</span>
        )}
      </div>

      <div className="booklab perf">
        <span className="booklab-title"> TEST RECORD</span>
        {status.quoter ? (
          <div className="muted" title={status.quoter.lastError ? `last error: ${status.quoter.lastError}` : 'Thin-market quoter: post-only quotes one cent inside thin weather books; quotes only when armed'}>
            Thin quoter: {status.quoter.note} - resting {status.quoter.resting} - exposure ${status.quoter.exposure.toFixed(2)} - filled {status.quoter.filled}
            {status.quoter.ledgerFills !== undefined ? ` (venue-attributed ${status.quoter.ledgerFills})` : ''}
            {status.quoter.gates ? ` - gated: ratchet ${status.quoter.gates.ratchet} / blackout ${status.quoter.gates.blackout} / no-index ${status.quoter.gates.noIndex}` : ''}
            {status.quoter.shadow
              ? ` - shadow: ${status.quoter.shadow.quotes} would-quotes, ${status.quoter.shadow.proxyFills} proxy fills, 15-min markout ${status.quoter.shadow.markoutMeanCents >= 0 ? '+' : ''}${status.quoter.shadow.markoutMeanCents.toFixed(2)}c over ${status.quoter.shadow.markoutN}`
              : ''}
          </div>
        ) : null}
        {status.perf && status.perf.trades > 0 ? (
          <span className="booklab-nums">
            {status.perf.trades} closed - {status.perf.wins}W / {status.perf.losses}L - win rate{' '}
            {((status.perf.winRate ?? 0) * 100).toFixed(0)}%
            {(() => {
              // Win rate is the base-rate trap; this is the number that matters.
              const f = status.calib?.byStrategy?.['fade']
              return f && f.netCents !== undefined ? (
                <span title={`Mean net cents per contract after fees over ${f.netN} graded settlements (${f.netEvents} events, ${f.netDays} days). Event-clustered 95% interval.`}>
                  {' '} - <span className={f.netCents >= 0 ? 'bt-pos' : 'bt-neg'}>{f.netCents >= 0 ? '+' : ''}{f.netCents.toFixed(2)}c/contract</span>
                  {' '}[{f.netCiLo?.toFixed(1)}, {f.netCiHi?.toFixed(1)}]
                </span>
              ) : null
            })()}
            {' '} - net{' '}
            <span className={(status.perf.realizedPnl ?? 0) >= 0 ? 'bt-pos' : 'bt-neg'}>
              {(status.perf.realizedPnl ?? 0) >= 0 ? '+' : ''}
              {(status.perf.realizedPnl ?? 0).toFixed(2)}
            </span>
          </span>
        ) : (
          <span className="muted">no closed trades yet - fills in as paper positions exit or settle</span>
        )}
        {status.perfByStrategy && Object.keys(status.perfByStrategy).length > 0 && (
          <span className="muted">
            {Object.entries(status.perfByStrategy)
              .map(([k, v]) => {
                const clv = (v.clvN ?? 0) > 0 ? ` CLV ${(v.clvSum! / v.clvN!) >= 0 ? '+' : ''}${(v.clvSum! / v.clvN!).toFixed(1)}c` : ''
                const mo = (v.markoutN ?? 0) > 0 ? ` mo5 ${(v.markoutSum! / v.markoutN!) >= 0 ? '+' : ''}${(v.markoutSum! / v.markoutN!).toFixed(1)}c` : ''
                return `${k}: ${v.wins}W/${v.losses}L ${v.realizedPnl >= 0 ? '+' : ''}${v.realizedPnl.toFixed(2)}${clv}${mo}`
              })
              .join(' - ')}
          </span>
        )}
        {status.dailyRealizedPnl !== undefined && (
          <span className={status.dailyRealizedPnl >= 0 ? 'bt-pos' : 'bt-neg'}>
            today {status.dailyRealizedPnl >= 0 ? '+' : ''}
            {status.dailyRealizedPnl.toFixed(2)}
          </span>
        )}
        <span className="muted">closed auto-trades (paper or live, whichever the mode was)</span>
      </div>

      <div className="row">
        <span className="muted">Profile:</span>
        {(['conservative', 'balanced', 'aggressive'] as Profile[]).map((p) => (
          <button key={p} className={`preset ${profile === p ? 'preset-on' : ''}`} onClick={() => applyPreset(p)}>
            {p[0].toUpperCase() + p.slice(1)}
          </button>
        ))}
        <label className="inline">
          Stake $
          <input type="number" min={0.5} step={0.5} value={cfg.amountPerTrade} onChange={(e) => patch({ amountPerTrade: Number(e.target.value) })} />
        </label>
        <label className="inline" title="Hard cap: a single stake never exceeds this % of the current balance (0 = no cap).">
          &lt;= % bal
          <input type="number" min={0} max={100} value={cfg.maxBalancePct} onChange={(e) => patch({ maxBalancePct: Number(e.target.value) })} />
        </label>
        <label className="inline" title="Kill-switch: when today's realized loss reaches this % of balance, stop opening positions (exits keep managing) and disarm LIVE. 0 = off.">
          day loss &lt;= %
          <input type="number" min={0} max={100} value={lossDraft ?? cfg.maxDailyLossPct} onChange={(e) => setLossDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            onBlur={() => { if (lossDraft === null) return; const v = Number(lossDraft); setLossDraft(null); if (Number.isFinite(v) && v >= 0 && v <= 100 && v !== cfg.maxDailyLossPct) void patch({ maxDailyLossPct: v }) }} />
        </label>
        <label className="inline">
          Max open
          <input type="number" min={1} value={cfg.maxOpenPositions} onChange={(e) => patch({ maxOpenPositions: Number(e.target.value) })} />
        </label>
        <label className="inline" title="Positions allowed per underlying asset (SOL, BTC, one weather station...). Kalshi splits one asset across several series, so the per-event cap alone cannot see the concentration. 0 = no cap.">
          per-asset &lt;=
          <input type="number" min={0} value={cfg.maxPerUnderlying} onChange={(e) => patch({ maxPerUnderlying: Number(e.target.value) })} />
        </label>
        <label className="inline" title="Of those slots, at most this many may settle >24h out - keeps slots free for the intraday rotation. 0 = NO long positions at all; set it as high as max positions for no cap.">
          &gt;24h &lt;=
          <input type="number" min={0} value={cfg.maxLongHorizonPositions} onChange={(e) => patch({ maxLongHorizonPositions: Number(e.target.value) })} />
        </label>
        <label className="inline">
          Daily cap
          <input type="number" min={1} value={cfg.maxDailyTrades} onChange={(e) => patch({ maxDailyTrades: Number(e.target.value) })} />
        </label>
        <label
          className="inline"
          title="How far out markets may expire. Anything above 24h admits LONG-HOLD positions (capped by '>24h <=') - longer horizons are your explicit choice."
        >
          horizon
          <select
            value={HORIZON_PRESETS.some((p) => p.minutes === cfg.maxMinutesToClose) ? String(cfg.maxMinutesToClose) : 'custom'}
            onChange={(e) => {
              if (e.target.value === 'custom') return
              patch({ maxMinutesToClose: Number(e.target.value) })
            }}
          >
            {HORIZON_PRESETS.map((p) => (
              <option key={p.minutes} value={p.minutes}>
                {p.label}
              </option>
            ))}
            {!HORIZON_PRESETS.some((p) => p.minutes === cfg.maxMinutesToClose) && (
              <option value="custom">custom ({Math.round(cfg.maxMinutesToClose / 60)}h)</option>
            )}
          </select>
        </label>
        <span className="muted">
          closing in {cfg.minMinutesToClose}m-
          {cfg.maxMinutesToClose >= 2880 ? `${(cfg.maxMinutesToClose / 1440).toFixed(cfg.maxMinutesToClose % 1440 === 0 ? 0 : 1)}d` : `${Math.round(cfg.maxMinutesToClose / 60)}h`}
          {cfg.maxMinutesToClose > 1440 ? ' - LONG HOLDS ON' : ''}
        </span>
      </div>

      <div className="booklab">
        <span className="booklab-title"> AI VETTING</span>
        <label className="inline">
          mode
          <select value={cfg.vetMode} onChange={(e) => patch({ vetMode: e.target.value as 'rules' | 'llm' })}>
            <option value="rules">rules only</option>
            <option value="llm">rules + AI gate</option>
          </select>
        </label>
        <span className="muted">provider:</span>
        {PROVIDERS.map((p) => (
          <button key={p.name} className="ghost" onClick={() => patch({ llmBaseUrl: p.baseUrl, llmModel: p.model })}>
            {p.name}
          </button>
        ))}
        <label className="inline">
          model
          <input style={{ width: 120 }} value={cfg.llmModel} onChange={(e) => patch({ llmModel: e.target.value })} />
        </label>
        <label className="inline" title="DeepSeek V4 Pro reasoning control: adaptive lets the model decide how much to think; disabled answers in ~1s.">
          thinking
          <select value={cfg.llmThinking} onChange={(e) => patch({ llmThinking: e.target.value as AutoTraderConfig['llmThinking'] })}>
            <option value="adaptive">adaptive</option>
            <option value="enabled">full</option>
            <option value="disabled">off (fast)</option>
          </select>
        </label>
        <label className="inline">
          API key
          <input type="password" style={{ width: 170 }} value={cfg.llmApiKey} onChange={(e) => patch({ llmApiKey: e.target.value })} placeholder="sk-... or empty for Ollama" />
        </label>
        <button className="ghost" onClick={testVet} disabled={testing}>
          {testing ? 'Testing...' : 'Test AI'}
        </button>
        <span className="muted">
          {cfg.vetMode === 'llm' ? 'AI gate active - every candidate is vetted.' : 'AI gate off - switch mode to activate. Key is stored locally.'}
        </span>
      </div>

      {vetTest && (
        <div className={`vet-test ${vetTest.ok && vetTest.verdict?.approve ? 'vet-test-ok' : 'vet-test-no'}`}>
          {vetTest.ok && vetTest.verdict ? (
            <>
              <span className="booklab-title">
                AI says: {vetTest.verdict.approve ? 'APPROVE' : 'VETO'} - {vetTest.verdict.direction} - conf{' '}
                {Math.round((vetTest.verdict.confidence ?? 0) * 100)}%
                {vetTest.verdict.impliedProb !== undefined
                  ? ` - implied ${Math.round(vetTest.verdict.impliedProb * 100)}% vs mkt 62%`
                  : ''}
                {vetTest.verdict.expectedEdgeCents !== undefined ? ` - edge ~${vetTest.verdict.expectedEdgeCents}c/$` : ''}
              </span>
              <span className="muted">{vetTest.verdict.reason}</span>
            </>
          ) : (
            <span className="bt-error">AI test failed: {vetTest.error}</span>
          )}
        </div>
      )}

      <div className="row">
        <button onClick={scan} disabled={busy}>
          {busy ? 'Scanning...' : 'Scan now'}
        </button>
        <button className="ghost" onClick={reset}>
          Reset state
        </button>
        <button className="ghost" onClick={() => setAdvanced(!advanced)}>
          {advanced ? 'v' : '>'} Advanced settings
        </button>
        <span className="muted stats">
          {status.scans} scans - {status.dailyTrades} trades today - {status.approved} approved - {status.vetoed} vetoed - {' '}
          {status.executed} executed
          {status.lastScanMs !== undefined ? ` - ${status.lastScanMs}ms/scan` : ''}
          {status.lastError ? ` - WARNING ${status.lastError}` : ''}
        </span>
      </div>

      {advanced && (
        <>
          <div className="row">
            <label className="inline" title="Only markets closing at least this many minutes out are considered.">
              Horizon min
              <input type="number" min={5} value={cfg.minMinutesToClose} onChange={(e) => patch({ minMinutesToClose: Number(e.target.value) })} />
              m
            </label>
            <label className="inline" title="Upper bound on time-to-expiry, in hours (72 h = 3 days).">
              max
              <input
                type="number"
                min={1}
                step={1}
                value={Math.round(cfg.maxMinutesToClose / 60)}
                onChange={(e) => patch({ maxMinutesToClose: Math.max(60, Number(e.target.value) * 60) })}
              />
              h
            </label>
            <label className="inline">
              Min liq $
              <input type="number" min={0} value={cfg.minLiquidity} onChange={(e) => patch({ minLiquidity: Number(e.target.value) })} />
            </label>
            <label className="inline">
              Max spread c
              <input type="number" min={1} step={1} value={Math.round(cfg.maxSpreadPct * 100)} onChange={(e) => patch({ maxSpreadPct: Number(e.target.value) / 100 })} />
            </label>
            <label className="inline">
              p range
              <input type="number" min={0.01} step={0.01} value={cfg.minPrice} onChange={(e) => patch({ minPrice: Number(e.target.value) })} />
              -
              <input type="number" min={0.01} step={0.01} value={cfg.maxPrice} onChange={(e) => patch({ maxPrice: Number(e.target.value) })} />
            </label>
          </div>

          <div className="strat-grid">
            <StratRow label="Momentum" enabled={cfg.momentumEnabled} onToggle={(v) => patch({ momentumEnabled: v })}>
              <label className="inline">
                window min
                <input type="number" min={3} value={cfg.momentumWindowMinutes} onChange={(e) => patch({ momentumWindowMinutes: Number(e.target.value) })} />
              </label>
              <label className="inline">
                min move c
                <input type="number" min={1} step={1} value={Math.round(cfg.momentumMinMovePct * 100)} onChange={(e) => patch({ momentumMinMovePct: Number(e.target.value) / 100 })} />
              </label>
            </StratRow>

            <StratRow label="Volume spike" enabled={cfg.volumeSpikeEnabled} onToggle={(v) => patch({ volumeSpikeEnabled: v })}>
              <label className="inline">
                window min
                <input type="number" min={3} value={cfg.volumeSpikeWindowMinutes} onChange={(e) => patch({ volumeSpikeWindowMinutes: Number(e.target.value) })} />
              </label>
              <label className="inline">
                baseline min
                <input type="number" min={60} step={60} value={cfg.volumeSpikeBaselineMinutes} onChange={(e) => patch({ volumeSpikeBaselineMinutes: Number(e.target.value) })} />
              </label>
              <label className="inline">
                x
                <input type="number" min={1.2} step={0.1} value={cfg.volumeSpikeMinMultiple} onChange={(e) => patch({ volumeSpikeMinMultiple: Number(e.target.value) })} />
              </label>
            </StratRow>

            <StratRow label="Book imbalance" enabled={cfg.bookEnabled} onToggle={(v) => patch({ bookEnabled: v })}>
              <span className="muted" title="Auto-gated: trades only after its own forward lab proves the pass bar (n>=500, hit>55%, move>4c).">
                lab-gated
              </span>
              <label className="inline">
                ratio
                <input type="number" min={1.1} step={0.1} value={cfg.bookMinRatio} onChange={(e) => patch({ bookMinRatio: Number(e.target.value) })} />
              </label>
              <label className="inline">
                total $
                <input type="number" min={50} value={cfg.bookMinDepth} onChange={(e) => patch({ bookMinDepth: Number(e.target.value) })} />
              </label>
              <label className="inline">
                side $
                <input type="number" min={10} value={cfg.bookMinSideDepth} onChange={(e) => patch({ bookMinSideDepth: Number(e.target.value) })} />
              </label>
              <label className="check" title="Log book snapshots + 5-min forward returns (read-only lab for the imbalance signal).">
                <input type="checkbox" checked={cfg.bookLogging} onChange={(e) => patch({ bookLogging: e.target.checked })} />
                log
              </label>
            </StratRow>

            <StratRow label="Cross-venue (Poly -> Kalshi)" enabled={cfg.crossVenueEnabled} onToggle={(v) => patch({ crossVenueEnabled: v })}>
              <label className="inline">
                gap c
                <input type="number" min={3} step={1} value={Math.round(cfg.crossVenueMinGapPct * 100)} onChange={(e) => patch({ crossVenueMinGapPct: Number(e.target.value) / 100 })} />
              </label>
              <label className="inline">
                sim
                <input type="number" min={0.2} max={0.9} step={0.05} value={cfg.crossVenueMinSimilarity} onChange={(e) => patch({ crossVenueMinSimilarity: Number(e.target.value) })} />
              </label>
              <span className="muted">validated: 0% overlap - off by default</span>
            </StratRow>

            <StratRow label="News RSS" enabled={cfg.newsEnabled} onToggle={(v) => patch({ newsEnabled: v })}>
              <label className="inline">
                topics
                <input
                  style={{ width: 180 }}
                  value={cfg.newsTopics.join(', ')}
                  onChange={(e) => patch({ newsTopics: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                />
              </label>
              <label className="inline">
                sim
                <input type="number" min={0.15} max={0.9} step={0.05} value={cfg.newsMinSimilarity} onChange={(e) => patch({ newsMinSimilarity: Number(e.target.value) })} />
              </label>
            </StratRow>

            <StratRow label="Dutch book" enabled={cfg.dutchEnabled} onToggle={(v) => patch({ dutchEnabled: v })}>
              <span className="muted">validated: never occurs - off by default</span>
            </StratRow>

            <StratRow label="Longshot fade (buy NO)" enabled={cfg.fadeEnabled} onToggle={(v) => patch({ fadeEnabled: v })}>
              <label className="inline">
                p &lt;=
                <input type="number" min={0.03} max={0.2} step={0.01} value={cfg.fadeMaxPrice} onChange={(e) => patch({ fadeMaxPrice: Number(e.target.value) })} />
              </label>
              <label className="inline">
                p &gt;=
                <input type="number" min={0.01} max={0.1} step={0.01} value={cfg.fadeMinPrice} onChange={(e) => patch({ fadeMinPrice: Number(e.target.value) })} />
              </label>
              <label
                className="check"
                title="Also buy YES on favorites at the mirror band (90-97%) - same longshot-overpricing bias from the other side. Thinner evidence, so its modeled edge is double-padded."
              >
                <input type="checkbox" checked={cfg.fadeFavoritesEnabled} onChange={(e) => patch({ fadeFavoritesEnabled: e.target.checked })} />
                favorites
              </label>
              <label
                className="check"
                title="Only fade categories where the longshot bias is measured to exist (353M-trade study): blocks crypto, finance, entertainment, and weather <48h. Blocked picks are shadow-graded in the veto ledger so the filter's cost/benefit is measured."
              >
                <input type="checkbox" checked={cfg.fadeCategoryFilterEnabled} onChange={(e) => patch({ fadeCategoryFilterEnabled: e.target.checked })} />
                cat filter
              </label>
              <label
                className="inline"
                title="LIVE entry style. Maker rests a post-only order inside the spread: better price + no taker fee on standard series, but some entries never fill. Taker crosses immediately. Paper always simulates taker."
              >
                entry
                <select value={cfg.fadeEntryMode} onChange={(e) => patch({ fadeEntryMode: e.target.value as 'taker' | 'maker' })}>
                  <option value="maker">maker (rest)</option>
                  <option value="taker">taker (cross)</option>
                </select>
              </label>
              <label className="inline" title="Minimum modeled edge after fees at the executable price, from the historical calibration.">
                edge &gt;= c
                <input type="number" min={0} step={0.5} value={cfg.fadeMinEdgeCents} onChange={(e) => patch({ fadeMinEdgeCents: Number(e.target.value) })} />
              </label>
              <label
                className="inline"
                title="Fade only fires on markets at least this far from close (the calibration entry study measured 60-min entries; below that, extreme prices are more often simply correct). Upper bound = the universe horizon max."
              >
                &gt;= close-
                <input
                  type="number"
                  min={5}
                  step={5}
                  value={cfg.fadeMinHorizonMinutes}
                  onChange={(e) => patch({ fadeMinHorizonMinutes: Number(e.target.value) })}
                />
                m
              </label>
              <label className="check" title="Use TP/SL exits instead of holding to settlement. Early exit pays the spread twice - only worth it when TP clears ~2x spread + fees.">
                <input type="checkbox" checked={cfg.fadeExitEnabled} onChange={(e) => patch({ fadeExitEnabled: e.target.checked })} />
                TP/SL exit
              </label>
              <span className="muted">the one validated edge</span>
            </StratRow>

            <StratRow label="Settlement convergence" enabled={cfg.settleEnabled} onToggle={(v) => patch({ settleEnabled: v })}>
              <label
                className="check"
                title="Allow settlement-convergence to place REAL-MONEY orders. Off = it runs as a paper forward experiment even when the engine is live-armed."
              >
                <input
                  type="checkbox"
                  checked={cfg.settleLiveEnabled}
                  onChange={(e) => {
                    if (e.target.checked && !window.confirm('Allow settlement-convergence to trade REAL money? It is unvalidated (paper forward experiment).')) return
                    patch({ settleLiveEnabled: e.target.checked })
                  }}
                />
                live
              </label>
              <span className="muted">paper forward experiment</span>
            </StratRow>

            <StratRow
              label="Thin weather quoter"
              enabled={cfg.quoterEnabled ?? false}
              onToggle={(v) => {
                if (v && !window.confirm('Enable the weather quoter? Venue settlements 2026-09-02..05 put it at -$29.07 (-2.6c/contract). It quotes REAL money when the engine is live-armed. Shadow mode measures the gated version at zero cost; check its markout first.')) return
                patch({ quoterEnabled: v })
              }}
            >
              <label className="check" title="While not quoting, log the quotes it would rest (gated and ungated) and score them against later prints: proxy fills and 15-minute markout. Zero cost.">
                <input type="checkbox" checked={cfg.quoterShadowEnabled ?? true} onChange={(e) => patch({ quoterShadowEnabled: e.target.checked })} />
                shadow meter
              </label>
              <label className="check" title="Skip brackets the day's banked running high/low has decided or is about to decide (the pick-off window).">
                <input type="checkbox" checked={cfg.quoterRatchetGate ?? true} onChange={(e) => patch({ quoterRatchetGate: e.target.checked })} />
                ratchet gate
              </label>
              <label className="check" title="Skip the UTC hours in which the daily high (16-24Z) or low (08-15Z) forms.">
                <input type="checkbox" checked={cfg.quoterBlackoutEnabled ?? true} onChange={(e) => patch({ quoterBlackoutEnabled: e.target.checked })} />
                blackout
              </label>
              <label className="check" title="Only quote cities whose minute temperature index is served (needed for the ratchet gate).">
                <input type="checkbox" checked={cfg.quoterRequireIndex ?? true} onChange={(e) => patch({ quoterRequireIndex: e.target.checked })} />
                require index
              </label>
              <label className="inline" title="Markets quoted at once (one bracket per city/day).">
                markets
                <input type="number" min={1} max={20} value={cfg.quoterMaxMarkets ?? 4} onChange={(e) => patch({ quoterMaxMarkets: Number(e.target.value) })} />
              </label>
              <label className="inline" title="Collateral budget for resting quotes ($).">
                rest $
                <input type="number" min={0} step={1} value={cfg.quoterMaxExposure ?? 3} onChange={(e) => patch({ quoterMaxExposure: Number(e.target.value) })} />
              </label>
            </StratRow>

            <StratRow label="BTC T-5 convergence" enabled={cfg.convergenceEnabled ?? true} onToggle={(v) => patch({ convergenceEnabled: v })}>
              <label
                className="check"
                title="Allow the pre-registered T-5 KXBTCD rule to place REAL one-contract orders. Off = shadow record only. The registered gate (200 events, corrected CI lower bound above +1c; node scripts/btc-gate.mjs) is the intended arming condition."
              >
                <input
                  type="checkbox"
                  checked={cfg.convergenceLiveEnabled ?? false}
                  onChange={(e) => {
                    if (e.target.checked && !window.confirm('Allow BTC convergence to trade REAL money? Its pre-registered gate has not passed (8W/1L, -32c live so far).')) return
                    patch({ convergenceLiveEnabled: e.target.checked })
                  }}
                />
                live
              </label>
              <label className="inline" title="Maximum filled convergence events per UTC day.">
                per day
                <input type="number" min={1} max={12} value={cfg.convergenceMaxDailyTrades ?? 3} onChange={(e) => patch({ convergenceMaxDailyTrades: Number(e.target.value) })} />
              </label>
              <span className="muted">registered rule 0.10-0.60% margin, cost 60-88c</span>
            </StratRow>
          </div>

          <div className="row">
            <label className="inline">
              TP %
              <input type="number" min={0} value={cfg.takeProfitPct} onChange={(e) => patch({ takeProfitPct: Number(e.target.value) })} />
            </label>
            <label className="inline">
              SL %
              <input type="number" min={0} value={cfg.stopLossPct} onChange={(e) => patch({ stopLossPct: Number(e.target.value) })} />
            </label>
            <label className="inline">
              exit T-min
              <input type="number" min={0} value={cfg.exitMinutesBeforeClose} onChange={(e) => patch({ exitMinutesBeforeClose: Number(e.target.value) })} />
            </label>
            <label className="inline">
              max hold min
              <input type="number" min={0} value={cfg.maxHoldMinutes} onChange={(e) => patch({ maxHoldMinutes: Number(e.target.value) })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={cfg.reversalExit} onChange={(e) => patch({ reversalExit: e.target.checked })} />
              Reversal exit
            </label>
            <label className="inline">
              c
              <input type="number" min={1} step={1} value={Math.round(cfg.reversalExitPct * 100)} onChange={(e) => patch({ reversalExitPct: Number(e.target.value) / 100 })} />
            </label>
            <label className="inline">
              Min score
              <input type="number" min={0} max={100} value={cfg.minScore} onChange={(e) => patch({ minScore: Number(e.target.value) })} />
            </label>
            <label
              className="inline"
              title="Push-alert webhook (Discord webhook URL, or an ntfy.sh/Pushover-style POST endpoint). Fires on: kill-switch, repeated live order errors, stalled scan loop, daily summary."
            >
              alerts to 
              <input
                style={{ width: 220 }}
                value={cfg.alertWebhookUrl}
                onChange={(e) => patch({ alertWebhookUrl: e.target.value.trim() })}
                placeholder="https://ntfy.sh/... or Discord webhook"
              />
            </label>
            <label
              className="inline"
              title="The Odds API key (the-odds-api.com). Feeds the sports sharp-anchor: the devigged sportsbook consensus against Kalshi sports prices; the ladder trades gaps of 3c or more. Stored encrypted."
            >
              odds key
              <input
                style={{ width: 160 }}
                type="password"
                value={cfg.oddsApiKey}
                onChange={(e) => patch({ oddsApiKey: e.target.value.trim() })}
                placeholder="the-odds-api.com key"
              />
            </label>
            <label
              className="inline"
              title="Monthly credit allowance of your The Odds API plan (free 500; paid tiers 20,000 and up). The poller paces itself to it: more credits mean more leagues, closing-line polls down to every 30 minutes near game time, Pinnacle's region on every request, and a daily budget of allowance/31."
            >
              odds credits/mo
              <input type="number" min={100} step={100} style={{ width: 80 }} value={cfg.oddsApiCreditsPerMonth ?? 500} onChange={(e) => patch({ oddsApiCreditsPerMonth: Number(e.target.value) })} />
            </label>
            <label
              className="inline"
              title="Metaculus API token (metaculus.com account settings). Feeds the Metaculus shadow anchor: the community forecast against the Kalshi price on matching long-dated questions, graded at resolution, never traded."
            >
              metaculus key
              <input
                style={{ width: 160 }}
                type="password"
                value={cfg.metaculusApiKey ?? ''}
                onChange={(e) => patch({ metaculusApiKey: e.target.value.trim() })}
                placeholder="metaculus.com token"
              />
            </label>
          </div>
        </>
      )}

      {status.wsStats && (status.wsStats.attempts > 0 || status.wsStats.frames > 0) && (
        <div className="booklab">
          <span className="booklab-title"> WEBSOCKET (shadow)</span>
          <span className="booklab-nums">
            {status.wsStats.connected ? 'connected' : 'offline'} - live books {status.wsStats.liveBooks} - frames {status.wsStats.frames} (snap {status.wsStats.snapshots}/delta {status.wsStats.deltas}) - gaps {status.wsStats.gaps} - reconnects {status.wsStats.reconnects}
          </span>
          {status.wsStats.compared > 0 && (
            <span className="booklab-nums" title="Top-of-book agreement with the REST book, within 2c. This is the gate: the socket may not be trusted until it agrees.">
              vs REST: {Math.round((status.wsStats.agreed / status.wsStats.compared) * 100)}% agree (n={status.wsStats.compared}, worst {status.wsStats.maxDiffCents}c)
            </span>
          )}
          {status.wsStats.guardTripped && <span className="bt-neg">WARNING {status.wsStats.guardTripped}</span>}
          {!status.wsStats.guardTripped && status.wsStats.lastError && <span className="muted">{status.wsStats.lastError.slice(0, 50)}</span>}
        </div>
      )}

      {status.sportsShadow && (status.sportsShadow.polls > 0 || (status.sportsShadow.sgoPolls ?? 0) > 0) && (
        <div className="booklab">
          <span className="booklab-title"> SPORTS ANCHOR (shadow)</span>
          <span className="booklab-nums">
            obs {status.sportsShadow.n} - mean gap {status.sportsShadow.n > 0 ? (status.sportsShadow.sumGapCents / status.sportsShadow.n).toFixed(1) : '0'}c - mean |gap|{' '}
            {status.sportsShadow.n > 0 ? (status.sportsShadow.sumAbsGapCents / status.sportsShadow.n).toFixed(1) : '0'}c - polls {status.sportsShadow.polls}
          </span>
          <span className="muted">
            SportsGameOdds: polls {status.sportsShadow.sgoPolls ?? 0} ({status.sportsShadow.sgoTargetPolls ?? 0} targeted) - month objects {status.sportsShadow.sgoMonthlyObjects ?? 0}/2400 - tracked {Object.keys(status.sportsShadow.sgoTracked ?? {}).length} - graded {status.sportsShadow.sgoGraded ?? 0}
          </span>
          <span className="muted">
            SGO books: fresh {status.sportsShadow.sgoFreshBooks ?? 0} - stale excluded {status.sportsShadow.sgoStaleBooksExcluded ?? 0}
            {(status.sportsShadow.sgoClvN ?? 0) > 0 ? ` - mean CLV ${((status.sportsShadow.sgoClvSumCents ?? 0) / (status.sportsShadow.sgoClvN ?? 1)).toFixed(2)}c` : ''}
            {(status.sportsShadow.sgoGraded ?? 0) > 0 ? ` - Brier ${((status.sportsShadow.sgoBrierSum ?? 0) / (status.sportsShadow.sgoGraded ?? 1)).toFixed(4)}` : ''}
          </span>
          {status.sportsShadow.sgoLastNotice && <span className="muted" title={status.sportsShadow.sgoLastNotice}>SGO plan filters some data</span>}
          {status.sportsShadow.lastError && <span className="muted">Odds API: {status.sportsShadow.lastError.slice(0, 60)}</span>}
          {status.sportsShadow.sgoLastError && <span className="bt-neg">SGO: {status.sportsShadow.sgoLastError.slice(0, 80)}</span>}
        </div>
      )}

      {status.calib && (Object.keys(status.calib.byStrategy).length > 0 || status.calib.vetoes.graded > 0 || status.calib.vetoWatching > 0) && (
        <div className="booklab">
          <span className="booklab-title"> CALIBRATION</span>
          {Object.entries(status.calib.byStrategy).map(([k, v]) => (
            <span key={k} className="booklab-nums" title={v.buckets.filter((b) => b.n > 0).map((b) => `${(b.lo * 100).toFixed(1)}-${(b.hi * 100).toFixed(1)}%: predicted ${((b.probSum / Math.max(b.n, 1)) * 100).toFixed(1)}%  ->  won ${((b.wins / Math.max(b.n, 1)) * 100).toFixed(1)}% (n=${b.n})`).join('\n')}>
            {k}: n={v.n} Brier {v.brier.toFixed(4)}
            </span>
          ))}
          <span
            className="muted"
            title={
              status.calib.vetoesByReason
                ? Object.entries(status.calib.vetoesByReason)
                    .map(([k, v]) => `${k}: graded ${v.graded}, would-have-won ${v.graded > 0 ? Math.round((v.wouldHaveWon / v.graded) * 100) : 0}%, est ${(v.estPnlCents / 100).toFixed(2)}`)
                    .join('\n')
                : undefined
            }
          >
            vetoes: watching {status.calib.vetoWatching}
            {status.calib.vetoes.graded > 0
              ? ` - graded ${status.calib.vetoes.graded}, would-have-won ${Math.round((status.calib.vetoes.wouldHaveWon / status.calib.vetoes.graded) * 100)}%, est ${status.calib.vetoes.estPnlCents >= 0 ? '+' : ''}${(status.calib.vetoes.estPnlCents / 100).toFixed(2)}`
              : ''}
          </span>
        </div>
      )}

      <div className="section-label">Latest signals ({status.signals.length})</div>
      <ul className="at-table">
        {status.signals.length === 0 && <li className="muted">No signals yet - run a scan.</li>}
        {status.signals.map((s) => (
          <li key={s.id} title={JSON.stringify(s.details)}>
            <span className="at-strat">{s.strategy}</span>
            <span className={`at-outcome ${s.outcome === 'YES' ? 'bt-pos' : 'bt-neg'}`}>{s.outcome}</span>
            <span className="at-score">sig {s.score}</span>
            <span className="at-num">{Math.round((s.price ?? 0) * 100)}%</span>
            <span className="at-q" title={s.question}>
              {s.question.slice(0, 48)}
            </span>
            {s.executed ? (
              <span className="bt-pos">PASS opened</span>
            ) : s.error ? (
              <span className="bt-neg" title={s.error}>
                {s.error}
              </span>
            ) : s.aiVerdict === 'veto' ? (
              <span className="bt-neg" title={s.aiReason}>
                 {s.aiReason}
              </span>
            ) : (
              <span className="muted">queued</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function StratRow({
  label,
  enabled,
  onToggle,
  children
}: {
  label: string
  enabled: boolean
  onToggle: (v: boolean) => void
  children: React.ReactNode
}) {
  return (
    <div className="strat-row">
      <label className="check strat-name">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        {label}
      </label>
      <div className="strat-params">{children}</div>
    </div>
  )
}

