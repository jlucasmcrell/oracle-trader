/**
 * Binding of live temperature observations to the contract they can decide.
 *
 * Kalshi's city temperature index (GET /live_data/weather/{city}) serves the
 * last few hours of minute readings for the CITY, regardless of which event
 * asked for it. A daily high/low contract, however, is decided only by
 * readings inside its own measurement day in the station's local time zone.
 * Two ways the unfiltered index produced false verdicts:
 *  - tomorrow's event (already listed, 24–48h out) banked today's running
 *    high, marking tomorrow's brackets "decided" before its day began;
 *  - a series spanning local midnight leaked yesterday's extreme into today.
 * Everything here is pure so the boundaries can be unit-tested.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** Station code → IANA time zone for Kalshi temperature series (KXHIGHT<code> / KXLOWT<code>, with or without the T). */
const STATION_TZ: Record<string, string> = {
  MIA: 'America/New_York',
  NYC: 'America/New_York',
  EWR: 'America/New_York',
  TTN: 'America/New_York',
  PHIL: 'America/New_York',
  PHL: 'America/New_York',
  BOS: 'America/New_York',
  DC: 'America/New_York',
  ATL: 'America/New_York',
  DET: 'America/New_York',
  DTW: 'America/New_York',
  SDF: 'America/New_York',
  DAL: 'America/Chicago',
  DFW: 'America/Chicago',
  HOU: 'America/Chicago',
  AUS: 'America/Chicago',
  SATX: 'America/Chicago',
  SAN: 'America/Los_Angeles',
  NOLA: 'America/Chicago',
  CHI: 'America/Chicago',
  KC: 'America/Chicago',
  MCI: 'America/Chicago',
  MSP: 'America/Chicago',
  MIN: 'America/Chicago',
  OKC: 'America/Chicago',
  DEN: 'America/Denver',
  PHX: 'America/Phoenix',
  LAX: 'America/Los_Angeles',
  SFO: 'America/Los_Angeles',
  SF: 'America/Los_Angeles',
  SEA: 'America/Los_Angeles',
  PDX: 'America/Los_Angeles',
  LAS: 'America/Los_Angeles'
}

export interface Observation {
  timestamp: number
  price: number
}

/** Station code from a temperature ticker (event or market): KXHIGHTMIA-26SEP06-B90.5 → MIA. */
export function stationCode(ticker: string): string | null {
  const m = /^KX(?:HIGHT?|LOWT?)([A-Z]+)$/.exec(ticker.toUpperCase().split('-')[0] ?? '')
  return m ? m[1] : null
}

export function stationTimeZone(ticker: string): string | null {
  const code = stationCode(ticker)
  return code ? STATION_TZ[code] ?? null : null
}

/** Contract measurement day from the ticker's date segment: 26SEP06 → 2026-09-06. */
export function parseEventDate(ticker: string): string | null {
  const seg = ticker.toUpperCase().split('-')[1] ?? ''
  const m = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(seg)
  if (!m) return null
  const mon = MONTHS.indexOf(m[2])
  if (mon < 0) return null
  return `20${m[1]}-${String(mon + 1).padStart(2, '0')}-${m[3]}`
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()

/** Calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(ts: number, tz: string): string {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    fmtCache.set(tz, f)
  }
  return f.format(new Date(ts))
}

/** Whether the contract's measurement day is still ahead, running now, or over. */
export function eventDayStatus(eventDate: string, tz: string, nowMs: number): 'future' | 'active' | 'past' {
  const today = localDate(nowMs, tz)
  if (today < eventDate) return 'future'
  if (today > eventDate) return 'past'
  return 'active'
}

/** Running extreme over the observations that fall inside the contract's day; null when none do. */
export function bankObservations(series: Observation[], eventDate: string, tz: string): { hi: number; lo: number; n: number } | null {
  let hi = -Infinity
  let lo = Infinity
  let n = 0
  for (const p of series) {
    if (!Number.isFinite(p.price) || !Number.isFinite(p.timestamp)) continue
    if (localDate(p.timestamp, tz) !== eventDate) continue
    if (p.price > hi) hi = p.price
    if (p.price < lo) lo = p.price
    n++
  }
  return n > 0 ? { hi, lo, n } : null
}
