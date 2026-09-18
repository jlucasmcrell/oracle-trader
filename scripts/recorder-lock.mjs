import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

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
      let owner
      try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')) } catch { return false }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false
      try { process.kill(owner.pid, 0); return false } catch (err) { if (err.code !== 'ESRCH') return false }
      if (attempt) return false
      fs.unlinkSync(lock)
    }
  }
  const release = () => {
    try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid) fs.unlinkSync(lock) } catch { /* already gone */ }
  }
  try {
    if (process.platform === 'win32') {
      const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        "@(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress"],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 })
      const parsed = JSON.parse(raw || '[]')
      const processes = Array.isArray(parsed) ? parsed : [parsed]
      const wanted = path.resolve(script).replaceAll('\\', '/').toLowerCase()
      const legacy = processes.filter(p => p.ProcessId !== process.pid &&
        (p.CommandLine?.match(/"[^"]*"|\S+/g) ?? []).some(arg => arg.replaceAll('"', '').replaceAll('\\', '/').toLowerCase() === wanted))
      if (legacy.length) { console.log(`[recorder] existing writer(s): ${legacy.map(p => p.ProcessId).join(', ')}; new launch skipped`); release(); return false }
    }
    process.once('exit', release)
    return true
  } catch (e) { release(); throw e }
}
