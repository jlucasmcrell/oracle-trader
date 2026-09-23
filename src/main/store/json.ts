import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Same-directory replacement keeps the previous complete file through a failed write. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf8', flush: true })
  renameSync(tmp, path)
}

/**
 * Parse a JSON state file, or move an unparseable one aside and return undefined. The sub-engine loaders used to
 * fall back to defaults over a corrupt file and the next persist() overwrote the only copy (audit 2026-09-19,
 * B-31); a missing file also returns undefined, so callers keep their defaults either way.
 */
export function loadJsonOrQuarantine<T>(path: string, log: (s: string) => void = console.warn): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (err) {
    const aside = `${path}.corrupt-${Date.now()}`
    try {
      renameSync(path, aside)
      log(`[json-store] ${path} unreadable (${err instanceof Error ? err.message : String(err)}); moved to ${aside}`)
    } catch (moveErr) {
      log(`[json-store] ${path} unreadable and could not be quarantined: ${moveErr instanceof Error ? moveErr.message : String(moveErr)}`)
    }
    return undefined
  }
}

/** Minimal JSON-file persistence for a single mutable object. */
export class JsonStore<T extends object> {
  private data: T
  /** Set when this process found the file unreadable and moved it aside: what it holds now is defaults (backlog 224). */
  quarantinedAt?: number

  constructor(
    private readonly path: string,
    defaults: T
  ) {
    this.data = structuredClone(defaults)
    this.load()
  }

  load(): void {
    try {
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path, 'utf-8')
        this.data = { ...this.data, ...(JSON.parse(raw) as Partial<T>) }
      }
    } catch (err) {
      // Do NOT continue with defaults over a file that exists but will not
      // parse: the next save() would overwrite the only copy of the ledger.
      // Move it aside so it can be recovered by hand.
      console.warn(`[json-store] load failed for ${this.path}:`, err)
      this.quarantinedAt = Date.now()
      try {
        if (existsSync(this.path)) renameSync(this.path, `${this.path}.corrupt-${this.quarantinedAt}`)
      } catch (moveErr) {
        console.warn('[json-store] could not quarantine corrupt file:', moveErr)
      }
    }
  }

  save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      // Write-then-rename: a crash mid-write leaves the previous complete
      // file in place instead of a truncated one.
      const tmp = `${this.path}.tmp`
      // flush: the rename can land before the data does; a power loss then leaves a zero-length file (audit
      // 2026-09-19, B-31). The settings writer has flushed since round 1; the ledgers did not.
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf-8', flush: true })
      renameSync(tmp, this.path)
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
