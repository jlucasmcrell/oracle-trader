import { appendFile, stat } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Episode recorder: append-only JSONL archive of the market data the
 * scanners already fetch (book snapshots, fills, exits, settlements).
 * The 30s polling budget is already spent — persisting it is what turns it
 * into replay-grade backtest depth and the tape a queue-position model
 * needs. One file per venue per local day; recording failures never touch
 * the trading path.
 */
export class EpisodeRecorder {
  private sizeCache = new Map<string, { bytes: number; checkedAt: number }>()

  constructor(
    private readonly dir: string,
    /** Per-day per-venue file cap — recording stops for the day past this. */
    private readonly maxBytesPerFile = 64 * 1024 * 1024
  ) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // unwritable dir → every append will no-op below
    }
  }

  /** Fire-and-forget append; ts is stamped here. */
  /**
   * rest/amend/pull/reject are the maker order lifecycle. Without them the
   * live maker fill rate — the number that decides whether a paper edge
   * survives adverse selection — was unmeasurable forward, forever.
   */
  record(
    venue: string,
    kind: 'book' | 'entry' | 'exit' | 'settle' | 'anchor' | 'rest' | 'amend' | 'pull' | 'reject' | 'orphan-ledger' | 'ratchet-refused' | 'scan',
    payload: Record<string, unknown>
  ): void {
    const day = localDay()
    const file = join(this.dir, `${venue}-${day}.jsonl`)
    const cached = this.sizeCache.get(file)
    if (cached && cached.bytes >= this.maxBytesPerFile) return
    const line = JSON.stringify({ ts: Date.now(), kind, ...payload }) + '\n'
    void appendFile(file, line, 'utf8')
      .then(async () => {
        // Refresh the size guard at most once a minute per file.
        const now = Date.now()
        if (!cached || now - cached.checkedAt > 60_000) {
          const s = await stat(file).catch(() => undefined)
          if (s) this.sizeCache.set(file, { bytes: s.size, checkedAt: now })
        }
      })
      .catch(() => undefined)
  }
}

function localDay(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
