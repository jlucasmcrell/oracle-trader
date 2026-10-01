// Read-only, offline: replay the metaculus-shadow event matcher over the LAST run's own artefacts
// (data/metaculus-shadow/last-mc.json, last-kalshi.json) and answer BACKLOG 256 option (b):
// among Metaculus questions resolving inside N days, does ANY Kalshi event match at the registered bar?
//
//     node scripts/backtests/metaculus_matcher_read.mjs
//
// Written 2026-10-01 to decide build-queue item 10 rather than defer it for a tenth day. It is the
// evidence behind that item's retirement (REVIEW-CHANGES section 176): the matcher is reproduced here
// token for token from scripts/metaculus-shadow.cjs (STOP, tokens(), idf, the score bar) so the answer
// is about the shipped rule and not about a paraphrase of it. Re-run it on a later pair of artefacts
// before re-opening the item; the two numbers that decide it are "questions resolving within 90 days"
// and how many of those clear the event-match bar.
// No network, no writes outside stdout.
import { readFileSync } from 'node:fs'

const DIR = 'data/metaculus-shadow'
const mc = JSON.parse(readFileSync(`${DIR}/last-mc.json`, 'utf8'))
const events = JSON.parse(readFileSync(`${DIR}/last-kalshi.json`, 'utf8'))

const STOP = new Set(
  'will the be a an of in on by to before after at for and or is than more less this that does do who what which with from as it its s not any have has been are was were over under above below during end year next new first last per each any all both either between into out about again there here when where how also than then them they their his her him she he you your our we us can could would should may might must shall'.split(' ')
)
const tokens = (title) =>
  new Set(
    String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w) && !/^20[0-9][0-9]$/.test(w))
  )

const et = events.map((e) => ({ ...e, tok: tokens(e.title) }))
const df = new Map()
for (const e of et) for (const w of e.tok) df.set(w, (df.get(w) || 0) + 1)
const idf = (w) => Math.log((et.length + 1) / ((df.get(w) || 0) + 1))

const now = Date.now()
const days = (ms) => (ms - now) / 86400000

console.log(`metaculus open binary questions in the last listing: ${mc.length}`)
console.log(`kalshi open non-sports events in the last listing:   ${et.length}`)
const withR = mc.filter((q) => Number.isFinite(q.resolveAt))
console.log(`questions with a scheduled_resolve_time: ${withR.length}`)
const buckets = [7, 30, 90, 180, 365, 730, 1e9]
let prev = -1e9
for (const b of buckets) {
  const n = withR.filter((q) => days(q.resolveAt) > prev && days(q.resolveAt) <= b).length
  console.log(`  resolving in (${prev === -1e9 ? '-inf' : prev}, ${b === 1e9 ? 'inf' : b}] days: ${n}`)
  prev = b
}

function bestEvent(q) {
  const qt = tokens(q.title)
  if (qt.size < 3) return null
  const qWeight = [...qt].reduce((s, w) => s + idf(w), 0) || 1
  let best = null
  for (const e of et) {
    const shared = [...qt].filter((w) => e.tok.has(w) && idf(w) > 1)
    if (shared.length < 2) continue
    const score = shared.reduce((s, w) => s + idf(w), 0) / qWeight
    if (!(score >= 0.85 || (score >= 0.6 && shared.length >= 3))) continue
    if (!best || score > best.score) best = { e, score, shared }
  }
  return best
}

for (const horizon of [30, 90, 180]) {
  const near = withR.filter((q) => days(q.resolveAt) > 0 && days(q.resolveAt) <= horizon)
  const matched = near.map((q) => ({ q, best: bestEvent(q) })).filter((x) => x.best)
  console.log(`\n=== questions resolving within ${horizon} days: ${near.length}; clearing the event-match bar: ${matched.length} ===`)
  for (const { q, best } of matched) {
    console.log(`  d+${days(q.resolveAt).toFixed(0).padStart(3)}  score ${best.score.toFixed(2)}  ${best.e.eventTicker}`)
    console.log(`        mc: ${q.title.slice(0, 110)}`)
    console.log(`        kx: ${best.e.title.slice(0, 110)}`)
    console.log(`        shared: ${best.shared.join(', ')}`)
  }
}

// What the matcher DOES find, for contrast: every question that clears the bar at any horizon.
const all = withR.map((q) => ({ q, best: bestEvent(q) })).filter((x) => x.best)
console.log(`\nquestions clearing the bar at ANY horizon: ${all.length}`)
const hist = new Map()
for (const { q } of all) {
  const d = days(q.resolveAt)
  const k = d <= 30 ? '<=30d' : d <= 90 ? '31-90d' : d <= 365 ? '91-365d' : d <= 730 ? '1-2y' : '>2y'
  hist.set(k, (hist.get(k) || 0) + 1)
}
console.log('  by horizon: ' + JSON.stringify(Object.fromEntries(hist)))
const noR = mc.filter((q) => !Number.isFinite(q.resolveAt))
console.log(`questions with NO scheduled_resolve_time: ${noR.length} (these can never pass the +-60d market check)`)
