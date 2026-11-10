// READ-ONLY status page for whoever runs Oracle: one HTML page and a JSON feed, served next to the app.
//
//   node scripts/status-page.mjs [--dir <userData>] [--port 8787] [--host 0.0.0.0]
//
// It only reads files the app and the recorders already write, places nothing, changes nothing, and never reads
// or serves a key: config.json contributes executionMode and nothing else, kalshi-auto.json only its state and the
// lead-lag settings below. Set STATUS_PAGE_KEY to require ?key=<value> on every request.
// Same script on Windows and Linux: userData defaults to %APPDATA%\oracle-trader or ~/.config/oracle-trader.
import { createServer } from 'node:http'
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import { REPO } from './lib/repo-root.mjs'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const DIR = arg('--dir', process.env.APPDATA ? join(process.env.APPDATA, 'oracle-trader') : join(homedir(), '.config', 'oracle-trader'))
const PORT = Number(arg('--port', 8787))
const HOST = arg('--host', '0.0.0.0')
const KEY = process.env.STATUS_PAGE_KEY || ''
const CACHE_DIR = join(REPO, 'data', 'status-page')
const BAL_DAYS = join(CACHE_DIR, 'balance-days.json')
const LEADLAG_KEYS = ['leadLagLiveEnabled', 'leadLagWeekdays', 'leadLagWeekdayContracts', 'leadLagNoTradeCoins', 'leadLagWeekendNoTradeCoins',
  'leadLagMaxContractsPerOrder', 'leadLagMinDislocationCents', 'leadLagMaxDislocationCents', 'leadLagOneEntryPerMarket', 'ladderMaxNotch']

const json = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
const ageMin = (p) => { try { return Math.round((Date.now() - statSync(p).mtimeMs) / 60000) } catch { return null } }
const nyDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

/** The last `bytes` of a file as lines (the main log is tens of MB; the page never reads it whole). */
function tailLines(path, bytes) {
  try {
    const size = statSync(path).size, start = Math.max(0, size - bytes), fd = openSync(path, 'r')
    const buf = Buffer.alloc(size - start); readSync(fd, buf, 0, buf.length, start); closeSync(fd)
    const lines = buf.toString('utf8').split('\n'); if (start > 0) lines.shift()
    return lines
  } catch { return [] }
}

function build() {
  const now = Date.now()
  const log = tailLines(join(DIR, 'logs', 'main.log'), 8 * 1024 * 1024)
  const ts = (l) => Date.parse(l.slice(1, 25))
  const lastLine = [...log].reverse().find((l) => l.startsWith('[2'))
  const starts = log.filter((l) => l.includes('[app] start:'))
  // Balance: every "[engine] kalshi live account balance $X" in the tail, folded into a per-day close kept on disk.
  const days = json(BAL_DAYS, {}) ?? {}
  let balance = null, balanceAt = null
  for (const l of log) {
    const m = l.match(/\[engine\] kalshi live account balance \$([\d.]+)/)
    if (m) { balance = +m[1]; balanceAt = ts(l); days[nyDay(balanceAt)] = balance }
  }
  try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(BAL_DAYS, JSON.stringify(days)) } catch {}
  const killLines = log.filter((l) => /kill-switch TRIPPED|daily loss limit hit/.test(l))
  const scans = log.filter((l) => l.includes('[leadlag] scanned'))
  const ws = [...log].reverse().find((l) => l.includes('[leadlag] poly ws:'))

  const auto = json(join(DIR, 'kalshi-auto.json'), {}) ?? {}
  const cfg = auto.config ?? {}, st = auto.state ?? {}
  const ladder = json(join(DIR, 'ladder.json'), {})?.strategies ?? {}
  const ll = ladder['kalshi-leadlag'] ?? {}
  const live = Object.entries(ladder).filter(([, s]) => s.stage === 'live' || s.stage === 'tiny-live').map(([id, s]) => ({ id, stage: s.stage, notch: s.notch ?? 1 }))

  // Lead-lag fills from its own log; the last 7 New York days and the most recent 20.
  const fills = []
  for (const l of tailLines(join(DIR, 'leadlag-dislocations.jsonl'), 4 * 1024 * 1024)) {
    if (!l.includes('"executed":true')) continue
    try { const r = JSON.parse(l); if ((r.filledContracts ?? 0) > 0) fills.push(r) } catch {}
  }
  const byDay = {}
  for (const r of fills) { const d = nyDay(Date.parse(r.ts)); byDay[d] = (byDay[d] ?? 0) + 1 }
  const recent = fills.slice(-20).reverse().map((r) => ({ at: r.ts, coin: r.underlying, side: r.suggestedAction === 'BUY_KALSHI_YES' ? 'YES' : 'NO', contracts: r.filledContracts, price: r.fillPrice, gap: r.dislocationCents, ticker: r.kalshiTicker }))

  const reads = Object.entries(json(join(DIR, 'registered-reads.json'), {}) ?? {}).map(([id, r]) => ({ id, verdict: r.verdict, day: r.lastEvalDay, summary: r.summary, action: r.action }))
  const sentinel = json(join(REPO, 'data', 'sentinel', 'status.json'), null)
  const recorders = [
    ['BTC collector', join(REPO, 'data', 'btc-collector', `${new Date().toISOString().slice(0, 10)}.jsonl`)],
    ['Crypto 15-min shadow', join(REPO, 'data', 'crypto15-shadow', 'heartbeat.json')],
    ['Ladder 15-min shadow', join(REPO, 'data', 'ladder15-shadow', 'heartbeat.json')],
    ['Polymarket consensus', join(REPO, 'data', 'polymarket-consensus', 'run.log')],
    ['Weather books', join(REPO, 'data', 'weather-books', 'recorder.log')],
    ['In-play books', join(REPO, 'data', 'inplay-books', 'recorder.log')],
    ['Sentinel', join(REPO, 'data', 'sentinel', 'status.json')]
  ].map(([name, p]) => ({ name, ageMin: ageMin(p) }))

  const appAgeMin = lastLine ? Math.round((now - ts(lastLine)) / 60000) : null
  const mode = json(join(DIR, 'config.json'), {})?.executionMode ?? 'paper'
  const flags = []
  if (appAgeMin === null || appAgeMin > 5) flags.push(`App log silent for ${appAgeMin ?? '?'} min`)
  // The 2026-10-30 failure: damaged state files were replaced by defaults and trading sat switched off for three
  // days with every other check green. Anything that means "not trading" or "state was replaced" is a flag.
  if (cfg.enabled === false) flags.push('Auto-trader is switched OFF')
  if (mode === 'live' && cfg.liveArmed === false) flags.push('Live trading is NOT armed')
  if (mode === 'live' && cfg.leadLagLiveEnabled !== true) flags.push('Lead-lag live trading is off')
  if (existsSync(join(DIR, 'STATE-LOST.jsonl'))) flags.push('STATE LOST: a state file was unreadable with no copy to restore; the app is on defaults for it (see STATE-LOST.jsonl)')
  try {
    const damaged = readdirSync(DIR).filter((f) => f.includes('.corrupt-') && now - statSync(join(DIR, f)).mtimeMs < 7 * 86400_000)
    if (damaged.length) flags.push(`State file(s) found damaged in the last 7 days: ${[...new Set(damaged.map((f) => f.split('.corrupt-')[0]))].join(', ')}`)
  } catch {}
  const backup = json(join(process.env.ORACLE_STATE_BACKUP_DEST || 'D:\oracle-trader-backup', 'status.json'), null)
  if (backup) {
    const ageH = (now / 1000 - backup.at) / 3600
    if (backup.ok === false) flags.push(`Last backup FAILED${backup.unparseable?.length ? ': ' + backup.unparseable.join('; ') : ''}`)
    else if (ageH > 3) flags.push(`No backup for ${ageH.toFixed(0)} hours`)
  }
  if (st.dailyPnl?.tripped) flags.push('Daily loss limit tripped: no new entries today')
  if (ll.stage && ll.stage !== 'live' && ll.stage !== 'tiny-live') flags.push(`Lead-lag is ${ll.stage}`)
  if (sentinel?.gateway === 'down') flags.push('IB Gateway down')
  for (const r of recorders) if (r.ageMin === null || r.ageMin > 120) flags.push(`${r.name}: no update for ${r.ageMin ?? '?'} min`)

  return {
    host: hostname(), at: new Date(now).toISOString(), mode,
    armed: { enabled: cfg.enabled ?? null, liveArmed: cfg.liveArmed ?? null },
    app: { lastLogAt: lastLine ? new Date(ts(lastLine)).toISOString() : null, ageMin: appAgeMin, lastStart: starts.at(-1)?.slice(1, 25) ?? null },
    balance: { now: balance, at: balanceAt ? new Date(balanceAt).toISOString() : null, days: Object.entries(days).sort().slice(-30) },
    today: { realized: st.venueDay?.realized ?? null, settlements: st.venueDay?.settlements ?? null, tripped: !!st.dailyPnl?.tripped, killLines: killLines.slice(-3).map((l) => l.slice(0, 200)) },
    leadlag: { stage: ll.stage ?? null, notch: ll.notch ?? null, verdict: ll.lastVerdict ?? null, settings: Object.fromEntries(LEADLAG_KEYS.map((k) => [k, cfg[k] ?? null])),
      lastScan: scans.at(-1)?.slice(1, 25) ?? null, feed: ws ? ws.slice(27, 120) : null, fillsByDay: Object.entries(byDay).sort().slice(-7), recent },
    liveArms: live, reads, recorders, sentinel: sentinel ? { at: sentinel.at, gateway: sentinel.gateway, ollama: sentinel.ollama, diskFreeGb: sentinel.diskFreeGb } : null, flags
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
function page(s) {
  const money = (v) => (v === null || v === undefined ? '-' : `$${Number(v).toFixed(2)}`)
  const ok = s.flags.length === 0
  const days = s.balance.days
  const max = Math.max(...days.map(([, v]) => v), 1), min = Math.min(...days.map(([, v]) => v), 0)
  const bars = days.map(([d, v]) => `<div class="bar" title="${d}: $${v.toFixed(2)}"><i style="height:${Math.max(4, ((v - min) / (max - min || 1)) * 100)}%"></i><span>${d.slice(5)}</span></div>`).join('')
  const row = (cells) => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Oracle status</title><style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2330;--muted:#667085;--line:#e4e7ec;--good:#157f3b;--bad:#b42318;--accent:#2f6fde}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#181c24;--text:#e7eaf0;--muted:#98a2b3;--line:#2a303c;--good:#4ade80;--bad:#f87171;--accent:#7aa7ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:16px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px;color:var(--muted);font-weight:600}
.sub{color:var(--muted);font-size:13px;margin-bottom:14px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:14px;overflow-x:auto}
.grid .card{margin:0}.k{color:var(--muted);font-size:12px}.v{font-size:22px;font-weight:650;margin-top:2px}
.status{padding:10px 14px;border-radius:10px;margin-bottom:14px;font-weight:600;border:1px solid var(--line);background:var(--card)}
.status.ok{color:var(--good)}.status.bad{color:var(--bad)}ul{margin:6px 0 0 18px;padding:0;font-weight:500}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}th{color:var(--muted);font-weight:600}
.bars{display:flex;align-items:flex-end;gap:4px;height:120px}.bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;min-width:14px}
.bar i{display:block;background:var(--accent);border-radius:3px 3px 0 0}.bar span{font-size:10px;color:var(--muted);text-align:center;margin-top:3px}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--muted);white-space:normal}
</style></head><body><main>
<h1>Oracle status</h1><div class="sub">${esc(s.host)} · ${esc(s.mode)} mode · updated ${esc(s.at.replace('T', ' ').slice(0, 19))} UTC · refreshes every 30 s</div>
<div class="status ${ok ? 'ok' : 'bad'}">${ok ? 'All checks OK' : `Needs attention:<ul>${s.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`}</div>
<div class="grid">
<div class="card"><div class="k">Kalshi balance</div><div class="v">${money(s.balance.now)}</div></div>
<div class="card"><div class="k">Settled today</div><div class="v">${money(s.today.realized)}</div></div>
<div class="card"><div class="k">Lead-lag</div><div class="v">${esc(s.leadlag.stage ?? '-')}${s.leadlag.notch ? ` x${s.leadlag.notch}` : ''}</div></div>
<div class="card"><div class="k">App last active</div><div class="v">${s.app.ageMin ?? '-'} min ago</div></div>
</div>
<div class="card"><h2>Balance by day (close)</h2><div class="bars">${bars || '<span class="sub">No balance readings yet</span>'}</div></div>
<div class="card"><h2>Lead-lag</h2><div class="mono">${esc(s.leadlag.verdict ?? '')}</div>
<table><tr><th>Setting</th><th>Value</th></tr>${Object.entries(s.leadlag.settings).map(([k, v]) => row([k, JSON.stringify(v)])).join('')}</table>
<p class="sub">Last scan ${esc(s.leadlag.lastScan ?? '-')} · Polymarket feed: ${esc(s.leadlag.feed ?? '-')}</p>
<table><tr><th>NY day</th><th>Fills</th></tr>${s.leadlag.fillsByDay.map(([d, n]) => row([d, n])).join('')}</table></div>
<div class="card"><h2>Recent lead-lag fills</h2><table><tr><th>Time (UTC)</th><th>Coin</th><th>Side</th><th>Contracts</th><th>Price</th><th>Gap</th></tr>
${s.leadlag.recent.map((r) => row([r.at.replace('T', ' ').slice(0, 19), r.coin, r.side, r.contracts, r.price != null ? `${Math.round(r.price * 100)}¢` : '-', `${r.gap}¢`])).join('')}</table></div>
<div class="card"><h2>Background jobs (minutes since last update)</h2><table><tr><th>Job</th><th>Age</th></tr>${s.recorders.map((r) => row([r.name, r.ageMin ?? 'missing'])).join('')}</table></div>
<div class="card"><h2>Tests the app runs on its own</h2><table><tr><th>Test</th><th>Verdict</th><th>Summary</th></tr>${s.reads.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.verdict)}</td><td class="mono">${esc(r.summary)}</td></tr>`).join('')}</table></div>
<div class="card"><h2>Live strategies</h2><table><tr><th>Strategy</th><th>Stage</th><th>Size</th></tr>${s.liveArms.map((a) => row([a.id, a.stage, `x${a.notch}`])).join('')}</table></div>
<p class="sub">Raw data: <a href="status.json${KEY ? `?key=${encodeURIComponent(KEY)}` : ''}">status.json</a></p>
</main></body></html>`
}

let cache = { at: 0, body: null }
createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (KEY && url.searchParams.get('key') !== KEY) { res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('key required') }
  if (Date.now() - cache.at > 15_000) { try { cache = { at: Date.now(), body: build() } } catch (e) { res.writeHead(500); return res.end(String(e)) } }
  if (url.pathname === '/status.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(cache.body, null, 1)) }
  if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(page(cache.body)) }
  res.writeHead(404); res.end()
}).listen(PORT, HOST, () => console.log(`[status-page] ${DIR} on http://${HOST}:${PORT}/`))
