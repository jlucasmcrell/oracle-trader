import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Same-directory replacement keeps the previous complete file through a failed write. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf8', flush: true })
  renameSync(tmp, path)
}

/** Minimal JSON-file persistence for a single mutable object. */
export class JsonStore<T extends object> {
  private data: T

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
      console.warn('[json-store] load failed:', err)
      try {
        if (existsSync(this.path)) renameSync(this.path, `${this.path}.corrupt-${Date.now()}`)
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
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      renameSync(tmp, this.path)
    } catch (err) {
      console.warn('[json-store] save failed:', err)
    }
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
