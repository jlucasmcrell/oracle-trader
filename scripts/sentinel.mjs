// Oracle Trader defect sentinel. Deterministic, no LLM, no venue writes.
// Runs every 15 minutes from the Windows task OracleTrader-Sentinel (plain node).
//
// What it does each tick:
//   1. liveness: app process + main.log freshness, ladder tick, BTC collector, HRRR and
//      Metaculus shadows, the daily maintenance run;
//   2. defects: new error signatures in main.log since the last tick, a failed nightly
//      review, stopped-strategy rests whose cancel keeps failing, a venue error that
//      persists in a mini-trader, long-horizon positions in the short-horizon traders,
//      a destroyed or defaulted kalshi-auto.json (lib/config-watch.mjs),
//      scheduled-task failures, OpenRouter credit, Ollama, disk;
//   3. action: a dead app or a stale hourly task is revived directly (Start-ScheduledTask);
//      a defect becomes an incident file under data/sentinel/incidents and, within the
//      rate limits below, a headless repair session (scripts/repair.ps1 -> claude -p with
//      docs/REPAIR-PROMPT.md); everything else is a note in data/sentinel/digest.md, which
//      the 3-hourly desktop delivery task pushes to the operator and the 07:00 maintenance run reads.
//
// Rate limits: at most 3 repair sessions per UTC day, 90 minutes apart, one per signature
// per 12 hours, never while data/sentinel/agent.lock is younger than 3 hours (a maintenance
// or repair session is running). Suppressions live in data/sentinel/suppressions.json:
// [{"pattern": "regex", "until": "ISO date", "reason": "..."}].
//
//   node scripts/sentinel.mjs                # one tick
//   node scripts/sentinel.mjs --dry          # print findings, write nothing, dispatch nothing
//   node scripts/sentinel.mjs --dry --since=2026-09-08T06:00:00Z   # replay a log window
//   node scripts/sentinel.mjs status         # print data/sentinel/status.json
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { TASK_WATCH, isStale } from './lib/task-watch.mjs'
import { WATCHED_KEYS, configLoss, fingerprint, isDefaultedConfig, newQuarantines } from './lib/config-watch.mjs'
import { recorderPids } from './recorder-lock.mjs'

const REPO = 'G:/PROJECTS/oracle-trader'
const UD = path.join(process.env.APPDATA ?? '', 'oracle-trader')
const DIR = path.join(REPO, 'data/sentinel')
const INC = path.join(DIR, 'incidents')
const STATE = path.join(DIR, 'state.json')
const SUPP = path.join(DIR, 'suppressions.json')
const DIGEST = path.join(DIR, 'digest.md')
const STATUS = path.join(DIR, 'status.json')
const LOCK = path.join(DIR, 'agent.lock')
const MAIN_LOG = path.join(UD, 'logs/main.log')

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const sinceArg = argv.find((a) => a.startsWith('--since='))?.slice(8)
const MIN = 60_000
const H = 3600_000
const now = Date.now()
const iso = (t) => new Date(t).toISOString()
const ageMin = (t) => Math.round((now - t) / MIN)

fs.mkdirSync(INC, { recursive: true })
const readJson = (p, dflt) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return dflt
  }
}
const mtime = (p) => {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return undefined
  }
}

if (argv[0] === 'status') {
  console.log(fs.existsSync(STATUS) ? fs.readFileSync(STATUS, 'utf8') : 'no status yet')
  process.exit(0)
}

const state = readJson(STATE, { lastRunAt: 0, seen: {}, notes: {}, dispatches: [], mini: {}, revived: {}, configFp: null })
const since = sinceArg ? Date.parse(sinceArg) : state.lastRunAt ? Math.min(state.lastRunAt, now - 5 * MIN) : now - 20 * MIN
const suppressions = readJson(SUPP, []).filter((s) => !s.until || Date.parse(s.until) > now)
const suppressed = (text) => suppressions.find((s) => {
  try {
    return new RegExp(s.pattern, 'i').test(text)
  } catch {
    return false
  }
})

/** findings: { key, kind: 'repair' | 'notify' | 'revive', title, evidence } */
const findings = []
// Suppressions apply to EVERY finding, not just log signatures: the file has always described itself as
// covering findings, but the check lived only in the log-signature loop, so a known-and-accepted structured
// finding (a matched micro-maker box sitting outside the horizon guard) had no way to be silenced.
const add = (key, kind, title, evidence) => {
  if (suppressed(key) || suppressed(title)) return
  findings.push({ key, kind, title, evidence: String(evidence ?? '').slice(0, 4000) })
}

// ------------------------------------------------------------------ helpers
/** The app's own push webhook (Auto-Trader panel, "alert webhook"): Discord, or ntfy-style POST with a Title header. */
const WEBHOOK = (() => {
  try {
    const url = readJson(path.join(UD, 'kalshi-auto.json'), {}).config?.alertWebhookUrl
    return typeof url === 'string' && /^https:\/\//.test(url) ? url : ''
  } catch {
    return ''
  }
})()
async function pushAlert(title, message) {
  if (!WEBHOOK || DRY) return
  try {
    if (/discord\.com\/api\/webhooks/.test(WEBHOOK)) {
      await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${title}**\n${message}`.slice(0, 1900) }), signal: AbortSignal.timeout(10_000) })
    } else {
      // ntfy JSON publish: header values must be ASCII in Node's fetch, and titles carry arrows and
      // dashes (the 12:48Z ladder push died on that). Topic = the URL's path; JSON goes to the origin.
      const u = new URL(WEBHOOK)
      const topic = u.pathname.replace(/^\/+|\/+$/g, '')
      await fetch(u.origin, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, title: title.slice(0, 120), message: message.slice(0, 3900), priority: /down|failed|REPAIR/.test(title) ? 4 : 3 }),
        signal: AbortSignal.timeout(10_000)
      })
    }
  } catch {
    // alerting never blocks the sentinel
  }
}
function ps(command) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 60_000 })
  } catch (e) {
    return `ERR ${e instanceof Error ? e.message.slice(0, 200) : e}`
  }
}
function processRunning(image) {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 30_000 })
    return out.split('\n').filter((l) => l.startsWith('"')).length
  } catch {
    return -1
  }
}
function lockBusy() {
  const t = mtime(LOCK)
  return t !== undefined && now - t < 3 * H
}
function startTask(name) {
  if (DRY) return 'dry'
  return ps(`Start-ScheduledTask -TaskName '${name}'; 'started'`).trim()
}
function taskLastResults() {
  const out = {}
  for (const name of ['OracleTrader-App', 'OracleTrader-HrrrShadow', 'OracleTrader-MetaculusShadow', 'OracleTrader-MentionShadow', 'OracleTrader-PolyConsensus', 'OracleTrader-Maintenance', 'OracleTrader-Sentinel']) {
    try {
      const csv = execFileSync('schtasks', ['/Query', '/TN', name, '/FO', 'CSV', '/V'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] })
      const lines = csv.split(/\r?\n/).filter(Boolean)
      if (lines.length < 2) continue
      const cols = lines[0].split('","').map((s) => s.replace(/^"|"$/g, ''))
      const vals = lines[1].split('","').map((s) => s.replace(/^"|"$/g, ''))
      const at = (k) => vals[cols.indexOf(k)]
      out[name] = { status: at('Status'), lastResult: at('Last Result'), lastRun: at('Last Run Time'), nextRun: at('Next Run Time') }
    } catch (e) {
      out[name] = { error: e instanceof Error ? e.message.slice(0, 120) : String(e) }
    }
  }
  return out
}

// ------------------------------------------------------------------ 1. liveness
const electronCount = processRunning('electron.exe')
const logAge = mtime(MAIN_LOG)
if (electronCount === 0 || (logAge !== undefined && now - logAge > 10 * MIN)) {
  const why = electronCount === 0 ? 'no electron process' : `main.log silent for ${ageMin(logAge)} min (${electronCount} electron processes)`
  add('app-down', 'revive', 'App down or hung', why)
}
const ladder = readJson(path.join(UD, 'ladder.json'), {})
if (ladder.lastRunAt && now - ladder.lastRunAt > 2 * H && !findings.some((f) => f.key === 'app-down')) {
  add('ladder-stale', 'repair', 'Ladder has not ticked for over 2 hours', `ladder.json lastRunAt ${iso(ladder.lastRunAt)} (${ageMin(ladder.lastRunAt)} min ago); the app is up, so the hourly tick itself is stuck.`)
}
const today = new Date(now).toISOString().slice(0, 10)
const collector = mtime(path.join(REPO, 'data/btc-collector', `${today}.jsonl`))
if ((collector === undefined && new Date(now).getUTCHours() >= 1) || (collector !== undefined && now - collector > 15 * MIN)) {
  add('collector-stale', 'repair', 'BTC collector not writing', collector === undefined ? `data/btc-collector/${today}.jsonl missing` : `last write ${ageMin(collector)} min ago`)
}
for (const [key, file, task, staleMs] of TASK_WATCH) {
  const t = mtime(path.join(REPO, file))
  if (isStale(t, now, staleMs)) {
    const last = state.revived[key] ?? 0
    if (now - last > 3 * H) {
      state.revived[key] = now
      add(key, 'revive-task', `${task} stale (${ageMin(t)} min); starting it`, `${file} last written ${iso(t)}`)
      const r = startTask(task)
      findings[findings.length - 1].evidence += ` | start: ${r}`
    } else {
      add(key, 'repair', `${task} still stale after a restart`, `${file} last written ${iso(t)}; task started at ${iso(last)} without effect`)
    }
  }
}
// The app's own config and ledger file, which nothing here used to look at. A power loss zero-filled it on
// 2026-09-21 and the trader ran disarmed, keyless and blind for 18 hours behind an all-green liveness board
// (backlog 224). Three signatures, because each one exists in a case the others do not: the quarantine only
// happens if JsonStore took that path, the transition only fires if this process saw the file before it went,
// and the standing note is what survives a sentinel restart in the middle of an unrepaired outage.
{
  const cfgFp = fingerprint(readJson(path.join(UD, 'kalshi-auto.json'), null))
  let entries = []
  try {
    entries = fs.readdirSync(UD, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => ({ name: d.name, mtimeMs: mtime(path.join(UD, d.name)) }))
  } catch {
    // user-data directory unreadable: the app-down check owns that finding
  }
  const quarantined = newQuarantines(entries, since)
  if (quarantined.length) {
    add('config-quarantined', 'repair', `The app quarantined ${quarantined.length} state file(s)`, quarantined.map((q) => `${q.name} at ${iso(q.mtimeMs)}`).join(' | ') + ` | JsonStore.load() could not parse them and the app is running on defaults for whatever they held.`)
  }
  const loss = configLoss(state.configFp, cfgFp)
  if (loss) {
    add('config-wiped', 'repair', 'The auto-trader config lost keys or its strategy ledger', `${loss.summary} | kalshi-auto.json compared against the fingerprint stored at the previous tick (counts and presence only, never values).`)
  }
  const ladderStrategies = Object.keys(ladder.strategies ?? {}).length
  if (isDefaultedConfig(cfgFp, ladderStrategies)) {
    add('config-defaulted', 'notify', 'The auto-trader is running on a default config', `kalshi-auto.json has no ${WATCHED_KEYS.join('/')} and an empty perfByStrategy, while ladder.json still holds ${ladderStrategies} strategies with history - so this is a destroyed config, not a new install. enabled=${cfgFp.enabled} liveArmed=${cfgFp.liveArmed} openTrades=${cfgFp.openTrades}. Restoring it is the operator's (it carries keys and the arm).`)
  }
  // Only a successful read updates the baseline: overwriting it from a failed read would erase the
  // evidence the next tick needs to see the loss.
  if (cfgFp) state.configFp = cfgFp
}
// A relaunch beside a live writer is refused by the recorder's own lock and leaves a cmd window behind, so a
// stale recorder whose process is still alive is reported, not relaunched. (2026-09-15: this tick and the
// Startup folder launched all three recorders within seconds of each other; the lock is what stops that race.)
const liveRecorder = (script) => {
  try {
    return recorderPids(path.join(REPO, 'scripts', script)) ?? []
  } catch {
    return []
  }
}

// The 15-minute commodity ladder shadow. It writes a heartbeat every 10s while it lives, so a stale one
// means the PROCESS died, not that the markets are shut (it reports a weekend stand-down in the heartbeat
// and keeps writing). It is not a Scheduled Task - registering one needs elevation this account does not
// have - so it is relaunched directly, through `cmd /c start` for the reason in round 61. Records only:
// nothing it does can place, amend or cancel an order.
{
  const hb = mtime(path.join(REPO, 'data/ladder15-shadow/heartbeat.json'))
  if (hb !== undefined && now - hb > 20 * MIN) {
    const last = state.revived['ladder15-stale'] ?? 0
    const live = liveRecorder('ladder15-shadow.mjs')
    if (live.length) {
      add('ladder15-stale', 'notify', `ladder15 shadow stale (${ageMin(hb)} min) with its process alive (pid ${live.join(', ')}); not relaunched`, `data/ladder15-shadow/heartbeat.json last written ${iso(hb)}`)
    } else if (now - last > 3 * H) {
      state.revived['ladder15-stale'] = now
      add('ladder15-stale', 'revive-task', `ladder15 shadow stale (${ageMin(hb)} min); relaunching`, `data/ladder15-shadow/heartbeat.json last written ${iso(hb)}`)
      if (!DRY) {
        // Through the .cmd wrapper at a space-free path: `start` mis-parses a node path containing
        // spaces, and the switch-before-title ordering below is the one verified in round 61.
        const c = spawn('cmd.exe', ['/c', 'start', '/min', '', path.join(REPO, 'scripts/ladder15-shadow.cmd')], { detached: true, stdio: 'ignore', windowsHide: true, cwd: REPO })
        c.unref()
      }
    } else {
      add('ladder15-stale', 'notify', 'ladder15 shadow still stale after a relaunch', `heartbeat last written ${iso(hb)}; relaunched at ${iso(last)} without effect`)
    }
  }
}

// The 15-minute CRYPTO ladder shadow (round 86), which records what momentum would have signalled on the
// KX*15M family that `minMinutesToClose: 15` hides from every arm. Same shape as ladder15 above: a detached
// process with no Scheduled Task, a heartbeat every cycle, records only. Its pre-registered gate needs ~20
// UTC day-clusters, so an unnoticed death adds a day to the end of the experiment.
{
  const hb = mtime(path.join(REPO, 'data/crypto15-shadow/heartbeat.json'))
  if (hb !== undefined && now - hb > 20 * MIN) {
    const last = state.revived['crypto15-stale'] ?? 0
    const live = liveRecorder('crypto15-shadow.mjs')
    if (live.length) {
      add('crypto15-stale', 'notify', `crypto15 shadow stale (${ageMin(hb)} min) with its process alive (pid ${live.join(', ')}); not relaunched`, `data/crypto15-shadow/heartbeat.json last written ${iso(hb)}`)
    } else if (now - last > 3 * H) {
      state.revived['crypto15-stale'] = now
      add('crypto15-stale', 'revive-task', `crypto15 shadow stale (${ageMin(hb)} min); relaunching`, `data/crypto15-shadow/heartbeat.json last written ${iso(hb)}`)
      if (!DRY) {
        const c = spawn('cmd.exe', ['/c', 'start', '/min', '', path.join(REPO, 'scripts/crypto15-shadow.cmd')], { detached: true, stdio: 'ignore', windowsHide: true, cwd: REPO })
        c.unref()
      }
    } else {
      add('crypto15-stale', 'notify', 'crypto15 shadow still stale after a relaunch', `heartbeat last written ${iso(hb)}; relaunched at ${iso(last)} without effect`)
    }
  }
}

// The market-making simulator (mmsim). A 35-day pre-registered falsification run: a day lost unnoticed is a
// day added to the end, and the run cannot be extended to compensate without breaking its own stopping rule.
// It writes rows continuously, so the newest .jsonl under mmsim/ is its liveness signal.
{
  try {
    const d = path.join(process.env.APPDATA ?? '', 'oracle-trader', 'mmsim')
    if (fs.existsSync(d)) {
      const js = fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => mtime(path.join(d, f))).filter((x) => x !== undefined)
      const newest = js.length ? Math.max(...js) : undefined
      if (newest !== undefined && now - newest > 20 * MIN) {
        const last = state.revived['mmsim-stale'] ?? 0
        const live = liveRecorder('mmsim.mjs')
        if (live.length) {
          add('mmsim-stale', 'notify', `mmsim stale (${ageMin(newest)} min) with its process alive (pid ${live.join(', ')}); not relaunched`, `newest mmsim row file written ${iso(newest)}`)
        } else if (now - last > 3 * H) {
          state.revived['mmsim-stale'] = now
          add('mmsim-stale', 'revive-task', `mmsim stale (${ageMin(newest)} min); relaunching`, `newest mmsim row file written ${iso(newest)}`)
          if (!DRY) {
            const c = spawn('cmd.exe', ['/c', 'start', '/min', '', path.join(REPO, 'scripts/mmsim.cmd')], { detached: true, stdio: 'ignore', windowsHide: true, cwd: REPO })
            c.unref()
          }
        } else {
          add('mmsim-stale', 'notify', 'mmsim still stale after a relaunch', `newest row file ${iso(newest)}; relaunched at ${iso(last)} without effect`)
        }
      }
    }
  } catch {
    // absent directory just means the run has not started
  }
}

// A FRESH HEARTBEAT IS NOT A WORKING RECORDER. ladder15 wrote a perfectly healthy heartbeat for its entire
// life while recording nothing: it read `m.yes_bid`, a field Kalshi does not publish, so every quote came
// back unreadable and every snapshot was discarded. `written: 0` sat under a weekend stand-down note that
// made an empty ledger look expected. Both recorders now self-report a `health` field; read it.
// NOTIFY ONLY, never revive - restarting a process whose code is wrong just writes a fresh heartbeat over
// the same empty ledger, and would do it every three hours forever.
for (const [name, rel] of [
  ['ladder15', 'data/ladder15-shadow/heartbeat.json'],
  ['crypto15', 'data/crypto15-shadow/heartbeat.json']
]) {
  try {
    const p = path.join(REPO, rel)
    if (!fs.existsSync(p)) continue
    const hb = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (typeof hb.health === 'string' && hb.health !== 'ok') {
      add(`${name}-unhealthy`, 'notify', `${name} shadow reports: ${hb.health}`, `${rel}: written ${hb.written}, snapsQuoted ${hb.snapsQuoted}, snapsUnquoted ${hb.snapsUnquoted}`)
    }
  } catch {
    // a torn or absent heartbeat is covered by the staleness checks above
  }
}

// The daily maintenance run (07:00 local). After 08:00 local with no log for today, start it once.
const local = new Date(now)
const localDay = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
const maintLog = path.join(REPO, 'logs', `maintenance-${localDay}.log`)
if (!fs.existsSync(maintLog)) {
  if (local.getHours() >= 8) {
    if (!state.revived['maintenance-' + localDay]) {
      state.revived['maintenance-' + localDay] = now
      add('maintenance-missed', 'revive-task', 'Maintenance did not run today; starting OracleTrader-Maintenance', `no logs/maintenance-${localDay}.log by ${local.toTimeString().slice(0, 5)} local | start: ${startTask('OracleTrader-Maintenance')}`)
    } else if (now - state.revived['maintenance-' + localDay] > 45 * MIN) {
      add('maintenance-missed', 'notify', 'Maintenance still has no log after being started', `started ${iso(state.revived['maintenance-' + localDay])}`)
    }
  }
} else {
  {
    // PowerShell's Tee-Object writes UTF-16 on some hosts; read both encodings.
    const buf = fs.readFileSync(maintLog)
    // UTF-16LE with a BOM (FF FE) or without (ASCII byte, NUL); anything else is UTF-8.
    const utf16 = buf.length > 1 && ((buf[0] === 0xff && buf[1] === 0xfe) || buf[1] === 0)
    const txt = (utf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '')
    const started = mtime(maintLog)
    const exits = [...txt.matchAll(/\] exit (\d+)/g)].map((m) => Number(m[1]))
    if (exits.length === 0 && started !== undefined && now - started > 3.5 * H) add('maintenance-hung', 'notify', 'Maintenance run has no exit line after 3.5 h', txt.slice(-600))
    if (exits.length && exits[exits.length - 1] !== 0) {
      // 2026-09-18T12:05: every attempt returned "You've hit your weekly limit ...
      // resets 11am". A usage limit is NOT a code fault, so neither remedy can work:
      // restarting the task changes nothing, and the repair session needs the SAME
      // quota that is exhausted. Report it once for the day and do not retry.
      // Only the tail: an early quota hit must not mask a LATER real fault.
      const tail = txt.slice(-800)
      const usageLimit = /hit your (weekly|daily|monthly) limit|usage limit|rate limit|quota exceeded|resets \d{1,2}(:\d{2})?\s?(am|pm)/i.exec(tail)
      if (usageLimit) {
        const kq = 'maintenance-quota-' + localDay
        if (!state.revived[kq]) {
          state.revived[kq] = now
          add('maintenance-quota', 'notify', 'Maintenance is blocked on an LLM usage limit, not a fault - no restart or repair attempted', `matched "${usageLimit[0]}" | ${tail.slice(-400)}`)
        }
      } else {
        // 2026-09-08 07:00: the run died in 23 s on an API auth error and nothing noticed until a human read the log.
        const k = 'maintenance-failed-' + localDay
        if (!state.revived[k]) {
          state.revived[k] = now
          add('maintenance-failed', 'revive-task', `Maintenance run exited ${exits[exits.length - 1]}; starting it again`, txt.slice(-500) + ` | start: ${startTask('OracleTrader-Maintenance')}`)
        } else if (now - state.revived[k] > 60 * MIN) {
          add('maintenance-failed', 'repair', `Maintenance run still failing (exit ${exits[exits.length - 1]}) after a restart`, txt.slice(-800))
        }
      }
    }
  }
}

// ------------------------------------------------------------------ 2. nightly review
const latest = readJson(path.join(UD, 'reviews/latest.json'), undefined)
if (latest?.date === today && latest.error) {
  const plansFailed = String(latest.error).split(' | ').length
  const key = `review-failed:${today}`
  if ((latest.attempts ?? 1) >= 3 || plansFailed >= 3) add(key, 'repair', `Nightly review failed (${latest.attempts ?? 1} attempt(s), ${plansFailed} model(s) refused)`, latest.error)
  else add(key, 'notify', `Nightly review attempt ${latest.attempts ?? 1} failed; the app retries in 2 h`, latest.error)
} else if (new Date(now).getUTCHours() >= 9 && (!latest || latest.date < today)) {
  add(`review-missing:${today}`, 'repair', 'No nightly review record for today after 09:00 UTC', `latest.json date ${latest?.date ?? 'none'}`)
}

// ------------------------------------------------------------------ 3. log signatures
const INTERESTING = /\[(error|warn)\]|-> [45]\d\d|HTTP [45]\d\d|cancel refused|order group|pending (orders|fills):|\[review\] (failed|model failed)|TypeError|ReferenceError|Unhandled|ECONNREFUSED|EAI_AGAIN|insufficient_balance|collateral guard/i
const ALWAYS = /cancel refused|pending (orders|fills):|TypeError|ReferenceError|Unhandled|\[review\] failed/i
const IGNORE = /Electron Security Warning|This warning will not show up/i
function normalize(line) {
  return line
    .replace(/^\[[^\]]+\] /, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\bot-\d+-\w+/g, '<coid>')
    .replace(/\bKX[A-Z]+(?:-[A-Z0-9.]+)+/g, (m) => m.split('-')[0] + '-*')
    .replace(/\b[a-z]{2,6}-[a-z0-9-]+-20\d\d-\d\d-\d\d[a-z0-9-]*/g, '<slug>')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .slice(0, 170)
}
const sigs = new Map()
let scanned = 0
try {
  const text = fs.readFileSync(MAIN_LOG, 'utf8')
  const sinceKey = '[' + iso(since)
  for (const line of text.split('\n')) {
    if (line < sinceKey || !line.startsWith('[20')) continue
    scanned++
    if (!INTERESTING.test(line) || IGNORE.test(line)) continue
    const sig = normalize(line)
    const rec = sigs.get(sig) ?? { count: 0, sample: line.slice(0, 400) }
    rec.count++
    sigs.set(sig, rec)
  }
} catch (e) {
  add('log-unreadable', 'notify', 'main.log unreadable', String(e).slice(0, 200))
}
const newSigs = []
const grown = []
for (const [sig, rec] of sigs) {
  const sup = suppressed(sig) || suppressed(rec.sample)
  const prev = state.seen[sig]
  const isNew = !prev || now - prev.last > 24 * H
  state.seen[sig] = { first: prev?.first ?? now, last: now, count: (prev?.count ?? 0) + rec.count, lastWindow: rec.count }
  if (sup) continue
  if (rec.count >= 3 || ALWAYS.test(sig)) {
    if (isNew) newSigs.push({ sig, ...rec })
    else if (prev?.lastWindow && rec.count >= 20 && rec.count >= 2 * prev.lastWindow) grown.push({ sig, ...rec, prev: prev.lastWindow })
  }
}
for (const sig of Object.keys(state.seen)) if (now - state.seen[sig].last > 14 * 86400_000) delete state.seen[sig]
// One finding per signature so the 12-hour dispatch rule applies to each signature on its own.
for (const s of newSigs) add('log:' + s.sig.slice(0, 80), 'repair', `New error signature in main.log (x${s.count} since ${iso(since)})`, `${s.sig}\n\nsample: ${s.sample}`)
if (grown.length) add('log-growth', 'notify', 'Known error signatures escalating', grown.map((s) => `x${s.count} (was ${s.prev})  ${s.sig}`).join('\n'))

// ------------------------------------------------------------------ 4. stuck cancels, mini errors, horizons
const auto = readJson(path.join(UD, 'kalshi-auto.json'), {})
const pend = auto.state?.pendingOrders ?? []
const stuck = pend.filter((p) => p.cancelAskedAt && now - p.cancelAskedAt > 65 * MIN)
if (stuck.length) add('cancel-stuck', 'repair', `${stuck.length} rest(s) of a stopped strategy still open after repeated cancels`, stuck.map((p) => `${p.marketId} ${p.strategy} ${p.outcome} @${p.yesPrice} asked ${iso(p.cancelAskedAt)} promoted ${p.promoted}`).join('\n'))
for (const t of auto.state?.openTrades ?? []) {
  if (t.closeTime && t.closeTime - now > 45 * 86400_000) add(`horizon-kalshi:${t.marketId}`, 'notify', 'Kalshi position closes more than 45 days out', `${t.marketId} ${t.strategy} ${t.outcome} $${t.amount} close ${iso(t.closeTime)}`)
}
// The daily trade cap: once reached, every scan arm (fade, mean-reversion, flow-follow, ...) is refused
// entries until 00:00Z and the app logs nothing about it; lead-lag, convergence and Dutch do not count.
const capMax = Number(auto.config?.maxDailyTrades ?? 0)
const daily = auto.state?.daily
if (daily && capMax > 0 && daily.date === today && daily.count >= capMax) add(`daily-cap:${daily.date}`, 'notify', `Kalshi daily trade cap reached (${daily.count}/${capMax}); scan arms are refused entries until 00:00Z`, `config.maxDailyTrades=${capMax}; seen at ${iso(now)}`)
// Settled but unbooked: a side quote pinned at 0/1 while the cached close time is still ahead means the
// venue has resolved the market. The app probes these itself (isPinnedQuote); this is the net under it.
const pinnedOpen = (auto.state?.openTrades ?? []).filter((t) => t.lastSideMid !== undefined && (t.lastSideMid <= 0.011 || t.lastSideMid >= 0.989) && now - (t.createdAt ?? now) > H)
for (const t of pinnedOpen.slice(0, 6)) {
  try {
    const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(t.marketId)}`, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) continue
    const m = (await r.json()).market ?? {}
    const settledAt = m.settlement_ts ? Date.parse(m.settlement_ts) : NaN
    if ((m.result === 'yes' || m.result === 'no') && Number.isFinite(settledAt) && now - settledAt > H) {
      const hours = Math.round((now - settledAt) / H)
      add(`unbooked-settlement:${t.marketId}`, hours >= 3 ? 'repair' : 'notify', `Kalshi trade settled ${hours} h ago but is still open in the ledger`, `${t.marketId} ${t.strategy} ${t.outcome} $${t.amount} result=${m.result} settled ${m.settlement_ts} cached close ${iso(t.closeTime)} lastSideMid ${t.lastSideMid}`)
    }
  } catch {
    // public GET; unreachable is not evidence
  }
}
for (const venue of ['polymarket-us']) {
  const m = readJson(path.join(UD, `mini-auto-${venue}.json`), {})
  const err = m.state?.lastError
  const rec = state.mini[venue] ?? {}
  if (err) {
    if (rec.error !== err) state.mini[venue] = { error: err, since: now }
    else if (now - rec.since > 2 * H) {
      const client = /-> 4\d\d/.test(err) && !/-> 429/.test(err)
      add(`mini-error:${venue}`, client ? 'repair' : 'notify', `${venue} trader error persisting ${Math.round((now - rec.since) / H)} h`, err.slice(0, 400))
    }
  } else delete state.mini[venue]
  // The mini's daily loss brake (added 2026-09-09). Tripped means the venue is
  // closed to new entries for the rest of the UTC day — worth a push, not a repair.
  const dp = m.state?.dailyPnl
  if (dp?.tripped) add(`mini-daily-brake:${venue}:${dp.date}`, 'notify', `${venue} daily loss brake tripped (${dp.realized?.toFixed?.(2) ?? dp.realized})`, `New entries are halted until 00:00Z. config.maxDailyLossDollars=${m.config?.maxDailyLossDollars}`)
  for (const t of m.state?.openTrades ?? []) {
    if (t.closeTime && t.closeTime - now > 15 * 86400_000) add(`horizon-${venue}:${t.marketId}`, 'notify', `${venue} short-horizon trader holds a position ${Math.round((t.closeTime - now) / 86400_000)} days from close`, `${t.marketId} ${t.strategy} ${t.outcome} $${t.amount}`)
  }
}

// ------------------------------------------------------------------ 5. tasks, credits, ollama, disk
const tasks = taskLastResults()
for (const [name, t] of Object.entries(tasks)) {
  if (t.error) continue
  const code = Number(t.lastResult)
  // The app task reports -1 whenever a maintenance or repair session stops electron to load a
  // build and starts it again; the process check above is the app's real liveness signal.
  if (name === 'OracleTrader-App' && electronCount > 0) continue
  if (Number.isFinite(code) && ![0, 267009, 267011, 267014].includes(code)) add(`task:${name}`, 'notify', `${name} last result ${t.lastResult}`, JSON.stringify(t))
}
let credits
try {
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (key) {
    const r = await fetch('https://openrouter.ai/api/v1/credits', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
    const j = await r.json()
    credits = j.data ? Math.round((j.data.total_credits - j.data.total_usage) * 100) / 100 : undefined
    if (credits !== undefined && credits < 15) add('openrouter-low', 'notify', `OpenRouter credit low: $${credits}`, 'the operator: top up at openrouter.ai/settings/credits; the review and hunches fall back to Ollama meanwhile.')
  }
} catch (e) {
  add('openrouter-unreachable', 'notify', 'OpenRouter credit check failed', String(e).slice(0, 200))
}
let ollama = 'unknown'
try {
  const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(8_000) })
  ollama = r.ok ? 'up' : `HTTP ${r.status}`
} catch {
  ollama = 'down'
}
if (ollama !== 'up') add('ollama-down', 'notify', `Ollama ${ollama}`, 'The review, critic and hunches fall back to OpenRouter/DeepSeek; restart Ollama when convenient.')
let diskFreeGb
try {
  const s = fs.statfsSync('G:/')
  diskFreeGb = Math.round((s.bavail * s.bsize) / 1e9)
  if (diskFreeGb < 5) add('disk-low', 'notify', `G: has ${diskFreeGb} GB free`, 'Backups and logs live here.')
} catch {
  // statfs unavailable
}

// ------------------------------------------------------------------ act
const byKind = (k) => findings.filter((f) => f.kind === k)
const lines = []
if (!DRY) {
  for (const f of byKind('revive')) {
    if (f.key === 'app-down') {
      const last = state.revived['app'] ?? 0
      if (now - last < 20 * MIN) {
        f.evidence += ' | revived less than 20 min ago; not restarting again'
        f.kind = 'repair'
        continue
      }
      state.revived['app'] = now
      const r = ps("Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 3; Start-ScheduledTask -TaskName 'OracleTrader-App'; 'restarted'").trim()
      f.evidence += ` | ${r}`
    }
  }
}

// Distinct incident files, not rows: one session bundles every fresh finding and writes a row for each,
// so counting rows let a two-finding session eat two of the three daily slots on its own.
const todayDispatches = [...new Set(state.dispatches.filter((d) => d.at.slice(0, 10) === today).map((d) => d.file))]
const lastDispatch = state.dispatches.length ? Date.parse(state.dispatches[state.dispatches.length - 1].at) : 0
let dispatched
const repairs = byKind('repair')
if (repairs.length) {
  const fresh = repairs.filter((f) => !state.dispatches.some((d) => d.key === f.key && now - Date.parse(d.at) < 12 * H))
  const gate = DRY ? 'dry run' : lockBusy() ? 'agent.lock busy (a maintenance or repair session is running)' : todayDispatches.length >= 3 ? '3 repair sessions already today' : now - lastDispatch < 90 * MIN ? 'last repair less than 90 min ago' : fresh.length === 0 ? 'every finding already dispatched within 12 h' : ''
  if (!gate) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 16)
    const slug = fresh[0].key.replace(/[^a-z0-9]+/gi, '-').slice(0, 40).replace(/-+$/, '')
    const file = path.join(INC, `${stamp}-${slug}.md`)
    const body = [
      `# Incident ${stamp} — ${fresh[0].title}`,
      '',
      `Opened by scripts/sentinel.mjs at ${iso(now)}. Status: OPEN. Repair session dispatched: yes.`,
      '',
      ...fresh.map((f) => `## ${f.title}\n\nkey: \`${f.key}\`\n\n\`\`\`\n${f.evidence}\n\`\`\``),
      '',
      '## Outcome',
      '',
      '(the repair session writes here: FIXED / MITIGATED / NOT-A-DEFECT / NEEDS-OPERATOR, what changed, how it was verified)',
      ''
    ].join('\n')
    fs.writeFileSync(file, body)
    // Through `cmd /c start`, NOT spawn(powershell, { detached: true }): the
    // detached form returns a pid and fires 'spawn', then exits 0 without
    // running anything (DETACHED_PROCESS leaves powershell with no console).
    // Verified 4/4 silent no-ops against 2/2 successes without it, which is why
    // no repair session has actually run since 2026-09-08 03:42 while the
    // sentinel went on recording them as dispatched. `start` gives the session
    // its own console and lets it outlive this process.
    const child = spawn('cmd.exe', ['/c', 'start', '/min', '', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'scripts/repair.ps1'), file], { detached: true, stdio: 'ignore', windowsHide: true, cwd: REPO })
    child.unref()
    dispatched = { file, keys: fresh.map((f) => f.key) }
    for (const f of fresh) state.dispatches.push({ at: iso(now), key: f.key, file })
    state.dispatches = state.dispatches.slice(-50)
  } else {
    lines.push(`repair not dispatched: ${gate}`)
    if (!DRY && !lockBusy() && fresh.length) {
      // Still leave the evidence on disk when the rate limit blocks a session.
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 16)
      const file = path.join(INC, `${stamp}-undispatched.md`)
      fs.writeFileSync(file, `# Undispatched ${stamp} (${gate})\n\n` + fresh.map((f) => `## ${f.title}\n\nkey: \`${f.key}\`\n\n\`\`\`\n${f.evidence}\n\`\`\``).join('\n\n') + '\n')
    }
  }
}

// ------------------------------------------------------------------ digest + state
const notes = findings.filter((f) => f.kind !== 'repair' || !dispatched)
const fresh6h = notes.filter((f) => {
  const last = state.notes[f.key] ?? 0
  return now - last > 6 * H
})
for (const f of fresh6h) state.notes[f.key] = now
for (const k of Object.keys(state.notes)) if (now - state.notes[k] > 3 * 86400_000) delete state.notes[k]

const summary = {
  at: iso(now),
  since: iso(since),
  scannedLines: scanned,
  electron: electronCount,
  mainLogAgeMin: logAge ? ageMin(logAge) : null,
  ladderTickAgeMin: ladder.lastRunAt ? ageMin(ladder.lastRunAt) : null,
  review: latest ? { date: latest.date, error: latest.error ? String(latest.error).slice(0, 120) : null, attempts: latest.attempts } : null,
  openrouterCredit: credits ?? null,
  ollama,
  diskFreeGb: diskFreeGb ?? null,
  tasks,
  findings: findings.map((f) => ({ key: f.key, kind: f.kind, title: f.title })),
  dispatched: dispatched ?? null,
  repairSessionsToday: todayDispatches.length + (dispatched ? 1 : 0),
  lockBusy: lockBusy()
}

if (DRY) {
  // No process.exit here: undici's handles are still closing after the fetches
  // and libuv asserts on Windows when the loop is torn down under them.
  console.log(JSON.stringify(summary, null, 1))
  for (const f of findings) console.log(`\n[${f.kind}] ${f.title}\n${f.evidence.slice(0, 1200)}`)
} else {
  await persist()
}

async function persist() {
state.lastRunAt = now
fs.writeFileSync(STATE, JSON.stringify(state, null, 1))
fs.writeFileSync(STATUS, JSON.stringify(summary, null, 1))

// A gate is a standing state, not an event: unthrottled it became a phone push every 15 minutes saying
// the same thing. Same 6 h/key rule the findings get, so a CHANGE of gate still comes through.
const freshLines = lines.filter((l) => {
  const key = 'gate:' + l.slice(0, 120)
  if (now - (state.notes[key] ?? 0) <= 6 * H) return false
  state.notes[key] = now
  return true
})
const entry = []
if (dispatched || fresh6h.length || freshLines.length) {
  entry.push(`## ${iso(now)} — ${dispatched ? 'REPAIR DISPATCHED' : fresh6h.some((f) => f.kind === 'repair') ? 'defect noted (repair gated)' : fresh6h.some((f) => f.kind.startsWith('revive')) ? 'revived' : 'notes'}`)
  if (dispatched) entry.push(`- repair session started for: ${dispatched.keys.join(', ')} (incident ${path.basename(dispatched.file)})`)
  for (const f of fresh6h) entry.push(`- [${f.kind}] ${f.title}: ${f.evidence.split('\n')[0].slice(0, 200)}`)
  for (const l of freshLines) entry.push(`- ${l}`)
  entry.push('')
}
// Phone push for anything that changed, and for repair outcomes the moment they close.
if (entry.length) await pushAlert(`Oracle sentinel: ${entry[0].replace(/^## \S+ — /, '')}`, entry.slice(1).join('\n'))
const closedSeen = state.closedSeen ?? (state.closedSeen = [])
for (const f of fs.readdirSync(INC).filter((n) => n.endsWith('.md') && !closedSeen.includes(n))) {
  const head = fs.readFileSync(path.join(INC, f), 'utf8')
  if (!/Status: CLOSED/.test(head)) continue
  closedSeen.push(f)
  const outcome = head.split('## Outcome')[1]?.trim().split('\n').find((l) => l.trim()) ?? ''
  if (!f.includes('drill')) await pushAlert(`Oracle repair closed: ${f}`, outcome.slice(0, 500))
}
state.closedSeen = closedSeen.slice(-200)
fs.writeFileSync(STATE, JSON.stringify(state, null, 1))
let digest = fs.existsSync(DIGEST) ? fs.readFileSync(DIGEST, 'utf8') : ''
const header = `# Sentinel digest (newest first; a line per finding, at most once per 6 h per key)\n\nLast quiet check: ${iso(now)} — app ${electronCount ? 'up' : 'DOWN'}, ladder tick ${ladder.lastRunAt ? ageMin(ladder.lastRunAt) + ' min ago' : 'n/a'}, ${scanned} log lines scanned, credit $${credits ?? '?'}, ollama ${ollama}.\n\n`
digest = digest.replace(/^# Sentinel digest[\s\S]*?\n\n(?=## |$)/, '')
const sections = digest.split(/^(?=## )/m).filter(Boolean)
fs.writeFileSync(DIGEST, header + (entry.length ? entry.join('\n') + '\n' : '') + sections.slice(0, 60).join(''))
console.log(JSON.stringify({ at: summary.at, findings: summary.findings.length, dispatched: summary.dispatched?.keys ?? null, notes: fresh6h.length, gate: lines[0] ?? null }))
}
