// Shared helpers for the historical backtest scripts.
// Encodes the verified routing rules:
//  - /historical/markets ends at the June-28 cutoff and is dominated by
//    multivariate products unless mve_filter=exclude is set.
//  - Recent (post-cutoff) settled markets live on /markets?status=settled
//    and their candles/trades are served by the LIVE endpoints.
//  - Pre-cutoff markets' candles/trades are served by /historical/*.
//  - Old-format candles use null for missing prices; new format uses ''/{}.
export const BASE = 'https://api.elections.kalshi.com/trade-api/v2'

const CUTOFF_MS = Date.parse('2026-06-28T00:00:00Z')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/** Build a diversified pool of settled markets (mve excluded, deduped).
 * historicalFirst=true lists pre-cutoff markets first (their candles are
 * dense in the archive; recently-settled live candles are sparse). */
export async function buildPool({ livePages = 20, historicalPages = 20, historicalFirst = false } = {}) {
  const pool = []
  const seen = new Set()
  const push = (m) => {
    if (!m.ticker || seen.has(m.ticker)) return
    seen.add(m.ticker)
    pool.push({
      ticker: m.ticker,
      eventTicker: m.event_ticker,
      series: m.ticker.split('-')[0],
      result: m.result,
      close: m.close_time ? Date.parse(m.close_time) : 0,
      open: m.open_time ? Date.parse(m.open_time) : 0,
      last: num(m.last_price_dollars),
      volume: num(m.volume_fp),
      strikeType: m.strike_type,
      yesSub: m.yes_sub_title ?? ''
    })
  }
  const livePagesFn = async () => {
    let cursor
    for (let p = 0; p < livePages; p++) {
      const r = await (
        await fetch(`${BASE}/markets?status=settled&mve_filter=exclude&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      ).json()
      const ms = r.markets ?? []
      if (ms.length === 0) break
      for (const m of ms) push(m)
      cursor = r.cursor
      if (!cursor) break
    }
  }
  const histPagesFn = async () => {
    let cursor
    for (let p = 0; p < historicalPages; p++) {
      const r = await (
        await fetch(`${BASE}/historical/markets?limit=1000&mve_filter=exclude${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      ).json()
      const ms = r.markets ?? []
      if (ms.length === 0) break
      for (const m of ms) push(m)
      cursor = r.cursor
      if (!cursor) break
    }
  }
  if (historicalFirst) {
    await histPagesFn()
    await livePagesFn()
  } else {
    await livePagesFn()
    await histPagesFn()
  }
  return pool
}

/** Candles for one market, routed by close time across the archive cutoff. */
export async function getCandles(ticker, startTs, endTs, period, closeTs) {
  const path = closeTs >= CUTOFF_MS
    ? `/markets/candlesticks?market_tickers=${encodeURIComponent(ticker)}&start_ts=${startTs}&end_ts=${endTs}&period_interval=${period}`
    : `/historical/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=${period}`
  const r = await fetch(BASE + path)
  if (!r.ok) return []
  const data = await r.json()
  if (closeTs >= CUTOFF_MS) {
    return (data.markets ?? []).find((x) => x.market_ticker === ticker)?.candlesticks ?? []
  }
  return data.candlesticks ?? []
}

/** Trade tape for one market, routed by close time. */
export async function getTrades(ticker, closeTs, limit = 1000) {
  const path = closeTs >= CUTOFF_MS
    ? `/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=${limit}`
    : `/historical/trades?ticker=${encodeURIComponent(ticker)}&limit=${limit}`
  const r = await fetch(BASE + path)
  if (!r.ok) return []
  const data = await r.json()
  return data.trades ?? []
}

/** Last trade price for a candle; mid(bid,ask) fallback. Accepts both the
 * old-format keys ({close:"0.94"}) and new-format ({close_dollars:"0.94"}),
 * and null/''/{} values. */
export function priceAt(c) {
  const p = c.price ?? {}
  let v = p.close_dollars
  if (v === undefined || v === null || v === '') v = p.close
  if (v !== undefined && v !== null && v !== '') {
    const n = parseFloat(v)
    if (Number.isFinite(n)) return n
  }
  const b = bidAt(c)
  const a = askAt(c)
  if (b !== undefined && a !== undefined) return (b + a) / 2
  return undefined
}

/** YES bid close for a candle (old + new key formats, null-safe). */
export function bidAt(c) {
  const o = c.yes_bid ?? {}
  let v = o.close_dollars
  if (v === undefined || v === null || v === '') v = o.close
  if (v === undefined || v === null || v === '') return undefined
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : undefined
}

/** YES ask close for a candle (old + new key formats, null-safe). */
export function askAt(c) {
  const o = c.yes_ask ?? {}
  let v = o.close_dollars
  if (v === undefined || v === null || v === '') v = o.close
  if (v === undefined || v === null || v === '') return undefined
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : undefined
}
