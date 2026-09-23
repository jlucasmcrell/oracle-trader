import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { cursorPages } from '../cursor-pages.cjs'
import { uniqueObservations, inDuplicateWriterWindow } from '../unique-observations.mjs'

let pages = 0
const complete = await cursorPages(async () => ({ orders: [{ n: ++pages }], cursor: pages < 65 ? String(pages) : '' }), '/orders', 'orders')
assert.equal(complete.rows.length, 65); assert.equal(complete.complete, true)
await assert.rejects(cursorPages(async () => ({ orders: [], cursor: 'same' }), '/orders', 'orders'), /Repeated/)
await assert.rejects(cursorPages(async () => ({}), '/orders', 'orders'), /Missing/)
const result = uniqueObservations([{ id: 'a', n: 1 }, { id: 'a', n: 1 }, { id: 'a', n: 2 }], r => r.id)
assert.equal(result.duplicates, 1); assert.equal(result.conflicts, 1); assert.equal(result.rows.length, 1)
assert.throws(() => uniqueObservations([{}], r => r.id), /identity/)
const dir = mkdtempSync(join(tmpdir(), 'oracle-integrity-'))
try {
  writeFileSync(join(dir, 'prereg-fixture.json'), JSON.stringify({ runId: 'fixture', params: {}, stopAtIso: new Date(Date.now() + 3600000).toISOString() }))
  writeFileSync(join(dir, 'fixture.jsonl'), 'INVALID OUTCOME FILE MUST NEVER BE OPENED')
  const run = spawnSync(process.execPath, [resolve('scripts/mmsim-grade.mjs')], { encoding: 'utf8', env: { ...process.env, MMSIM_DIR: dir }, windowsHide: true })
  assert.equal(run.status, 2); assert.match(run.stdout, /REFUSING TO GRADE/); assert.equal(run.stderr, '')
  writeFileSync(join(dir, 'fixture.jsonl'), [
    {runId:'fixture',seq:1,event:'fill',fillId:'ambiguous',ts:'2026-09-15T00:00:00Z'},
    {runId:'fixture',seq:1,event:'fill',fillId:'ambiguous',ts:'2026-09-15T01:00:00Z'}
  ].map(JSON.stringify).join('\n'))
  const early = spawnSync(process.execPath, [resolve('scripts/mmsim-grade.mjs'), '--exploratory'], {encoding:'utf8',env:{...process.env,MMSIM_DIR:dir},windowsHide:true})
  assert.equal(early.status,0);assert.match(early.stdout,/1 conflicting sequence IDs/);assert.match(early.stdout,/EXPLORATORY READ/);assert.doesNotMatch(early.stdout,/--- VERDICT ---/)

  // Amendment 2026-09-19: conflicts wholly inside the 2026-09-15 duplicate-writer window are excluded and the
  // verdict proceeds; one row outside it and the verdict is still refused. Stop date in the past = verdict path.
  assert.equal(result.conflictRows.length, 2)
  assert.equal(inDuplicateWriterWindow({ ts: '2026-09-15T07:00:00Z' }), true); assert.equal(inDuplicateWriterWindow({ ts: '2026-09-15T08:25:01Z' }), false); assert.equal(inDuplicateWriterWindow({}), false)
  writeFileSync(join(dir, 'prereg-fixture.json'), JSON.stringify({ runId: 'fixture', params: {}, stopAtIso: '2026-09-16T00:00:00Z' }))
  const grade = (rows) => { writeFileSync(join(dir, 'fixture.jsonl'), rows.map(JSON.stringify).join('\n')); return spawnSync(process.execPath, [resolve('scripts/mmsim-grade.mjs')], {encoding:'utf8',env:{...process.env,MMSIM_DIR:dir},windowsHide:true}) }
  const pair = (a, b) => [{runId:'fixture',seq:1,event:'fill',fillId:'copyA',ts:a}, {runId:'fixture',seq:1,event:'fill',fillId:'copyB',ts:b}, {runId:'fixture',seq:2,event:'markout15',fillId:'copyA',ts:'2026-09-15T09:00:00Z'}, {runId:'fixture',seq:3,event:'cycle',ok:true,ts:'2026-09-15T09:01:00Z'}]
  const inside = grade(pair('2026-09-15T07:00:00Z', '2026-09-15T07:00:12Z'))
  assert.match(inside.stdout, /amendment 2026-09-19\): 1 conflicting sequence IDs.* 3 rows/); assert.match(inside.stdout, /fills 0 /); assert.match(inside.stdout, /--- VERDICT ---/); assert.doesNotMatch(inside.stdout, /conflicting sequence records/)
  const outside = grade(pair('2026-09-15T07:00:00Z', '2026-09-15T09:30:00Z'))
  assert.equal(outside.status, 2); assert.match(outside.stdout, /INCONCLUSIVE: 1 conflicting sequence records/); assert.doesNotMatch(outside.stdout, /--- VERDICT ---/)

  // Backlog 222: the cycle-coverage gate counts only cycles that were written, so a dark stretch cannot lower it. The
  // wall-clock line must show it: one UTC day with a cycle every minute except 10:00-13:00 is 100% on the gate, 87.5%
  // on the wall clock, in both the verdict and the interim read.
  writeFileSync(join(dir, 'prereg-fixture.json'), JSON.stringify({ runId: 'fixture', params: { minCoverage: 0.9 }, startedAtIso: '2026-09-19T00:00:00Z', stopAtIso: '2026-09-20T00:00:00Z' }))
  const darkDay = []
  for (let m = 0; m < 1440; m++) if (m < 600 || m >= 780) darkDay.push({ runId: 'fixture', seq: m + 1, event: 'cycle', ok: true, ts: new Date(Date.UTC(2026, 8, 19) + m * 60000).toISOString() })
  const dark = grade(darkDay)
  assert.match(dark.stdout, /met {5}cycle coverage >= 90% +100\.0%/)
  assert.match(dark.stdout, /wall-clock coverage {2}87\.5% of 1440 min .*UTC days under 90%: 2026-09-19 1260\/1440 min\)/)
  const darkInterim = spawnSync(process.execPath, [resolve('scripts/mmsim-grade.mjs'), '--interim'], { encoding: 'utf8', env: { ...process.env, MMSIM_DIR: dir }, windowsHide: true })
  assert.equal(darkInterim.status, 0); assert.match(darkInterim.stdout, /wall-clock coverage {2}87\.5% of 1440 min/)

  const cdir = join(dir, 'crypto15'); mkdirSync(cdir)
  const gate = (rows) => { writeFileSync(join(cdir, 'observations-2026-09.jsonl'), rows.map(JSON.stringify).join('\n')); return spawnSync(process.execPath, [resolve('scripts/crypto15-gate.mjs')], {encoding:'utf8',env:{...process.env,CRYPTO15_DIR:cdir},windowsHide:true}) }
  const twice = (a, b) => [{ticker:'KXFIX15M-W1',ts:a,signal:false,secondsToClose:60}, {ticker:'KXFIX15M-W1',ts:b,signal:false,secondsToClose:48}]
  const kept = gate(twice('2026-09-15T07:00:00Z', '2026-09-15T07:00:12Z'))
  assert.equal(kept.status, 0); assert.match(kept.stdout, /second-writer copies .* excluded: 1/); assert.match(kept.stdout, /windows recorded\s+1\b/)
  const refused = gate(twice('2026-09-15T07:00:00Z', '2026-09-16T07:00:12Z'))
  assert.equal(refused.status, 2); assert.match(refused.stdout, /INCONCLUSIVE: 1 conflicting window records/)
} finally { rmSync(dir, { recursive: true, force: true }) }
console.log('collection integrity: 12 scenarios passed (synthetic data only; early exploratory read cannot issue a verdict)')
