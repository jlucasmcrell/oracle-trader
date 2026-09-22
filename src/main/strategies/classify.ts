/**
 * Venue-agnostic market classification for the fade gates.
 *
 * Kalshi labels markets with a category and encodes the subject in the
 * series ticker; Polymarket US supplies NEITHER, so the same trade has to be
 * recognised from question text. Without this, the research-driven category
 * filter silently applied to one venue only — Polymarket kept taking the
 * weather fades Kalshi correctly refused (observed 2026-08-31: six such
 * positions open at once).
 */

/** Crypto tickers whose series differ but whose risk does not (KXSOLE/KXSOLD → SOL). */
const CRYPTO_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC', 'DOT', 'BCH', 'UNI', 'ATOM']

const CRYPTO_WORDS = /\b(bitcoin|ethereum|solana|ripple|xrp|dogecoin|cardano|avalanche|chainlink|litecoin|polkadot|btc|eth|sol|crypto)\b/i
const WEATHER_WORDS = /\b(temperature|temp|rain|rainfall|snow|snowfall|precipitation|degrees|weather|heat index)\b/i
// Macro terms plus equity language: a "GOOG > AMD at market close" market is
// a company/finance market even though it names no macro indicator, and the
// study measures no fade edge there either.
const FINANCE_WORDS =
  /\b(cpi|inflation|fed|interest rate|unemployment|gdp|jobless|nasdaq|s&p|dow jones|treasury|natural gas|oil price|earnings|stock|share price|market close|ticker)\b/i
const ENTERTAINMENT_WORDS = /\b(oscar|grammy|emmy|box office|billboard|album|rotten tomatoes|spotify|netflix)\b/i

export interface ClassifiableMarket {
  category?: string
  seriesTicker?: string
  id?: string
  question?: string
}

/** 'high' for daily-max temperature series, 'low' for daily-min, else null. */
export function tempSeriesKind(m: ClassifiableMarket): 'high' | 'low' | null {
  const s = (m.seriesTicker ?? m.id ?? '').toUpperCase()
  if (s.startsWith('KXHIGH')) return 'high'
  if (s.startsWith('KXLOW')) return 'low'
  const q = m.question ?? ''
  if (/high(est)? temp/i.test(q) || /\bmax(imum)? temp/i.test(q)) return 'high'
  if (/low(est)? temp/i.test(q) || /\bmin(imum)? temp/i.test(q)) return 'low'
  return null
}

/**
 * Category-conditional fade eligibility, from the 2026 353M-trade calibration
 * study (arXiv 2602.19520, replicated on Kalshi + Polymarket): the
 * favorite-longshot bias is concentrated in politics, ~absent in
 * crypto/finance/entertainment (slope ≈ 1 → fading there only pays fees),
 * and INVERTED in weather inside 48h. Returns the block group, or null when
 * the fade may trade. Unknown subjects stay tradable — this removes only
 * measured-no-edge groups.
 *
 * `exceptions` names groups the counterfactual ledger has since OVERRULED.
 * The study is a prior, not the last word: every block is shadow-graded, and
 * when a group's blocked trades demonstrably win, forward evidence from this
 * account beats a population study. Naming the group here keeps the
 * classifier intact (underlyingOf and the per-underlying cap still need it)
 * while letting the trade through.
 */
/**
 * Any weather market, temperature ladder or not. The category block used
 * tempSeriesKind alone, which matches only ^KXHIGH/^KXLOW, so precipitation
 * series fell inside the 48h block only when the series-category cache
 * happened to be warm — fade opened KXRAIN-26SEP08-AUS eight hours before
 * close on 2026-09-08 through exactly that hole.
 */
export function isWeatherSeries(m: ClassifiableMarket): boolean {
  if (tempSeriesKind(m) !== null) return true
  return /^KX(RAIN|SNOW)/.test((m.seriesTicker ?? m.id ?? '').toUpperCase())
}

/**
 * Arms whose evidence base IS the weather seat: they carry their own gate
 * (docs/BACKLOG.md item 25) and are judged on it.
 */
const WEATHER_NATIVE_STRATEGIES = new Set(['settlement', 'weather-morning', 'quoter'])

/**
 * Keeps the generic arms out of the temperature/precipitation ladders.
 *
 * The 2026-09-09 seat measurement (public trades endpoint, 801,258 contracts
 * over 78 station-days) puts the MAKER seat in KX(HIGH|LOW)T* at -1.70c per
 * contract, CI95 [-2.66, -0.73], and -5.55c inside the 3-48h / 7-93c window;
 * it is positive on only 10 of the 78 station-days. The move and fade audits
 * that justify the generic arms were run on the Becker dataset, which
 * contains ZERO rows from those series — so their measured edge says nothing
 * about this class, while the class itself has a measured negative seat.
 *
 * Observed 2026-09-09: mean-reversion, newly on the maker path, rested into
 * KXLOWTATL / KXLOWTPHIL / KXLOWTNYC hours after the weather arms were
 * retired. Those three would have been the first rows of its fresh baseline,
 * turning the arm the whole book is waiting on into a weather test.
 *
 * Matched on the SERIES TICKER only: that is how the seat was measured.
 */
export function weatherSeatBlock(strategy: string, marketId: string): string | null {
  if (WEATHER_NATIVE_STRATEGIES.has(strategy)) return null
  if (!isWeatherSeries({ id: marketId })) return null
  return 'weather series: maker seat measured at -1.70c/contract and no arm evidence in this class'
}

/**
 * Price-level markets on physical commodities and retail fuel. fade lost on them as a class in its own record: $3.93
 * on 26 commodity markets (81% won at 90-97c) and $0.45 on 11 retail gas/diesel markets, against small gains nearly
 * everywhere else (REVIEW-CHANGES section 157, PREREGISTERED-fade-v3). Matched on the full series segment so
 * KXGOLDENGLOBES-style names can never collide with KXGOLD.
 */
const COMMODITY_SERIES = /^KX(WTI|BRENT|NATGAS|COPPER|GOLD|SILVER|PLATINUM|PALLADIUM|CORN|WHEAT|SOYBEAN|COFFEE|SUGAR|COTTON|COCOA|LUMBER)(D|W|M|Y|H|15M|MON)?$|^KX(AAAGAS|DIESEL)[A-Z]*$/
export function isCommoditySeries(m: ClassifiableMarket): boolean {
  const series = (m.seriesTicker ?? (m.id ?? '').split('-')[0]).toUpperCase()
  return COMMODITY_SERIES.test(series) || /commodit/i.test(m.category ?? '')
}

export function fadeCategoryBlock(
  m: ClassifiableMarket,
  horizonMin: number,
  exceptions: readonly string[] = []
): string | null {
  const c = (m.category ?? '').toLowerCase()
  const q = m.question ?? ''
  const near = horizonMin < 48 * 60
  const weather = /weather|climate|temperature/.test(c) || isWeatherSeries(m) || WEATHER_WORDS.test(q)
  const group =
    /crypto/.test(c) || CRYPTO_WORDS.test(q)
      ? 'crypto'
      : isCommoditySeries(m)
        ? 'commodities'
        : /financ|econom|compan/.test(c) || FINANCE_WORDS.test(q)
          ? 'finance'
          : /entertain|culture|music|movie|film|award/.test(c) || ENTERTAINMENT_WORDS.test(q)
            ? 'entertainment'
            : weather
              ? near
                ? 'weather<48h'
                : 'weather' // fade v3: beyond 48 h too - the weather seat is measured negative at every horizon
              : null
  return group !== null && exceptions.includes(group) ? null : group
}

/**
 * Risk-bearing underlying, or undefined when the per-event cap already
 * covers it. Kalshi splits one asset across several series — KXSOLE and
 * KXSOLD are both SOL — so an eventTicker cap reads five positions on three
 * coins as five unrelated bets. Weather groups by location: one city's high
 * and low on one day ride the same weather system.
 */
export function underlyingOf(marketId: string, question?: string): string | undefined {
  const parts = marketId.toUpperCase().split('-')
  const series = parts[0]
  // Same-game sports props. The SECOND segment identifies the GAME and is
  // shared across prop series: KXMLBHRR-26SEP012210STLLAD-… and
  // KXMLBTB-26SEP012210STLLAD-… are two props on one baseball game. The
  // per-EVENT cap cannot catch this, because eventTicker keeps the series
  // prefix (KXMLBHRR-… vs KXMLBTB-…) and so reads them as unrelated events.
  // This matters more than it looks: ~83% of the non-MVE universe is MLB and
  // NCAAF props, heavily clustered on a handful of games.
  // The trailing TEAM letters are what separate a game code (26SEP07SMUFSU)
  // from a plain date+hour (26SEP0117) — without that anchor this would group
  // every unrelated series settling in the same hour into one underlying.
  if (parts.length >= 2 && /^\d{2}[A-Z]{3}\d+[A-Z]{4,}$/.test(parts[1])) return `game:${parts[1]}`
  if (series.startsWith('KX')) {
    const body = series.slice(2)
    for (const a of CRYPTO_ASSETS) {
      if (body.startsWith(a)) return `crypto:${a}`
    }
    // Commodity families that move together but carry no shared event ticker.
    // Every state gas ladder (KXAAAGASDNY, …GA, …FL, seven of them) resolves
    // off ONE AAA daily survey, so they are a single bet wearing seven names.
    if (body.startsWith('AAAGAS')) return 'gas:AAA'
    if (/^(WTI|BRENT|DIESEL|GASOLINE)/.test(body)) return 'energy:oil'
    if (/^(GOLD|SILVER|PLATINUM|PALLADIUM)/.test(body)) return 'metals:precious'
    const w = /^(?:HIGHT?|LOWT?)([A-Z]+)$/.exec(body)
    if (w) return `weather:${w[1]}`
  }
  // Polymarket US slugs carry the fixture in the clear: a lowercase prefix,
  // then league and participants, then the date —
  // astatc-nfl-ne-sea-2026-09-09-td-machol-g. Everything up to and including
  // that date is one fixture, so every touchdown prop on one game groups
  // together. Without this the cap was BLIND on the venue, not bypassed:
  // 2026-09-09, twenty minutes after the catalog fetch widened, fade held ten
  // positions on one NFL game against a cap of four, which is $10 of
  // correlated exposure against a $10 daily brake. It also groups the
  // temperature ladders by city-day (temp-miahigh-2026-09-09), which is right
  // for the same reason the Kalshi weather grouping is.
  const slug = /^[a-z]+-(.+?-\d{4}-\d{2}-\d{2})/.exec(marketId)
  if (slug) return `event:${slug[1]}`
  // Venues without structured tickers (Polymarket US): read the subject from
  // the question so "…temperature in NYC…" groups with its sibling strikes.
  const q = question ?? ''
  const city = /(?:temperature|temp|rainfall|snowfall)\s+in\s+([A-Za-z][A-Za-z .'-]*?)\s*(?:\bon\b|\bfor\b|\btoday\b|\btomorrow\b|[?,]|$)/i.exec(q)
  if (city) return `weather:${city[1].trim().toUpperCase()}`
  const coin = CRYPTO_WORDS.exec(q)
  if (coin) return `crypto:${coin[1].toUpperCase()}`
  return undefined
}
