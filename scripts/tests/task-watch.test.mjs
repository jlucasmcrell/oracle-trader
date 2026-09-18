// The sentinel's scheduled-task staleness table and rule.
//
// What this protects: the spot-first recorder died at 2026-09-18T13:34Z and nothing found it for
// 2 h 07 m because it was in no watch list at all. The regression that would bring that back is
// either dropping the row or giving a CONTINUOUS recorder the 130-minute hourly-task allowance,
// so both are asserted directly.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TASK_WATCH, DEFAULT_STALE_MS, MIN, isStale } from '../lib/task-watch.mjs'

// Resolved from this file, not the cwd: run-all.cjs runs suites from the repo root but a hand run
// from scripts/ must not turn the directory assertions below into false failures.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const now = Date.UTC(2026, 8, 18, 15, 41, 0)

// -- the rule ---------------------------------------------------------------------------------
// A file that has never been written is "not started", not "died": a different finding, and the
// sentinel would otherwise revive a task on every tick from the first boot onwards.
assert.equal(isStale(undefined, now, 20 * MIN), false)
assert.equal(isStale(null, now, 20 * MIN), false)
// Default applies when a row states no threshold; 129 min is fine for an hourly task, 131 is not.
assert.equal(isStale(now - 129 * MIN, now, undefined), false)
assert.equal(isStale(now - 131 * MIN, now, undefined), true)
assert.equal(DEFAULT_STALE_MS, 130 * MIN)
// A stated threshold overrides it in BOTH directions - the bug being prevented is a continuous
// recorder silently inheriting the hourly allowance.
assert.equal(isStale(now - 21 * MIN, now, 20 * MIN), true)
assert.equal(isStale(now - 19 * MIN, now, 20 * MIN), false)
// The exact gap observed on 2026-09-18 (13:34Z -> 15:41Z) must trip the spot row and would NOT
// have tripped the default.
const observedGapMs = 127 * MIN
assert.equal(isStale(now - observedGapMs, now, 20 * MIN), true)
assert.equal(isStale(now - observedGapMs, now, undefined), false)

// -- the table --------------------------------------------------------------------------------
const keys = TASK_WATCH.map((r) => r[0])
assert.equal(new Set(keys).size, keys.length, 'watch keys must be unique - state.revived is keyed by them')
assert.ok(keys.includes('spot-shadow-stale'), 'the spot-first recorder must stay in the watch list')

const spot = TASK_WATCH.find((r) => r[0] === 'spot-shadow-stale')
assert.equal(spot[1], 'data/spot-shadow/recorder.log')
assert.equal(spot[2], 'OracleTrader-SpotShadow')
assert.equal(spot[3], 20 * MIN, 'a continuous recorder must not inherit the 130-minute hourly allowance')

for (const [key, file, task, staleMs] of TASK_WATCH) {
  assert.match(key, /-stale$/)
  assert.match(task, /^OracleTrader-/)
  assert.ok(file.startsWith('data/'), `${key}: the liveness file must be repo-relative under data/`)
  // The signal file is under data/, which is gitignored live state: assert the DIRECTORY exists so a
  // renamed shadow directory fails here instead of silently never firing.
  const dir = resolve(ROOT, file, '..')
  assert.ok(existsSync(dir), `${key}: ${dir} does not exist - the watch would never fire`)
  if (staleMs !== undefined) assert.ok(staleMs > 0 && staleMs < DEFAULT_STALE_MS, `${key}: an explicit threshold is for a recorder tighter than hourly`)
}

console.log(`task watch: ${TASK_WATCH.length} watched recorders, 11 rule assertions passed (spot-first covered at ${20 * MIN / MIN} min)`)
