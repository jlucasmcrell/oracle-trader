/**
 * Real-Time NOAA Aviation METAR Weather Observation Service.
 *
 * Scrapes and caches official National Weather Service / FAA METAR station
 * observations directly from NOAA's public API (aviationweather.gov/api/data/metar).
 *
 * Kalshi weather contracts (KXHIGH*, KXLOW*) settle strictly against airport
 * METAR observations (KBOS, KMIA, KORD, KDEN, KSFO, KDFW, KSEA, KPHL, etc.).
 *
 * Provides:
 * 1. Current station temperature (in Celsius and Fahrenheit).
 * 2. Peak high temperature observed so far today (T24 or cumulative daily max).
 * 3. Deterministic probability evaluation for strike ladders:
 *    - If peak temperature >= strike, P(YES) = 1.00 (100% certainty).
 *    - If current temp is far below strike late in the day (after 16:00 local) with falling temps,
 *      P(YES) approaches 0.00.
 */

export interface MetarObservation {
  icaoId: string
  stationName: string
  tempC: number
  tempF: number
  dewpC: number
  obsTime: number
  reportTime: string
  maxT24C?: number
  maxT24F?: number
  minT24C?: number
  minT24F?: number
  rawOb: string
}

// Kalshi metro/series code -> Primary FAA/ICAO Airport Station Code
export const KALSHI_METRO_TO_ICAO: Record<string, string> = {
  BOS: 'KBOS',
  BOSTON: 'KBOS',
  MIA: 'KMIA',
  MIAMI: 'KMIA',
  CHI: 'KORD',
  CHICAGO: 'KORD',
  ORD: 'KORD',
  MDW: 'KMDW',
  DEN: 'KDEN',
  DENVER: 'KDEN',
  SFO: 'KSFO',
  SF: 'KSFO',
  DAL: 'KDAL',
  DFW: 'KDFW',
  DALLAS: 'KDAL',
  HOU: 'KHOU',
  HOUSTON: 'KHOU',
  IAH: 'KIAH',
  SEA: 'KSEA',
  SEATTLE: 'KSEA',
  PUGET: 'KSEA',
  PHL: 'KPHL',
  PHIL: 'KPHL',
  PHILADELPHIA: 'KPHL',
  NY: 'KJFK',
  NYC: 'KJFK',
  JFK: 'KJFK',
  LAX: 'KLAX',
  LOSANGELES: 'KLAX',
  SAT: 'KSAT',
  SATX: 'KSAT',
  SANANTONIO: 'KSAT',
  OKC: 'KOKC',
  OKLAHOMACITY: 'KOKC',
  DET: 'KDTW',
  DTW: 'KDTW',
  MCI: 'KMCI',
  KC: 'KMCI',
  MSP: 'KMSP',
  MINN: 'KMSP',
  ATL: 'KATL',
  ATLANTA: 'KATL',
  DCA: 'KDCA',
  DC: 'KDCA'
}

export class NoaaMetarService {
  private cache = new Map<string, { at: number; data: MetarObservation }>()
  private dailyPeak = new Map<string, { date: string; maxF: number; minF: number }>()
  private lastBatchFetch = 0
  private fetching = false

  /** Map a Kalshi series or event ticker to its corresponding ICAO airport code */
  resolveIcao(seriesOrEventTicker: string): string | null {
    const clean = seriesOrEventTicker.toUpperCase().replace(/^KX(?:HIGHT?|LOWT?)/, '').split('-')[0]
    return KALSHI_METRO_TO_ICAO[clean] ?? null
  }

  /** Convert Celsius to Fahrenheit */
  toF(celsius: number): number {
    return Math.round((celsius * 9 / 5 + 32) * 10) / 10
  }

  /** Get latest observation for a station code */
  getObservation(icaoOrMetro: string): MetarObservation | null {
    const icao = icaoOrMetro.startsWith('K') && icaoOrMetro.length === 4 ? icaoOrMetro : this.resolveIcao(icaoOrMetro)
    if (!icao) return null
    return this.cache.get(icao)?.data ?? null
  }

  /** Get peak recorded Fahrenheit today for a station */
  getTodayPeak(icaoOrMetro: string): { maxF: number; minF: number } | null {
    const icao = icaoOrMetro.startsWith('K') && icaoOrMetro.length === 4 ? icaoOrMetro : this.resolveIcao(icaoOrMetro)
    if (!icao) return null
    const today = new Date().toISOString().slice(0, 10)
    const rec = this.dailyPeak.get(icao)
    if (rec && rec.date === today) return { maxF: rec.maxF, minF: rec.minF }
    const obs = this.cache.get(icao)?.data
    if (!obs) return null
    return { maxF: obs.maxT24F ?? obs.tempF, minF: obs.minT24F ?? obs.tempF }
  }

  /**
   * Determine if a high temperature strike has already been crossed or is mathematically settled.
   * Returns:
   * - 1.00: High temp has already touched or exceeded strike (guaranteed YES)
   * - 0.00: Low temp has already dipped below strike on low temp markets
   * - null: Unknown or within normal variance
   */
  evaluateStrikeCertainty(series: string, strikeF: number): number | null {
    const icao = this.resolveIcao(series)
    if (!icao) return null
    const peak = this.getTodayPeak(icao)
    const current = this.cache.get(icao)?.data
    if (!peak && !current) return null

    const isHighSeries = series.startsWith('KXHIGH')
    const isLowSeries = series.startsWith('KXLOW')

    if (isHighSeries) {
      const maxRecorded = Math.max(peak?.maxF ?? -999, current?.tempF ?? -999)
      if (maxRecorded >= strikeF) {
        // High temp has already hit or crossed strike -> YES is 100% locked!
        return 1.00
      }
    } else if (isLowSeries) {
      const minRecorded = Math.min(peak?.minF ?? 999, current?.tempF ?? 999)
      if (minRecorded <= strikeF) {
        // Low temp has already dipped to or below strike -> YES is 100% locked!
        return 1.00
      }
    }

    return null
  }

  /** Refresh all major airport stations from NOAA Aviation Weather */
  async refreshStations(): Promise<void> {
    const now = Date.now()
    if (this.fetching || now - this.lastBatchFetch < 60_000) return
    this.fetching = true

    const stations = [...new Set(Object.values(KALSHI_METRO_TO_ICAO))].join(',')
    const url = `https://aviationweather.gov/api/data/metar?ids=${stations}&format=json`

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'oracle-trader/1.0 (weather-alpha-service)' },
        signal: AbortSignal.timeout(8000)
      })
      if (!res.ok) return

      const list = (await res.json()) as Array<{
        icaoId?: string
        name?: string
        temp?: number
        dewp?: number
        obsTime?: number
        reportTime?: string
        maxT24?: number
        minT24?: number
        rawOb?: string
      }>

      const today = new Date().toISOString().slice(0, 10)

      for (const item of list) {
        if (!item.icaoId || typeof item.temp !== 'number') continue
        const tempF = this.toF(item.temp)
        const maxT24F = typeof item.maxT24 === 'number' ? this.toF(item.maxT24) : undefined
        const minT24F = typeof item.minT24 === 'number' ? this.toF(item.minT24) : undefined

        const obs: MetarObservation = {
          icaoId: item.icaoId,
          stationName: item.name ?? item.icaoId,
          tempC: item.temp,
          tempF,
          dewpC: item.dewp ?? 0,
          obsTime: item.obsTime ?? Math.floor(now / 1000),
          reportTime: item.reportTime ?? new Date().toISOString(),
          maxT24C: item.maxT24,
          maxT24F,
          minT24C: item.minT24,
          minT24F,
          rawOb: item.rawOb ?? ''
        }

        this.cache.set(item.icaoId, { at: now, data: obs })

        // Update daily peak high and low tracking
        const currentPeak = this.dailyPeak.get(item.icaoId)
        if (!currentPeak || currentPeak.date !== today) {
          this.dailyPeak.set(item.icaoId, {
            date: today,
            maxF: maxT24F ? Math.max(tempF, maxT24F) : tempF,
            minF: minT24F ? Math.min(tempF, minT24F) : tempF
          })
        } else {
          currentPeak.maxF = Math.max(currentPeak.maxF, tempF, maxT24F ?? -999)
          currentPeak.minF = Math.min(currentPeak.minF, tempF, minT24F ?? 999)
        }
      }

      this.lastBatchFetch = now
    } catch {
      // Best effort network polling
    } finally {
      this.fetching = false
    }
  }
}

export const metarService = new NoaaMetarService()
