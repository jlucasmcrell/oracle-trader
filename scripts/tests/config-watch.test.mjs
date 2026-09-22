// The sentinel's view of a destroyed kalshi-auto.json.
//
// What this protects: on 2026-09-21T14:00:57Z a power loss zero-filled that file. The app quarantined it
// and came up on DEFAULT_CONFIG - three API keys empty, liveArmed false, 16 strategies' perf and 27 open
// trades gone - and NOTHING in the watch list looked at it. The only signal was an hourly shadow's stale
// mtime two hours later under the wrong name, and the trader sat disarmed and blind for 18 hours
// (backlog 224). The regressions that would bring that back are: losing one of the three signatures,
// letting a failed read overwrite the baseline, or ever putting a key VALUE in the fingerprint.
import assert from 'node:assert/strict'
import { WATCHED_KEYS, QUARANTINE_RE, WEBHOOK_CACHE, configLoss, fingerprint, isDefaultedConfig, newQuarantines, resolveWebhook } from '../lib/config-watch.mjs'

const T = Date.UTC(2026, 8, 21, 14, 25, 49)
const MIN = 60_000

// The file as it stood at 13:45:53Z, from the preserved pre-crash zip (lengths only were ever read).
const healthy = {
  configVersion: 27,
  config: { metaculusApiKey: 'x'.repeat(100), oddsApiKey: 'x'.repeat(88), llmApiKey: 'x'.repeat(92), alertWebhookUrl: 'https://example.invalid/hook', enabled: true, liveArmed: true },
  state: { openTrades: new Array(27).fill({}), perfByStrategy: Object.fromEntries(new Array(16).fill(0).map((_, i) => [`s${i}`, {}])) }
}
// The file as it stood at 14:25:49Z: the app's defaults, written over the quarantined original.
const wiped = {
  configVersion: 27,
  config: { metaculusApiKey: '', oddsApiKey: '', llmApiKey: '', alertWebhookUrl: '', enabled: false, liveArmed: false },
  state: { openTrades: [], perfByStrategy: {} }
}

// -- the fingerprint --------------------------------------------------------------------------
const good = fingerprint(healthy)
const bad = fingerprint(wiped)
assert.equal(good.strategies, 16)
assert.equal(good.openTrades, 27)
assert.equal(good.liveArmed, true)
for (const k of WATCHED_KEYS) assert.equal(good.keys[k], true, `${k} must read as present`)
for (const k of WATCHED_KEYS) assert.equal(bad.keys[k], false, `${k} must read as absent`)

// A key is a boolean and nothing else. This object is written to data/sentinel/state.json every tick,
// so a regression here would put credentials on disk in a new place.
const serialized = JSON.stringify(good)
assert.ok(!serialized.includes('x'.repeat(10)), 'the fingerprint must never carry a key value')
for (const v of Object.values(good.keys)) assert.equal(typeof v, 'boolean')

// A read that FAILED decides nothing - it is a third value, not a "no" (audit B-54).
assert.equal(fingerprint(null), null)
assert.equal(fingerprint(undefined), null)
assert.equal(fingerprint('{}'), null)
assert.equal(fingerprint([]), null)
// Present but empty is a real answer, not a failure: every key false, zero strategies.
assert.deepEqual(fingerprint({}).keys, Object.fromEntries(WATCHED_KEYS.map((k) => [k, false])))
assert.equal(fingerprint({}).strategies, 0)

// -- the transition alarm ---------------------------------------------------------------------
const loss = configLoss(good, bad)
assert.ok(loss, 'the 2026-09-21 wipe must be reported')
assert.deepEqual(loss.lostKeys, WATCHED_KEYS)
assert.equal(loss.strategiesLost, true)
assert.match(loss.summary, /perfByStrategy 16 -> 0/)
assert.match(loss.summary, /liveArmed true -> false/)

// Steady state is silent, in both directions.
assert.equal(configLoss(good, good), null)
assert.equal(configLoss(bad, bad), null, 'an already-wiped file must not re-fire every tick')
// A restore is not a loss.
assert.equal(configLoss(bad, good), null)
// No baseline yet, or an unreadable file now: nothing is decided.
assert.equal(configLoss(null, bad), null)
assert.equal(configLoss(good, null), null)

// openTrades reaching zero is NOT a trigger: it did exactly that, legitimately, over the 18 hours after
// the wipe as the book settled (27 -> 4 -> 0), and a settled book must never look like a destroyed file.
const settledOut = fingerprint({ config: healthy.config, state: { openTrades: [], perfByStrategy: healthy.state.perfByStrategy } })
assert.equal(configLoss(good, settledOut), null)
// But a single lost key is enough on its own, even with everything else intact.
const oneKeyGone = fingerprint({ config: { ...healthy.config, oddsApiKey: '' }, state: healthy.state })
assert.deepEqual(configLoss(good, oneKeyGone).lostKeys, ['oddsApiKey'])

// -- the standing alarm -----------------------------------------------------------------------
// This is the one that fires with no stored baseline at all - a sentinel restarted in the middle of an
// unrepaired outage has no previous tick to compare against, which is how 18 hours passed.
assert.equal(isDefaultedConfig(bad, 20), true)
assert.equal(isDefaultedConfig(good, 20), false)
// A genuinely new install has an empty config AND an empty ladder: it must stay quiet.
assert.equal(isDefaultedConfig(bad, 0), false)
assert.equal(isDefaultedConfig(bad, undefined), false)
assert.equal(isDefaultedConfig(null, 20), false)
// One surviving key, or one surviving strategy, means this is not a defaulted file.
assert.equal(isDefaultedConfig(fingerprint({ config: { oddsApiKey: 'x' }, state: {} }), 20), false)
assert.equal(isDefaultedConfig(fingerprint({ config: {}, state: { perfByStrategy: { a: {} } } }), 20), false)

// -- quarantine files -------------------------------------------------------------------------
// Both casualties of the 14:00:57Z crash, named as JsonStore renamed them.
const dir = [
  { name: 'kalshi-auto.json', mtimeMs: T },
  { name: 'kalshi-auto.json.corrupt-1790000749327', mtimeMs: T - 1000 },
  { name: 'fill-reconciler-ibkr.json.corrupt-1790000749636', mtimeMs: T - 700 },
  { name: 'mini-auto-polymarket-us.json.corrupt-1788435253682', mtimeMs: T - 18 * 86400_000 },
  { name: 'ladder.json', mtimeMs: T }
]
const fresh = newQuarantines(dir, T - 20 * MIN)
assert.equal(fresh.length, 2, 'both files quarantined by the crash, and only those')
assert.deepEqual(fresh.map((f) => f.name), ['kalshi-auto.json.corrupt-1790000749327', 'fill-reconciler-ibkr.json.corrupt-1790000749636'])
// The 09-03 casualty has been on disk for weeks and is not news on every tick forever.
assert.equal(newQuarantines(dir, T - 20 * MIN).some((f) => f.name.includes('mini-auto')), false)
// Nothing new since the last tick, an unreadable directory, and a file with no mtime.
assert.equal(newQuarantines(dir, T).length, 0)
assert.equal(newQuarantines(undefined, 0).length, 0)
assert.equal(newQuarantines([{ name: 'a.json.corrupt-1', mtimeMs: undefined }], 0).length, 0)
assert.ok(QUARANTINE_RE.test('kalshi-auto.json.corrupt-1790000749327'))
assert.equal(QUARANTINE_RE.test('kalshi-auto.json'), false)
assert.equal(QUARANTINE_RE.test('ibkr-lab.json.bak_calib_20260918-174316'), false, 'a .bak is not a quarantine')

// ---- the alarm must survive the wipe it reports (2026-09-22) ----
// config-defaulted fires on a wiped config, and the wipe empties alertWebhookUrl. If the push address came only
// from the config, the alarm about a destroyed config could never be delivered.
const HOOK = 'https://example.invalid/topic'
const OTHER = 'https://example.invalid/new-topic'
assert.deepEqual(resolveWebhook(HOOK, ''), { url: HOOK, writeCache: true, source: 'config' }, 'first sight of an address seeds the cache')
assert.deepEqual(resolveWebhook(HOOK, HOOK), { url: HOOK, writeCache: false, source: 'config' }, 'an unchanged address is not rewritten every tick')
assert.deepEqual(resolveWebhook(OTHER, HOOK), { url: OTHER, writeCache: true, source: 'config' }, 'the operator changing the address in the panel wins and refreshes the cache')
assert.deepEqual(resolveWebhook('', HOOK), { url: HOOK, writeCache: false, source: 'cache' }, 'THE CASE: a wiped config still reaches the operator through the cache')
assert.deepEqual(resolveWebhook(undefined, HOOK), { url: HOOK, writeCache: false, source: 'cache' }, 'a config with the field missing entirely')
assert.deepEqual(resolveWebhook('', ''), { url: '', writeCache: false, source: 'none' })
assert.deepEqual(resolveWebhook('http://insecure.invalid/t', ''), { url: '', writeCache: false, source: 'none' }, 'only https is ever pushed to')
assert.deepEqual(resolveWebhook('', 'not a url'), { url: '', writeCache: false, source: 'none' }, 'a corrupt cache is not an address')
assert.equal(resolveWebhook(wiped.config.alertWebhookUrl, healthy.config.alertWebhookUrl).url, healthy.config.alertWebhookUrl, 'the 14:25:49Z wiped file, against a cache seeded from the healthy one')
assert.ok(!WEBHOOK_CACHE.includes('/') && !WEBHOOK_CACHE.includes('kalshi-auto'), 'the cache is its own file in userData, never inside the config it backs up')

console.log(`config watch: ${WATCHED_KEYS.length} watched fields, 3 signatures, 48 assertions passed (2026-09-21 wipe reproduced from counts only; alarm survives the wipe)`)
