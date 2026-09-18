/**
 * Records what the anti-flood per-series cap THREW AWAY, so its cost can be measured instead of argued.
 *
 * The cap in `kalshi.ts` keeps the top 3 markets per series by 24h volume (40 for GAME series) and rescues
 * anything in the fade band. Everything else is gone before `buildUniverse` runs, so it never becomes a
 * candidate, never reaches `entryBlocked`, and cannot be enrolled in the veto watch even in principle. That
 * is why the 2026-09-12 throttle audit could only say "we cannot know" about it: a culled market leaves no
 * trace anywhere in the system.
 *
 * This leaves a trace. It is PURELY OBSERVATIONAL - nothing here changes which markets the cap keeps.
 *
 * Division of labour: the recorder OBSERVES and the grader JUDGES. Rows carry raw quotes and volumes rather
 * than a verdict, so `scripts/cull-gate.mjs` can apply any strategy's entry rule after the fact without the
 * recorder having to duplicate thresholds that live in the trader - the kind of copy that drifts silently.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface CulledRow {
  ts: number
  ticker: string
  /** Series key the cap grouped on - the same key it ranked within. */
  key: string
  /** Rank in the 24h-volume sort the cap used; the cut is at 3 (40 for GAME series). */
  rank: number
  /** Candidates in this series, so a rank reads against the size of what was discarded. */
  seriesSize: number
  yb: number
  ya: number
  vol24: number
  oi: number
  close?: string
}

/**
 * One UTC day of tickers already recorded. In memory only, and deliberately so: a restart re-records a
 * market at a fresh quote, which costs a duplicate row and buys independence from yet another on-disk cache
 * of the kind that silently starved the hunch collector. The grader dedups on (day, ticker).
 */
let seen = new Set<string>()
let seenDay = ''
/** Rows already recorded per series today, for the per-series share cap. */
let perSeries = new Map<string, number>()

/**
 * Where rows go. Injected at startup rather than read from `app.getPath` here, because `kalshi.ts` calls
 * this and is imported by the test suite - pulling electron into the venue adapter would break every test
 * that touches it. Unset means inert, which is exactly what a test wants.
 */
let cullDir: string | undefined
export function setCullDir(dir: string): void {
  cullDir = dir
}

/**
 * A culled market has to clear this to be worth recording. The first live scan produced 19,399 rows, and
 * grading them means one settlement lookup each against the endpoint the live trader shares — about an hour
 * per run. Volume is the honest filter: a market nobody traded in 24h had no counterparty, so "the cap
 * discarded it" is not a cost. The audit saw the same shape (2,204 of 2,796 culled had zero 24h volume).
 */
const MIN_VOL24 = 10
/** Per series per day. One series (KXNCAAFSPREAD, 1,912 rows) would otherwise dominate the whole sample. */
const MAX_PER_SERIES = 40

/** Appends at most one line per ticker per UTC day. Never throws into the scan path. */
export function recordCulled(rows: CulledRow[]): void {
  const dir = cullDir
  if (dir === undefined || rows.length === 0) return
  try {
    const day = new Date().toISOString().slice(0, 10)
    if (day !== seenDay) {
      seen = new Set()
      perSeries = new Map()
      seenDay = day
    }
    // Counted exactly rather than by subtraction: a row can be both already-seen and thin, and a sloppy
    // difference would misreport how much of the population this sample leaves out.
    const fresh: CulledRow[] = []
    let thin = 0
    let seriesFull = 0
    for (const r of rows) {
      if (seen.has(r.ticker)) continue
      if (r.vol24 < MIN_VOL24) {
        thin++
        continue
      }
      // Bound each series' share. Counted against what is already recorded TODAY, not just this scan, or
      // the cap would reset every few minutes and bound nothing. Deliberately NOT added to `seen`: a
      // market's volume can rise later, and a series that is full today starts fresh tomorrow.
      const held = perSeries.get(r.key) ?? 0
      if (held >= MAX_PER_SERIES) {
        seriesFull++
        continue
      }
      perSeries.set(r.key, held + 1)
      seen.add(r.ticker)
      fresh.push(r)
    }
    if (fresh.length === 0) return
    // Never truncate silently: a bounded sample that reads as a complete one is how a partial measurement
    // gets quoted as a total. Logged only alongside rows actually recorded, so a full day stays quiet.
    console.log(`[cull] recorded ${fresh.length}; skipped ${thin} under vol24 ${MIN_VOL24}, ${seriesFull} over the ${MAX_PER_SERIES}/series/day cap`)
    mkdirSync(dir, { recursive: true })
    // One append for the whole scan: this runs inside the market fetch, and a syscall per culled market
    // would put thousands of them on the scan's critical path.
    appendFileSync(join(dir, `${day}.jsonl`), fresh.map((r) => JSON.stringify(r)).join('\n') + '\n')
  } catch {
    // Observation must never break trading.
  }
}

/** Test seam: forget what has been recorded today, and go inert again. */
export function resetCullRecorder(): void {
  seen = new Set()
  perSeries = new Map()
  seenDay = ''
  cullDir = undefined
}
