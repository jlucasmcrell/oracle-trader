import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { recorderPids } from '../recorder-lock.mjs'

// A throwaway recorder in a temp directory: the scan matches on script path, so nothing here can see, or be
// seen by, the real recorders.
const dir = mkdtempSync(join(tmpdir(), 'oracle-reclock-'))
const lock = join(dir, 'recorder.lock')
const fixture = join(dir, 'fixture-recorder.mjs')
// RECORDER_LOCK_MODULE points the fixture at a mutant copy when proving these assertions bite.
writeFileSync(fixture, `import { acquireRecorderLock } from ${JSON.stringify(pathToFileURL(resolve(process.env.RECORDER_LOCK_MODULE ?? 'scripts/recorder-lock.mjs')).href)}
const held = acquireRecorderLock(process.argv[1], process.argv[2])
console.log(held ? 'HELD' : 'SKIPPED')
if (held && process.argv[3] === 'stay') setInterval(() => {}, 1000)
`)
const launch = (stay) => new Promise((done, fail) => {
  const child = spawn(process.execPath, [fixture, dir, ...(stay ? ['stay'] : [])], { windowsHide: true })
  let out = ''
  child.stdout.on('data', (d) => { out += d; const m = out.match(/HELD|SKIPPED/); if (m) done({ child, verdict: m[0] }) })
  child.on('exit', () => setTimeout(() => fail(new Error(`fixture exited without a verdict: ${out}`)), 200))
})
const exited = (child) => new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r)))
const owner = () => JSON.parse(readFileSync(lock, 'utf8')).pid

const live = []
try {
  const a = await launch(true); live.push(a.child)
  assert.equal(a.verdict, 'HELD'); assert.equal(owner(), a.child.pid)
  assert.deepEqual(recorderPids(fixture), [a.child.pid]); assert.deepEqual(recorderPids(join(dir, 'absent.mjs')), [])

  const b = await launch(false); await exited(b.child)
  assert.equal(b.verdict, 'SKIPPED', 'a second launch beside a live owner is refused'); assert.equal(owner(), a.child.pid)

  // A writer from before the lock existed holds no file; the process scan still finds it.
  rmSync(lock)
  const c = await launch(false); await exited(c.child)
  assert.equal(c.verdict, 'SKIPPED', 'a live writer without a lock file is still respected'); assert.equal(existsSync(lock), false)

  // Hard kill: no exit handler runs, so the lock outlives its owner, as it does across a reboot.
  writeFileSync(lock, JSON.stringify({ pid: a.child.pid }))
  a.child.kill(); await exited(a.child)
  const d = await launch(false); await exited(d.child)
  assert.equal(d.verdict, 'HELD', 'a dead owner is replaced'); assert.equal(existsSync(lock), false, 'a clean exit releases the lock')

  // Pid reuse: the recorded owner is alive (this test process) but is not the recorder.
  writeFileSync(lock, JSON.stringify({ pid: process.pid }))
  const e = await launch(false); await exited(e.child)
  assert.equal(e.verdict, 'HELD', 'a live pid that is not this recorder does not hold the lock')

  // Torn lock: fresh means another launch is mid-write; old means a reboot tore it.
  writeFileSync(lock, '')
  const f = await launch(false); await exited(f.child)
  assert.equal(f.verdict, 'SKIPPED', 'a fresh unreadable lock is left alone')
  utimesSync(lock, new Date(Date.now() - 300_000), new Date(Date.now() - 300_000))
  const g = await launch(false); await exited(g.child)
  assert.equal(g.verdict, 'HELD', 'an old unreadable lock is replaced')
} finally {
  for (const c of live) c.kill()
  rmSync(dir, { recursive: true, force: true })
}
console.log('recorder lock: 7 scenarios passed (temp-directory fixture; live recorders untouched)')
