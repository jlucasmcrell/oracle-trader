import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** PIDs of the other node.exe processes running `script`; undefined where the scan does not exist (non-Windows). */
export function recorderPids(script) {
  if (process.platform !== 'win32') return undefined
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "@(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const parsed = JSON.parse(raw || '[]')
  const processes = Array.isArray(parsed) ? parsed : [parsed]
  const wanted = path.resolve(script).replaceAll('\\', '/').toLowerCase()
  return processes.filter(p => p.ProcessId !== process.pid &&
    (p.CommandLine?.match(/"[^"]*"|\S+/g) ?? []).some(arg => arg.replaceAll('"', '').replaceAll('\\', '/').toLowerCase() === wanted))
    .map(p => p.ProcessId)
}

/**
 * Stale means the owner is gone. A live pid only counts while it is still this recorder: a hard reboot runs no exit
 * handler, the lock survives it, and Windows hands the old number to whatever starts next - which would then block
 * every launch of the recorder for as long as that unrelated process lived.
 */
function lockIsStale(lock, script) {
  let owner
  try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')) } catch {
    // Unreadable: another launch is mid-write, or a reboot tore the file. Only the second is still there a minute later.
    try { return Date.now() - fs.statSync(lock).mtimeMs > 60_000 } catch { return false }
  }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false
  try { process.kill(owner.pid, 0) } catch (err) { return err.code === 'ESRCH' }
  try { return recorderPids(script)?.includes(owner.pid) === false } catch { return false }
}

/** One writer per recorder. Existing pre-lock Windows processes are respected, never stopped. */
export function acquireRecorderLock(script, directory) {
  fs.mkdirSync(directory, { recursive: true })
  const lock = path.join(directory, 'recorder.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, script, at: new Date().toISOString() }), { flag: 'wx' })
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      if (attempt || !lockIsStale(lock, script)) return false
      fs.unlinkSync(lock)
    }
  }
  const release = () => {
    try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid) fs.unlinkSync(lock) } catch { /* already gone */ }
  }
  try {
    const legacy = recorderPids(script) ?? []
    if (legacy.length) { console.log(`[recorder] existing writer(s): ${legacy.join(', ')}; new launch skipped`); release(); return false }
    process.once('exit', release)
    return true
  } catch (e) { release(); throw e }
}
