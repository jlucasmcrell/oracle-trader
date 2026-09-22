// What the sentinel can see when the app's own config/state file is destroyed, and the rules that decide it.
//
// 2026-09-21T14:00:57Z an unclean shutdown zero-filled %APPDATA%/oracle-trader/kalshi-auto.json.
// JsonStore.load() quarantined it correctly and the app came up on DEFAULT_CONFIG - disarmed, three API
// keys empty, 16 strategies' perf and 27 open trades gone. Nothing in the sentinel looked at that file,
// so the only signal was an hourly shadow's stale mtime two hours later, filed under the symptom's name
// (`metaculus-stale`), and the loss went unannounced for 18 hours while every liveness light stayed
// green (backlog 224).
//
// Separate module because scripts/sentinel.mjs runs a full live tick on import and cannot otherwise be
// asserted by a test - the same reason as lib/task-watch.mjs.
//
// NOTHING here reads, returns, stores or logs a key VALUE. A key is a boolean: present and non-empty, or
// not. The fingerprint is written to data/sentinel/state.json every tick, so it must stay countable.

/** Config fields whose disappearance is a loss, not a setting. */
export const WATCHED_KEYS = ['metaculusApiKey', 'oddsApiKey', 'llmApiKey', 'alertWebhookUrl']

/** JsonStore.load() renames an unparseable file to `<name>.corrupt-<epoch ms>` (src/main/store/json.ts:57). */
export const QUARANTINE_RE = /\.corrupt-\d+$/

/**
 * Countable shape of kalshi-auto.json. Returns null when the file is missing or unparseable: a read that
 * FAILED must decide nothing and must not overwrite a known-good fingerprint (audit B-54's third value).
 */
export function fingerprint(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const cfg = parsed.config && typeof parsed.config === 'object' ? parsed.config : {}
  const st = parsed.state && typeof parsed.state === 'object' ? parsed.state : {}
  const keys = {}
  for (const k of WATCHED_KEYS) keys[k] = typeof cfg[k] === 'string' && cfg[k].length > 0
  return {
    keys,
    strategies: Object.keys(st.perfByStrategy ?? {}).length,
    openTrades: Array.isArray(st.openTrades) ? st.openTrades.length : 0,
    enabled: cfg.enabled === true,
    liveArmed: cfg.liveArmed === true
  }
}

/**
 * The transition alarm: what was there last tick and is not there now.
 *
 * `openTrades` is deliberately NOT a trigger - it reaches zero legitimately every time the book settles
 * (it went 27 -> 4 over the 18 hours after the wipe with nothing wrong). `perfByStrategy` is: the app only
 * ever adds to it, so a fall from N > 0 to zero is destruction, never bookkeeping.
 */
export function configLoss(prev, cur) {
  if (!prev || !cur) return null
  const lostKeys = WATCHED_KEYS.filter((k) => prev.keys?.[k] === true && cur.keys[k] !== true)
  const strategiesLost = (prev.strategies ?? 0) > 0 && cur.strategies === 0
  if (!lostKeys.length && !strategiesLost) return null
  const parts = []
  if (lostKeys.length) parts.push(`${lostKeys.length} config field(s) went empty: ${lostKeys.join(', ')}`)
  if (strategiesLost) parts.push(`perfByStrategy ${prev.strategies} -> 0`)
  if (prev.liveArmed && !cur.liveArmed) parts.push('liveArmed true -> false')
  if (prev.enabled && !cur.enabled) parts.push('enabled true -> false')
  if ((prev.openTrades ?? 0) > 0 && cur.openTrades === 0) parts.push(`openTrades ${prev.openTrades} -> 0 (context, not a trigger)`)
  return { lostKeys, strategiesLost, summary: parts.join('; ') }
}

/**
 * The standing alarm, for the hours and days AFTER the transition: a config that is structurally the
 * app's fresh default while the ladder - a separate file, which survived - still holds strategies with
 * history. That second half is what keeps this quiet on a genuinely new install, and it is why this does
 * not need a stored "known good" fingerprint to fire the first time it runs.
 */
export function isDefaultedConfig(fp, ladderStrategyCount) {
  if (!fp) return false
  if (!(ladderStrategyCount > 0)) return false
  if (fp.strategies !== 0) return false
  return WATCHED_KEYS.every((k) => fp.keys[k] !== true)
}

/**
 * Quarantine files the app created since the last tick. `entries` is [{ name, mtimeMs }] from the user-data
 * directory; anything older than `sinceMs` has already been reported and is not news.
 */
export function newQuarantines(entries, sinceMs) {
  if (!Array.isArray(entries)) return []
  return entries
    .filter((e) => e && typeof e.name === 'string' && QUARANTINE_RE.test(e.name) && Number.isFinite(e.mtimeMs) && e.mtimeMs > sinceMs)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
}
