import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isSharingViolation } from './append'

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Write and fsync. `writeFileSync(path, <string>, { flush: true })` does NOT fsync on the Node that Electron 33
 * ships (the utf8 string fast path returns before the flush), which is how the 2026-10-30 unclean shutdown left
 * five renamed-into-place state files full of NUL bytes. An explicit fd and fsyncSync does.
 */
function writeDurable(path: string, content: string): void {
  const fd = openSync(path, 'w')
  try {
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** rename that rides out another process holding the destination (a backup copy, the sentinel, the status page). */
function renameRetry(from: string, to: string, tries = 5): void {
  for (let i = 1; ; i++) {
    try {
      renameSync(from, to)
      return
    } catch (e) {
      if (!isSharingViolation(e) || i >= tries) throw e
      sleepSync(50)
    }
  }
}

/** How often a state file's `.lastgood` copy is refreshed. */
const LASTGOOD_MS = 6 * 3600_000
const lastGoodAt = new Map<string, number>()

/**
 * Keep `<path>.lastgood`: a complete, fsynced copy written hours before any later crash, so a shutdown that damages
 * the live file cannot damage both. Refreshed at most every LASTGOOD_MS from content the caller is saving anyway.
 */
function refreshLastGood(path: string, content: string): void {
  if (!path.endsWith('.json')) return
  const lg = `${path}.lastgood`
  let at = lastGoodAt.get(path)
  if (at === undefined) {
    try { at = statSync(lg).mtimeMs } catch { at = 0 }
  }
  if (Date.now() - at < LASTGOOD_MS) {
    lastGoodAt.set(path, at)
    return
  }
  try {
    writeDurable(`${lg}.tmp`, content)
    renameRetry(`${lg}.tmp`, lg)
    lastGoodAt.set(path, Date.now())
  } catch {
    // The live file is what matters; the next save tries again.
  }
}

/** A file that just parsed gets a last-good copy if it has none: config.json is saved so rarely it would otherwise never have one. */
function seedLastGood(path: string, raw: string): void {
  if (!path.endsWith('.json') || existsSync(`${path}.lastgood`)) return
  try {
    writeDurable(`${path}.lastgood`, raw)
  } catch {
    // best effort
  }
}

/** Same-directory replacement keeps the previous complete file through a failed write. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeDurable(tmp, content)
  renameRetry(tmp, path)
  refreshLastGood(path, content)
}

/** Files whose state was lost with nothing to restore from; the status page and the sentinel flag it until removed by hand. */
export function stateLostPath(dir: string): string {
  return join(dir, 'STATE-LOST.jsonl')
}

/**
 * A state file that will not parse: move it aside, then put the `.lastgood` copy back if there is one. Returns the
 * restored object, or undefined when nothing could be restored (the caller then runs on defaults, and that is
 * recorded in STATE-LOST.jsonl so it cannot pass for the operator's own settings).
 */
function quarantineAndRestore<T>(path: string, reason: string, log: (s: string) => void): { value?: T; at: number } {
  const at = Date.now()
  const aside = `${path}.corrupt-${at}`
  try {
    renameSync(path, aside)
    log(`[json-store] ${path} unreadable (${reason}); moved to ${aside}`)
  } catch (moveErr) {
    log(`[json-store] ${path} unreadable and could not be quarantined: ${moveErr instanceof Error ? moveErr.message : String(moveErr)}`)
  }
  const lg = `${path}.lastgood`
  try {
    if (existsSync(lg)) {
      const raw = readFileSync(lg, 'utf8')
      const value = JSON.parse(raw) as T
      const ageH = ((at - statSync(lg).mtimeMs) / 3600_000).toFixed(1)
      writeDurable(`${path}.tmp`, raw)
      renameRetry(`${path}.tmp`, path)
      console.error(`[json-store] RESTORED ${basename(path)} from its last-good copy (${ageH} h old) after it was found unreadable`)
      return { value, at }
    }
  } catch (e) {
    log(`[json-store] last-good copy of ${path} could not be restored: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    appendFileSync(stateLostPath(dirname(path)), JSON.stringify({ at: new Date(at).toISOString(), file: basename(path), reason }) + '\n')
  } catch {
    // best effort: the error line below is still written
  }
  console.error(`[json-store] STATE LOST: ${basename(path)} is unreadable and has no last-good copy; running on DEFAULTS for it`)
  return { at }
}

/**
 * Parse a JSON state file, or move an unparseable one aside and return undefined. The sub-engine loaders used to
 * fall back to defaults over a corrupt file and the next persist() overwrote the only copy (audit 2026-09-19,
 * B-31); a missing file also returns undefined, so callers keep their defaults either way. An unparseable file is
 * replaced from its `.lastgood` copy when one exists, and that object is returned.
 */
export function loadJsonOrQuarantine<T>(path: string, log: (s: string) => void = console.warn): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    const raw = readFileSync(path, 'utf8')
    const value = JSON.parse(raw) as T
    seedLastGood(path, raw)
    return value
  } catch (err) {
    return quarantineAndRestore<T>(path, err instanceof Error ? err.message : String(err), log).value
  }
}

/** Minimal JSON-file persistence for a single mutable object. */
export class JsonStore<T extends object> {
  private data: T
  /** Set when this process found the file unreadable, moved it aside and had nothing to restore: what it holds now is defaults (backlog 224). */
  quarantinedAt?: number

  constructor(
    private readonly path: string,
    defaults: T
  ) {
    this.data = structuredClone(defaults)
    this.load()
  }

  load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = readFileSync(this.path, 'utf-8')
      this.data = { ...this.data, ...(JSON.parse(raw) as Partial<T>) }
      seedLastGood(this.path, raw)
    } catch (err) {
      // Do NOT continue with defaults over a file that exists but will not
      // parse: the next save() would overwrite the only copy of the ledger.
      // Move it aside, and put the last-good copy back if there is one.
      const r = quarantineAndRestore<Partial<T>>(this.path, err instanceof Error ? err.message : String(err), console.warn)
      if (r.value) this.data = { ...this.data, ...r.value }
      else this.quarantinedAt = r.at
    }
  }

  save(): void {
    try {
      // Write-then-rename: a crash mid-write leaves the previous complete
      // file in place instead of a truncated one. The write is fsynced before the rename (audit 2026-09-19, B-31;
      // 2026-10-30: `flush: true` never did).
      writeFileAtomic(this.path, JSON.stringify(this.data, null, 2))
    } catch (err) {
      // One warn line was all a disk-full or EPERM ever produced, and the trader kept running on state that
      // never reached disk; a later restart then loads the last successful file (audit B-55). Count the run
      // and log at ERROR so the sentinel's log scan sees it - the store cannot safely throw at its callers.
      this.saveFailures++
      console.error(`[json-store] SAVE FAILED (${this.saveFailures} consecutive) for ${this.path}:`, err)
      return
    }
    this.saveFailures = 0
  }

  /** Consecutive failed saves; back to 0 once a write lands. */
  private saveFailures = 0
  savesFailing(): number {
    return this.saveFailures
  }

  get(): T {
    return this.data
  }

  update(patch: Partial<T>): T {
    this.data = { ...this.data, ...patch }
    this.save()
    return this.data
  }
}
