import { useCallback, useEffect, useState } from 'react'
import type { SettingsView } from '../../shared/ipc'

interface Props {
  log: (line: string) => void
}

export default function SettingsPanel({ log }: Props) {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [kalshiId, setKalshiId] = useState('')
  const [kalshiPk, setKalshiPk] = useState('')
  const [pmUsId, setPmUsId] = useState('')
  const [pmUsSecret, setPmUsSecret] = useState('')
  const [pmUsStatus, setPmUsStatus] = useState('')
  const [ibkrStatus, setIbkrStatus] = useState('Checking Gateway...')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [kalshiStatus, setKalshiStatus] = useState('')
  const [maxStake, setMaxStake] = useState(0)
  const [maxPositions, setMaxPositions] = useState(0)

  const load = useCallback(async () => {
    const s = await window.api.settings.get()
    setSettings(s)
    setMaxStake(s.riskLimits.maxStakePerBet)
    setMaxPositions(s.riskLimits.maxOpenPositions)
  }, [])

  useEffect(() => {
    load()
    window.api.settings.testIbkrGateway().then((result) => setIbkrStatus(result.message)).catch((err) => setIbkrStatus(`Check failed: ${String(err)}`))
  }, [load])

  const testIbkr = async () => {
    setIbkrStatus('Checking Gateway...')
    try {
      const result = await window.api.settings.testIbkrGateway()
      setIbkrStatus(result.message)
      log(result.message)
    } catch (err) {
      setIbkrStatus(`Check failed: ${String(err)}`)
    }
  }

  const saveKey = async () => {
    setBusy(true)
    try {
      const conn = await window.api.settings.saveManifoldKey(key)
      if (conn.connected) {
        setStatus(`Connected as ${conn.username ?? '?'} - ${conn.balance?.toFixed(0) ?? '?'} M$`)
        log(`Manifold connected as ${conn.username ?? '?'}`)
      } else {
        setStatus(conn.error ? `Failed: ${conn.error}` : 'Key cleared')
      }
      setKey('')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const saveKalshi = async () => {
    setBusy(true)
    try {
      const conn = await window.api.settings.saveKalshiCredentials(kalshiId, kalshiPk)
      if (conn.connected) {
        setKalshiStatus(`Connected - balance $${conn.balance?.toFixed(2) ?? '?'}`)
        log('Kalshi connected')
      } else {
        setKalshiStatus(conn.error ? `Failed: ${conn.error}` : 'Credentials cleared')
      }
      setKalshiPk('')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const savePmUs = async () => {
    setBusy(true)
    try {
      const conn = await window.api.settings.savePolymarketUsCredentials(pmUsId, pmUsSecret)
      if (conn.connected) {
        setPmUsStatus(`Connected - balance $${conn.balance?.toFixed(2) ?? '?'}`)
        log('Polymarket US connected')
      } else {
        setPmUsStatus(conn.error ? `Failed: ${conn.error}` : 'Credentials cleared')
      }
      setPmUsSecret('')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const saveLimits = async () => {
    await window.api.settings.setRiskLimits({ maxStakePerBet: maxStake, maxOpenPositions: maxPositions })
    log(`Risk limits saved: max ${maxStake}/bet, ${maxPositions} positions`)
    await load()
  }

  const resetPaper = async () => {
    await window.api.settings.resetPaper()
    log('Paper accounts reset (balances, positions, history)')
    await load()
  }

  return (
    <div className="settings">
      <div className="s-section">
        <div className="section-label">Manifold (M$ - real value, purchasable/cashable)</div>
        <div className="s-row">
          <input
            type={showKey ? 'text' : 'password'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste Manifold API key..."
          />
          <button className="ghost" onClick={() => setShowKey(!showKey)}>
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
        <div className="s-row">
          <button onClick={saveKey} disabled={busy}>
            {busy ? 'Testing...' : 'Save & test'}
          </button>
        </div>
        <div className="muted">
          {status ||
            (settings?.hasManifoldKey
              ? `Connected as ${settings.manifoldUsername ?? '?'} - ${settings.manifoldBalance?.toFixed(0) ?? '?'} M$`
              : 'No key saved - paper mode only.')}
        </div>
      </div>

      <div className="s-section">
        <div className="section-label">
          Kalshi {settings?.kalshiDemo ? ' - DEMO exchange (mock funds)' : '(real USD)'}
        </div>
        <div className="muted">
          {settings?.kalshiDemo
            ? 'Keys below save to the DEMO slot. Demo keys come from demo.kalshi.co and are separate from production - your production key is kept safe.'
            : 'Keys below save to the PRODUCTION slot.'}
        </div>
        <div className="s-row">
          <input value={kalshiId} onChange={(e) => setKalshiId(e.target.value)} placeholder="API key ID" />
        </div>
        <div className="s-row">
          <textarea
            value={kalshiPk}
            onChange={(e) => setKalshiPk(e.target.value)}
            placeholder="RSA private key (paste full PEM: -----BEGIN ... END-----)"
            rows={5}
          />
        </div>
        <div className="s-row">
          <button onClick={saveKalshi} disabled={busy}>
            {busy ? 'Testing...' : 'Save & test'}
          </button>
          <label
            className="check"
            title="Point the Kalshi adapter at demo.kalshi.co - separate account + API keys, mock funds, real matching engine. Use it to prove the live order path (maker rests, fills, cancels) without money. Demo markets are NOT representative for strategy P&L."
          >
            <input
              type="checkbox"
              checked={settings?.kalshiDemo ?? false}
              onChange={async (e) => {
                const conn = await window.api.settings.setKalshiDemo(e.target.checked)
                setKalshiStatus(
                  e.target.checked
                    ? `DEMO exchange${conn.connected ? ` - balance $${conn.balance?.toFixed(2)}` : ' - paste your DEMO API keys above'}`
                    : conn.connected
                      ? `Production - balance $${conn.balance?.toFixed(2)}`
                      : 'Production - paste your production API keys above'
                )
                log(`Kalshi adapter  ->  ${e.target.checked ? 'DEMO' : 'PRODUCTION'} exchange`)
              }}
            />
            Demo exchange
          </label>
        </div>
        <div className="muted">
          {kalshiStatus ||
            (settings?.kalshiDemo
              ? settings?.hasKalshiDemoKey
                ? `DEMO connected - balance $${settings.kalshiBalance?.toFixed(2) ?? '?'}`
                : 'No DEMO credentials saved - generate a key at demo.kalshi.co.'
              : settings?.hasKalshiKey
                ? `Production connected - balance $${settings.kalshiBalance?.toFixed(2) ?? '?'}`
                : 'No production credentials saved.')}
          {settings?.kalshiDemo && settings?.hasKalshiKey ? ' - production key retained' : ''}
        </div>
      </div>

      <div className="s-section">
        <div className="section-label">Polymarket US (real USD)</div>
        <div className="s-row">
          <input value={pmUsId} onChange={(e) => setPmUsId(e.target.value)} placeholder="API Key ID (from polymarket.us/developer)" />
        </div>
        <div className="s-row">
          <input
            type="password"
            value={pmUsSecret}
            onChange={(e) => setPmUsSecret(e.target.value)}
            placeholder="Secret Key (base64, shown once)"
          />
        </div>
        <div className="s-row">
          <button onClick={savePmUs} disabled={busy}>
            {busy ? 'Testing...' : 'Save & test'}
          </button>
        </div>
        <div className="muted">{pmUsStatus || (settings?.hasPolymarketUsKey ? 'Credentials saved.' : 'No credentials saved.')}</div>
      </div>

      <div className="s-section">
        <div className="section-label">Interactive Brokers / ForecastEx</div>
        <div className="s-row">
          <button onClick={testIbkr}>Check Gateway</button>
        </div>
        <div className="muted">{ibkrStatus}</div>
        <div className="muted">Connection testing is localhost-only and cannot place orders.</div>
      </div>

      <div className="s-section">
        <div className="section-label">Risk limits</div>
        <div className="s-row">
          <label className="inline">
            Max per bet
            <input type="number" min={0} value={maxStake} onChange={(e) => setMaxStake(Number(e.target.value))} />
          </label>
          <label className="inline">
            Max positions
            <input type="number" min={0} value={maxPositions} onChange={(e) => setMaxPositions(Number(e.target.value))} />
          </label>
        </div>
        <div className="s-row">
          <button onClick={saveLimits}>Save limits</button>
        </div>
        <div className="muted">0 = unlimited. Enforced on every order (paper and live).</div>
      </div>

      <div className="s-section">
        <div className="section-label">Reset</div>
        <div className="s-row">
          <button onClick={resetPaper}>Reset everything (paper)</button>
        </div>
        <div className="muted">
          Clears all paper balances, positions, trade history, and every auto-trader's open-trade ledger - gives you a clean,
          consistent starting point. Live accounts and your API keys/strategy settings are untouched.
        </div>
      </div>

      <div className="s-section muted">
        Mode: <strong>{settings?.executionMode ?? 'paper'}</strong> - Keys are encrypted at rest via the OS keychain when available.
      </div>
    </div>
  )
}
