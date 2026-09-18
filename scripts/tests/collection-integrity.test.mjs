import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { cursorPages } from '../cursor-pages.cjs'
import { uniqueObservations } from '../unique-observations.mjs'

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
} finally { rmSync(dir, { recursive: true, force: true }) }
console.log('collection integrity: 7 scenarios passed (synthetic data only; early exploratory read cannot issue a verdict)')
