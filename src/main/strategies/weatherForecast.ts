/**
 * Forecast-derived fair value for Kalshi daily temperature brackets.
 *
 * Why: the venue ledger (2026-09-06 audit, 147 settlements) shows the passive
 * weather quoter losing 3.9c per contract while its 5–15 minute markouts are
 * positive — it is not being picked off in the microstructure, it is quoting
 * around a midpoint that people with a forecast know is wrong over hours.
 * Quoting around a forecast-derived probability removes that mismatch.
 *
 * Source: the National Weather Service hourly forecast (api.weather.gov; free,
 * no key, a User-Agent is required) at the settlement station. The day's
 * extreme is modelled as Normal(mu, sigma): mu is the larger of the observed
 * running high and the forecast high of the remaining hours (smaller of the
 * two for lows); sigma starts near the day-ahead forecast error (~3°F) and
 * shrinks as the forming window passes, never below the ~1°F station/report
 * noise. Brackets settle on integer °F, so the continuous distribution is
 * evaluated at half-degree edges.
 */
import { localDate, stationTimeZone } from './weatherDay'

/** Settlement stations by Kalshi station code → [lat, lon] (airport / climate site). */
export const STATION_COORDS: Record<string, [number, number]> = {
  NYC: [40.78, -73.97],
  EWR: [40.69, -74.17],
  TTN: [40.28, -74.81],
  PHIL: [39.87, -75.24],
  PHL: [39.87, -75.24],
  BOS: [42.36, -71.01],
  DC: [38.85, -77.04],
  ATL: [33.64, -84.43],
  DET: [42.21, -83.35],
  DTW: [42.21, -83.35],
  SDF: [38.17, -85.74],
  DAL: [32.9, -97.04],
  DFW: [32.9, -97.04],
  HOU: [29.65, -95.28],
  AUS: [30.19, -97.67],
  SATX: [29.53, -98.47],
  SAN: [32.73, -117.19],
  NOLA: [29.99, -90.25],
  CHI: [41.79, -87.75],
  KC: [39.3, -94.71],
  MCI: [39.3, -94.71],
  MSP: [44.88, -93.22],
  MIN: [44.88, -93.22],
  OKC: [35.39, -97.6],
  DEN: [39.86, -104.67],
  PHX: [33.43, -112.01],
  LAX: [33.94, -118.41],
  SFO: [37.62, -122.38],
  SF: [37.62, -122.38],
  SEA: [47.45, -122.31],
  PDX: [45.59, -122.6],
  LAS: [36.08, -115.15],
  MIA: [25.79, -80.29]
}

export interface HourlyForecast {
  updatedAt: number
  periods: { start: number; temp: number }[]
}

const HEADERS = { 'User-Agent': 'oracle-trader (weather fair value; contact via repository)', Accept: 'application/geo+json' }
const urlCache = new Map<string, string>()
const forecastCache = new Map<string, { at: number; f: HourlyForecast }>()
export const FORECAST_TTL_MS = 30 * 60_000

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return (await res.json()) as T
}

/** NWS hourly forecast for a station (cached 30 minutes). Null when the station is unknown or the service fails. */
export async function fetchHourlyForecast(station: string, nowMs = Date.now()): Promise<HourlyForecast | null> {
  const coords = STATION_COORDS[station]
  if (!coords) return null
  const cached = forecastCache.get(station)
  if (cached && nowMs - cached.at < FORECAST_TTL_MS) return cached.f
  try {
    let url = urlCache.get(station)
    if (!url) {
      const p = await getJson<{ properties?: { forecastHourly?: string } }>(`https://api.weather.gov/points/${coords[0]},${coords[1]}`)
      url = p.properties?.forecastHourly
      if (!url) return null
      urlCache.set(station, url)
    }
    const f = await getJson<{ properties?: { updateTime?: string; periods?: { startTime: string; temperature: number; temperatureUnit?: string }[] } }>(url)
    const periods = (f.properties?.periods ?? [])
      .map((x) => ({ start: Date.parse(x.startTime), temp: x.temperatureUnit === 'C' ? (x.temperature * 9) / 5 + 32 : x.temperature }))
      .filter((x) => Number.isFinite(x.start) && Number.isFinite(x.temp))
    if (periods.length === 0) return null
    const out = { updatedAt: f.properties?.updateTime ? Date.parse(f.properties.updateTime) : nowMs, periods }
    forecastCache.set(station, { at: nowMs, f: out })
    return out
  } catch {
    // Keep a stale forecast rather than nothing: the service rate-limits and hiccups.
    return cached?.f ?? null
  }
}

/** Forecast max/min over the event day's remaining hours (the last elapsed hour included, since its extreme may not be banked yet). */
export function remainingExtremes(f: HourlyForecast, eventDate: string, tz: string, nowMs: number): { max: number; min: number; hours: number } | null {
  const rows = f.periods.filter((p) => p.start >= nowMs - 3600_000 && localDate(p.start, tz) === eventDate)
  if (rows.length === 0) return null
  return { max: Math.max(...rows.map((r) => r.temp)), min: Math.min(...rows.map((r) => r.temp)), hours: rows.length }
}

/** Forecast error (°F) as the day's extreme forms: ~3°F a day out, ~1°F once the window has passed. */
export function forecastSigma(hoursRemaining: number): number {
  return Math.max(0.9, Math.min(3.0, 0.9 + 0.09 * hoursRemaining))
}

export function normalCdf(z: number): number {
  // Abramowitz–Stegun 7.1.26 via erf; accurate to ~1e-7.
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2)
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y)
}

/**
 * P(bracket settles YES) for the day's extreme ~ Normal(mu, sigma), on integer
 * °F outcomes: "between" is inclusive of both ends, "greater" and "less" are
 * strict (per the venue's contract terms).
 */
export function bracketFairValue(kind: 'high' | 'low', strikeType: string | undefined, floor: number | undefined, cap: number | undefined, mu: number, sigma: number): number | null {
  void kind
  const s = Math.max(0.3, sigma)
  const t = (strikeType ?? '').toLowerCase()
  const F = (x: number): number => normalCdf((x - mu) / s)
  if (t === 'between' && floor !== undefined && cap !== undefined) return F(cap + 0.5) - F(floor - 0.5)
  // Polymarket US grammar: "gte K" (X >= K) and "lt K" (X < K) on integer °F.
  if (t === 'gte') {
    const k = floor ?? cap
    return k === undefined ? null : 1 - F(k - 0.5)
  }
  if (t === 'lt') {
    const k = cap ?? floor
    return k === undefined ? null : F(k - 0.5)
  }
  if (t === 'greater' || t === 'greater_than' || t === 'above') {
    const k = floor ?? cap
    return k === undefined ? null : 1 - F(k + 0.5)
  }
  if (t === 'less' || t === 'less_than' || t === 'below') {
    const k = cap ?? floor
    return k === undefined ? null : F(k - 0.5)
  }
  return null
}

const r2 = (x: number): number => Math.round(x * 100) / 100

/** Polymarket US temperature slug → station (Kalshi code), kind, day and strike. */
export interface UsTempMarket {
  station: string
  kind: 'high' | 'low'
  eventDate: string
  strikeType: 'between' | 'gte' | 'lt'
  floor?: number
  cap?: number
}
const US_STATION_ALIAS: Record<string, string> = {
  mia: 'MIA', mdw: 'CHI', chi: 'CHI', lax: 'LAX', nyc: 'NYC', jfk: 'NYC', lga: 'NYC', den: 'DEN', sfo: 'SFO', sea: 'SEA',
  phl: 'PHIL', dca: 'DC', bos: 'BOS', atl: 'ATL', hou: 'HOU', iah: 'HOU', dfw: 'DAL', dal: 'DAL', phx: 'PHX', las: 'LAS',
  msp: 'MIN', aus: 'AUS', sat: 'SATX', san: 'SAN', msy: 'NOLA', mci: 'MCI', okc: 'OKC', pdx: 'PDX', det: 'DET', dtw: 'DET',
  sdf: 'SDF', ewr: 'EWR'
}
/** e.g. tc-temp-miahigh-2026-08-30-gte87lt88f, tc-temp-nychigh-2026-08-30-lt82f, tc-temp-laxlow-2026-09-01-gte70f */
export function parseUsTempSlug(slug: string): UsTempMarket | null {
  const m = /^tc-temp-([a-z]+?)(high|low)-(\d{4}-\d{2}-\d{2})-(?:gte(\d+))?(?:lt(\d+))?f$/.exec(slug.toLowerCase())
  if (!m) return null
  const station = US_STATION_ALIAS[m[1]]
  if (!station) return null
  const kind = m[2] as 'high' | 'low'
  const gte = m[4] !== undefined ? Number(m[4]) : undefined
  const lt = m[5] !== undefined ? Number(m[5]) : undefined
  if (gte !== undefined && lt !== undefined) return { station, kind, eventDate: m[3], strikeType: 'between', floor: gte, cap: lt - 1 }
  if (gte !== undefined) return { station, kind, eventDate: m[3], strikeType: 'gte', floor: gte }
  if (lt !== undefined) return { station, kind, eventDate: m[3], strikeType: 'lt', cap: lt }
  return null
}

/**
 * Forecast-only fair value for a Polymarket US temperature market (no venue
 * minute index here, so the observed running extreme is not folded in; the
 * error term is widened while the event day is running).
 */
export async function usWeatherFairValue(t: UsTempMarket, nowMs = Date.now()): Promise<{ fair: number; mu: number; sigma: number; hours: number } | null> {
  const tz = stationTimeZone('KXHIGHT' + t.station)
  if (!tz) return null
  const fc = await fetchHourlyForecast(t.station, nowMs)
  if (!fc) return null
  const ext = remainingExtremes(fc, t.eventDate, tz, nowMs)
  if (!ext) return null
  const active = localDate(nowMs, tz) === t.eventDate
  const mu = t.kind === 'high' ? ext.max : ext.min
  const sigma = Math.max(active ? 1.5 : 0, forecastSigma(ext.hours))
  const fair = bracketFairValue(t.kind, t.strikeType, t.floor, t.cap, mu, sigma)
  if (fair === null || !Number.isFinite(fair)) return null
  return { fair: Math.min(0.98, Math.max(0.02, fair)), mu, sigma, hours: ext.hours }
}

/**
 * Two-sided quotes around a fair value: bid = fair − margin, ask = fair + margin
 * (both leaned one cent per held contract against inventory), each side
 * placed only if it still improves the book without giving up the margin —
 * never buy above fair, never sell below it.
 */
export function quoteAroundFair(fair: number, bestBid: number, bestAsk: number, marginCents: number, inv: number, maxInv: number): { bid: number | null; ask: number | null } {
  const m = Math.max(0.01, marginCents / 100)
  const center = fair - inv * 0.01
  let bid: number | null = r2(center - m)
  let ask: number | null = r2(center + m)
  // Join the best level when the margin lands exactly there; only a quote
  // that would sit BEHIND the best level is dropped (2026-09-07: demanding a
  // one-cent improvement left tight books unquoted).
  if (inv >= maxInv || bid < bestBid - 1e-9) bid = null
  else bid = r2(Math.min(bid, bestAsk - 0.01))
  if (inv <= -maxInv || ask > bestAsk + 1e-9) ask = null
  else ask = r2(Math.max(ask, bestBid + 0.01))
  if (bid !== null && (bid <= 0.01 || bid >= 0.99)) bid = null
  if (ask !== null && (ask <= 0.01 || ask >= 0.99)) ask = null
  return { bid, ask }
}
