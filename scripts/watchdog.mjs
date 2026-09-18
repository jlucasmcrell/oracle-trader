// Detached watchdog: keeps the rig alive and writes a one-line health status,
// independent of any chat session. Every 60 s it:
//   - restarts the app if the Electron process is gone (max 5 restarts/hour)
//   - restarts a collector if its process is gone (same cap)
//   - reads the live ledgers: open trades, resting orders, quoter exposure,
//     daily trade count and kill-switch state, last errors, scan staleness
//   - counts error lines in main.log over the last 5 minutes
//   - writes data/health/latest.json and appends data/health/health.jsonl
// It never places or cancels orders; the app's own kill switch is the money stop.
//
//   node scripts/watchdog.mjs
import { spawn, execSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'G:/PROJECTS/oracle-trader'
const APPDATA = process.env.APPDATA || ''
const DATA = join(APPDATA, 'oracle-trader')
const OUT = join(REPO, 'data', 'health')
mkdirSync(OUT, { recursive: true })
const LOG = join(OUT, 'watchdog.log')
const log = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); try { appendFileSync(LOG, l + '\n') } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const restarts = { app: [], collector: [], dutch: [], leadlag: [] }
const MAX_RESTARTS_PER_HOUR = 5

const PROCS = {
  app: { match: 'electron.exe', pathLike: 'oracle-trader', start: () => spawn(join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], { cwd: REPO, detached: true, stdio: 'ignore' }).unref() },
  collector: { script: 'scripts/btc-collector.mjs', outDir: 'data/btc-collector' },
  dutch: { script: 'scripts/dutchbook-scanner.mjs', outDir: 'data/dutchbook' },
  leadlag: { script: 'scripts/leadlag-recorder.mjs', outDir: 'data/leadlag' },
}

function running() {
  // One PowerShell call: electron (app) + node command lines (scripts)
  try {
    const out = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -or $_.Name -eq 'node.exe' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"`, { encoding: 'utf8', timeout: 20000 })
    const arr = JSON.parse(out || '[]')
    return (Array.isArray(arr) ? arr : [arr]).filter(Boolean)
  } catch (e) { log('process list failed: ' + e.message); return null }
}
const startScript = (key) => {
  const p = PROCS[key]
  const outDir = join(REPO, p.outDir); mkdirSync(outDir, { recursive: true })
  const child = spawn('node', [p.script], { cwd: REPO, detached: true, stdio: ['ignore', 'ignore', 'ignore'] })
  child.unref()
  return child.pid
}
function canRestart(key) {
  const now = Date.now(); restarts[key] = restarts[key].filter((t) => now - t < 3600e3)
  if (restarts[key].length >= MAX_RESTARTS_PER_HOUR) return false
  restarts[key].push(now); return true
}

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
function ledgers() {
  const h = {}
  const k = readJson(join(DATA, 'kalshi-auto.json'))
  if (k) {
    const s = k.state, c = k.config
    h.kalshi = { armed: !!c.liveArmed, open: (s.openTrades || []).length, resting: (s.pendingOrders || []).length, daily: s.daily?.count, killTripped: !!s.daily?.tripped, dailyRealized: s.dailyPnl?.realized, scanAgeMin: s.lastScanAt ? +((Date.now() - s.lastScanAt) / 60000).toFixed(1) : null, lastError: s.lastError || null, perf: s.perf ? { trades: s.perf.trades, wins: s.perf.wins, losses: s.perf.losses, pnl: +(s.perf.realizedPnl || 0).toFixed(2) } : null }
  }
  const q = readJson(join(DATA, 'quoter-kalshi.json'))
  if (q) h.quoter = { resting: (q.quotes || []).length, exposure: +(q.quotes || []).reduce((a, x) => a + x.count * (x.outcome === 'YES' ? x.yesPrice : 1 - x.yesPrice), 0).toFixed(2), placed: q.placed, filled: q.filled, lastError: q.lastError || null, tickAgeMin: q.lastTick ? +((Date.now() - q.lastTick) / 60000).toFixed(1) : null }
  for (const v of ['polymarket-us']) {
    const m = readJson(join(DATA, `mini-auto-${v}.json`))
    if (m) h[v] = { armed: !!m.config.liveArmed, open: (m.state.openTrades || []).length, resting: (m.state.pendingOrders || []).length, daily: m.state.daily?.count, lastError: m.state.lastError || null, perf: m.state.perf ? { trades: m.state.perf.trades, wins: m.state.perf.wins, losses: m.state.perf.losses, pnl: +(m.state.perf.realizedPnl || 0).toFixed(2) } : null }
  }
  return h
}
function recentErrors() {
  try {
    const p = join(DATA, 'logs', 'main.log')
    const size = statSync(p).size
    const fd = readFileSync(p, 'utf8').slice(Math.max(0, size - 400000))
    const cut = Date.now() - 5 * 60000
    let n = 0, sample = null
    for (const line of fd.split('\n')) {
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/); if (!m) continue
      const t = Date.parse(m[1]); if (!(t >= cut)) continue
      if (/error|failed|exception|reject/i.test(line) && !/hunch pass|errors 0/.test(line)) { n++; sample = sample || line.slice(0, 160) }
    }
    return { count: n, sample }
  } catch { return { count: null, sample: null } }
}

async function tick() {
  const procs = running()
  const alerts = []
  const status = { ts: new Date().toISOString(), procs: {} }
  if (procs) {
    const appAlive = procs.some((p) => p.Name === 'electron.exe' && String(p.CommandLine || '').includes('oracle-trader'))
    status.procs.app = appAlive
    if (!appAlive) { if (canRestart('app')) { PROCS.app.start(); alerts.push('app was down: restarted'); log('APP DOWN -> restarted') } else alerts.push('app down: restart cap reached') }
    for (const key of ['collector', 'dutch', 'leadlag']) {
      const alive = procs.some((p) => p.Name === 'node.exe' && String(p.CommandLine || '').includes(PROCS[key].script.split('/').pop()))
      status.procs[key] = alive
      if (!alive) { if (canRestart(key)) { const pid = startScript(key); alerts.push(`${key} was down: restarted pid ${pid}`); log(`${key} DOWN -> restarted pid ${pid}`) } else alerts.push(`${key} down: restart cap reached`) }
    }
  }
  Object.assign(status, ledgers())
  status.errors5m = recentErrors()
  if (status.kalshi?.killTripped) alerts.push('KALSHI KILL SWITCH TRIPPED')
  if (status.kalshi?.scanAgeMin !== null && status.kalshi?.scanAgeMin > 10) alerts.push(`kalshi scan stale ${status.kalshi.scanAgeMin} min`)
  if (status.quoter?.tickAgeMin !== null && status.quoter?.tickAgeMin > 10) alerts.push(`quoter stale ${status.quoter.tickAgeMin} min`)
  if (status.quoter?.exposure > 30) alerts.push(`quoter exposure $${status.quoter.exposure}`)
  if ((status.errors5m.count || 0) >= 10) alerts.push(`${status.errors5m.count} errors in 5 min: ${status.errors5m.sample}`)
  for (const v of ['kalshi', 'polymarket-us', 'quoter']) if (status[v]?.lastError) alerts.push(`${v}: ${String(status[v].lastError).slice(0, 80)}`)
  status.alerts = alerts
  try { writeFileSync(join(OUT, 'latest.json'), JSON.stringify(status, null, 2)); appendFileSync(join(OUT, 'health.jsonl'), JSON.stringify(status) + '\n') } catch (e) { log('write failed ' + e.message) }
  const k = status.kalshi, q = status.quoter, pu = status['polymarket-us']
  log(`app ${status.procs.app ? 'up' : 'DOWN'} | kalshi ${k ? `armed=${k.armed} open ${k.open} rest ${k.resting} daily ${k.daily} kill ${k.killTripped} pnl ${k.perf?.pnl}` : '-'} | quoter ${q ? `rest ${q.resting} exp $${q.exposure} fills ${q.filled}` : '-'} | polyus ${pu ? `armed=${pu.armed} open ${pu.open} rest ${pu.resting}` : '-'} | errors5m ${status.errors5m.count}${alerts.length ? ' | ALERTS: ' + alerts.join('; ') : ''}`)
}

log('watchdog start')
;(async () => { for (;;) { try { await tick() } catch (e) { log('tick failed: ' + e.message) } await sleep(60000) } })()
