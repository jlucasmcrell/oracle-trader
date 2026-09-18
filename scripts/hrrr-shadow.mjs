// HRRR vs NBM daily-high shadow test (no trading, no keys, free endpoints only).
//
//   node scripts/hrrr-shadow.mjs           collect forecasts for every station and grade yesterday
//   node scripts/hrrr-shadow.mjs report    compare the models on graded station-days
//
// Question under test (Gemini audit 2026-09-07): does the hourly HRRR model know
// the day's high earlier or better than the NWS blend the quoter prices from?
// Open-Meteo serves both HRRR (gfs_hrrr) and the National Blend (ncep_nbm_conus,
// the basis of NWS point forecasts) free for non-commercial use. Each run stores
// both models' forecast high for the station's local day; the next day the
// station's NWS observations grade it. Read the report after two weeks.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getJsonWithDnsFallback, PUBLIC_RESOLVERS } from './lib/dns-fallback.mjs'

const OUT_DIR = join(process.cwd(), 'data', 'hrrr-shadow')
const FORECASTS = join(OUT_DIR, 'forecasts.jsonl')
const GRADES = join(OUT_DIR, 'grades.jsonl')
const UA = 'oracle-trader hrrr-shadow (research; contact via repository)'

// Kalshi station → coordinates, time zone, NWS station id (the airport the market measures at).
const STATIONS = {
  NYC: [40.78, -73.97, 'America/New_York', 'KNYC'],
  EWR: [40.69, -74.17, 'America/New_York', 'KEWR'],
  TTN: [40.28, -74.81, 'America/New_York', 'KTTN'],
  PHIL: [39.87, -75.24, 'America/New_York', 'KPHL'],
  BOS: [42.36, -71.01, 'America/New_York', 'KBOS'],
  DC: [38.85, -77.04, 'America/New_York', 'KDCA'],
  ATL: [33.64, -84.43, 'America/New_York', 'KATL'],
  DET: [42.21, -83.35, 'America/New_York', 'KDTW'],
  SDF: [38.17, -85.74, 'America/New_York', 'KSDF'],
  DAL: [32.9, -97.04, 'America/Chicago', 'KDFW'],
  HOU: [29.65, -95.28, 'America/Chicago', 'KHOU'],
  AUS: [30.19, -97.67, 'America/Chicago', 'KAUS'],
  SATX: [29.53, -98.47, 'America/Chicago', 'KSAT'],
  NOLA: [29.99, -90.25, 'America/Chicago', 'KMSY'],
  CHI: [41.79, -87.75, 'America/Chicago', 'KMDW'],
  KC: [39.3, -94.71, 'America/Chicago', 'KMCI'],
  MSP: [44.88, -93.22, 'America/Chicago', 'KMSP'],
  OKC: [35.39, -97.6, 'America/Chicago', 'KOKC'],
  DEN: [39.86, -104.67, 'America/Denver', 'KDEN'],
  PHX: [33.43, -112.01, 'America/Phoenix', 'KPHX'],
  LAX: [33.94, -118.41, 'America/Los_Angeles', 'KLAX'],
  SFO: [37.62, -122.38, 'America/Los_Angeles', 'KSFO'],
  SEA: [47.45, -122.31, 'America/Los_Angeles', 'KSEA'],
  PDX: [45.59, -122.6, 'America/Los_Angeles', 'KPDX'],
  LAS: [36.08, -115.15, 'America/Los_Angeles', 'KLAS'],
  SAN: [32.73, -117.19, 'America/Los_Angeles', 'KSAN'],
  MIA: [25.79, -80.29, 'America/New_York', 'KMIA']
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`)

function localParts(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value])
  )
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) }
}

/** Local calendar date shifted by n days (string arithmetic on the local date; DST-safe). */
function shiftDate(date, n) {
  const [y, m, d] = date.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d + n, 12)
  return new Date(t).toISOString().slice(0, 10)
}

/** UTC instant of local midnight for a date in a zone (searches the offset; good enough for the US zones). */
function localMidnightUtc(date, tz) {
  const [y, m, d] = date.split('-').map(Number)
  for (const offsetH of [4, 5, 6, 7, 8]) {
    const guess = Date.UTC(y, m - 1, d, offsetH)
    if (localParts(guess, tz).date === date && localParts(guess, tz).hour === 0) return guess
  }
  return Date.UTC(y, m - 1, d, 5)
}

async function getJson(url) {
  // The router answered NXDOMAIN for api.open-meteo.com from 2026-09-17T08:20Z and
  // the shadow silently collected nothing for three hours; the fallback is scoped to
  // this process (see scripts/lib/dns-fallback.mjs).
  return getJsonWithDnsFallback(url, {
    headers: { 'User-Agent': UA, Accept: 'application/geo+json, application/json' },
    timeoutMs: 20_000,
    onFallback: (host) => log(`${host}: system resolver failed, retrying via ${PUBLIC_RESOLVERS.join('/')}`)
  })
}

function readRows(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

async function collect() {
  mkdirSync(OUT_DIR, { recursive: true })
  const now = Date.now()
  let ok = 0
  for (const [station, [lat, lon, tz]] of Object.entries(STATIONS)) {
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m` +
        `&models=gfs_hrrr,ncep_nbm_conus&temperature_unit=fahrenheit&timezone=${encodeURIComponent(tz)}&forecast_days=2`
      const d = await getJson(url)
      const h = d.hourly ?? {}
      const times = h.time ?? []
      const hrrr = h.temperature_2m_gfs_hrrr ?? []
      const nbm = h.temperature_2m_ncep_nbm_conus ?? []
      const { date, hour } = localParts(now, tz)
      const maxOf = (arr, pred) => {
        let m = null
        times.forEach((t, i) => {
          if (!t.startsWith(date) || !pred(Number(t.slice(11, 13))) || typeof arr[i] !== 'number') return
          m = m === null ? arr[i] : Math.max(m, arr[i])
        })
        return m
      }
      const row = {
        at: new Date(now).toISOString(),
        station,
        localDate: date,
        localHour: hour,
        hrrrMaxDay: maxOf(hrrr, () => true),
        nbmMaxDay: maxOf(nbm, () => true),
        hrrrMaxRemaining: maxOf(hrrr, (hh) => hh >= hour),
        nbmMaxRemaining: maxOf(nbm, (hh) => hh >= hour)
      }
      appendFileSync(FORECASTS, JSON.stringify(row) + '\n')
      ok++
    } catch (e) {
      log(`${station}: forecast failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    await sleep(250)
  }
  log(`forecasts stored for ${ok}/${Object.keys(STATIONS).length} stations`)
}

async function grade() {
  const have = new Set(readRows(GRADES).map((g) => `${g.station}|${g.localDate}`))
  const now = Date.now()
  let ok = 0
  for (const [station, [, , tz, icao]] of Object.entries(STATIONS)) {
    const yesterday = shiftDate(localParts(now, tz).date, -1)
    if (have.has(`${station}|${yesterday}`)) continue
    try {
      const start = localMidnightUtc(yesterday, tz)
      const end = localMidnightUtc(shiftDate(yesterday, 1), tz)
      const d = await getJson(
        `https://api.weather.gov/stations/${icao}/observations?start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}&limit=500`
      )
      const temps = (d.features ?? [])
        .map((f) => f.properties?.temperature?.value)
        .filter((v) => typeof v === 'number')
      if (temps.length < 12) {
        log(`${station} ${yesterday}: only ${temps.length} observations; grading later`)
        continue
      }
      const obsMaxF = Math.round((Math.max(...temps) * 9) / 5 + 32)
      appendFileSync(GRADES, JSON.stringify({ station, localDate: yesterday, obsMaxF, n: temps.length, gradedAt: new Date(now).toISOString() }) + '\n')
      ok++
    } catch (e) {
      log(`${station} ${yesterday}: grade failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    await sleep(400)
  }
  log(`graded ${ok} station-days`)
}

function report(issueHour = 9) {
  const grades = new Map(readRows(GRADES).map((g) => [`${g.station}|${g.localDate}`, g.obsMaxF]))
  // The forecast issued at the first run at or after the issue hour, per station-day.
  const issued = new Map()
  for (const r of readRows(FORECASTS).sort((a, b) => a.at.localeCompare(b.at))) {
    const k = `${r.station}|${r.localDate}`
    if (r.localHour >= issueHour && !issued.has(k)) issued.set(k, r)
  }
  const errs = { hrrr: [], nbm: [] }
  let hrrrCloser = 0
  let nbmCloser = 0
  let ties = 0
  for (const [k, r] of issued) {
    const obs = grades.get(k)
    if (obs === undefined || typeof r.hrrrMaxDay !== 'number' || typeof r.nbmMaxDay !== 'number') continue
    const eh = r.hrrrMaxDay - obs
    const en = r.nbmMaxDay - obs
    errs.hrrr.push(eh)
    errs.nbm.push(en)
    if (Math.abs(eh) < Math.abs(en)) hrrrCloser++
    else if (Math.abs(en) < Math.abs(eh)) nbmCloser++
    else ties++
  }
  const stat = (a) => (a.length ? { n: a.length, mae: (a.reduce((s, x) => s + Math.abs(x), 0) / a.length).toFixed(2), bias: (a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) } : { n: 0 })
  console.log(`HRRR vs NBM daily-high forecasts issued at/after ${issueHour}:00 local, graded by NWS station observations`)
  console.log('  HRRR', stat(errs.hrrr))
  console.log('  NBM ', stat(errs.nbm))
  console.log(`  closer: HRRR ${hrrrCloser}, NBM ${nbmCloser}, ties ${ties}`)
  if (errs.hrrr.length < 100) console.log('  (fewer than 100 graded station-days: keep collecting before drawing a conclusion)')
}

const mode = process.argv[2] ?? 'collect'
if (mode === 'report') report(Number(process.argv[3] ?? 9))
else {
  await collect()
  await grade()
}
