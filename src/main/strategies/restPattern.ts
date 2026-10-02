/**
 * Market-maker rest patterns (build-queue item 8c, pre-registered
 * docs/PREREGISTERED-rest-pattern.md).
 *
 * The 2026-09-08 move audit measured a maker resting on the reverting side
 * after a fast move at +3.6 to +5.3c "at last price" - a ceiling for a seat,
 * not a traded result. Item 8c names the entry that seat implies: join the
 * side whose RESTING depth just doubled. A maker who doubles a resting bid is
 * willing to be filled at that price; the depth arrives before the print, so
 * it is observable without paying for it.
 *
 * The shape follows flowMonitor.ts: the verdict is a pure function of a depth
 * history and is unit-tested; the caller owns the samples. Nothing here
 * fetches, and nothing here trades.
 */

/** One scan's view of a market's resting depth, in dollars at the top three levels. */
export interface DepthSample {
  at: number
  bidDepth: number
  askDepth: number
}

export interface RestRule {
  /** The doubling bar: current side depth over its own baseline. */
  minMultiple: number
  /** The grown side must rest at least this many dollars - a doubled $2 wall is noise. */
  minSideDepthDollars: number
  /** Only samples this recent form the baseline. */
  windowMs: number
  /** Baseline samples required before any verdict (the newest sample is not one of them). */
  minSamples: number
  /** Horizon guards: in-play books churn, and a near-settled book is pinned. */
  minHoursToClose: number
  maxHoursToClose: number
  /** Price band: the fee is largest in the middle and the tails are the settle pin. */
  minPrice: number
  maxPrice: number
}

export const REST_DEFAULTS: RestRule = {
  minMultiple: 2,
  minSideDepthDollars: 25,
  windowMs: 20 * 60_000,
  minSamples: 3,
  minHoursToClose: 6,
  maxHoursToClose: 24,
  minPrice: 0.15,
  maxPrice: 0.85
}

export interface RestVerdict {
  direction: 'YES' | 'NO'
  /** Which book side grew: bids rest under YES, asks rest under NO. */
  side: 'bid' | 'ask'
  multiple: number
  baselineDepth: number
  depth: number
  samples: number
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.floor(s.length / 2)
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2
}

/**
 * Did one side's resting depth just double, and only one side?
 *
 * `history` is oldest-first and its LAST element is the current scan. The
 * baseline is the median of the samples strictly before it that fall inside
 * the window - a median, not the previous sample, so one scan that happened to
 * catch a book mid-refresh cannot manufacture a doubling on its own.
 *
 * A doubling on BOTH sides is refused: that is liquidity arriving in the
 * market, not a maker taking a side, and it carries no direction.
 */
export function restVerdict(
  history: readonly DepthSample[],
  now: number,
  hoursToClose: number,
  price: number,
  rule: RestRule = REST_DEFAULTS
): RestVerdict | null {
  if (history.length < rule.minSamples + 1) return null
  if (!(hoursToClose >= rule.minHoursToClose && hoursToClose <= rule.maxHoursToClose)) return null
  if (!(price >= rule.minPrice && price <= rule.maxPrice)) return null
  const cur = history[history.length - 1]
  if (now - cur.at > rule.windowMs) return null
  const prior = history.slice(0, -1).filter((s) => now - s.at <= rule.windowMs)
  if (prior.length < rule.minSamples) return null
  const bidBase = median(prior.map((s) => s.bidDepth))
  const askBase = median(prior.map((s) => s.askDepth))
  // A zero baseline cannot be doubled: a side that was empty and now rests is
  // a new book, not a maker adding to a seat it already held.
  const bidGrew = bidBase > 0 && cur.bidDepth >= rule.minMultiple * bidBase && cur.bidDepth >= rule.minSideDepthDollars
  const askGrew = askBase > 0 && cur.askDepth >= rule.minMultiple * askBase && cur.askDepth >= rule.minSideDepthDollars
  if (bidGrew === askGrew) return null
  const side = bidGrew ? 'bid' : 'ask'
  const base = bidGrew ? bidBase : askBase
  const depth = bidGrew ? cur.bidDepth : cur.askDepth
  return {
    direction: bidGrew ? 'YES' : 'NO',
    side,
    multiple: depth / base,
    baselineDepth: base,
    depth,
    samples: prior.length
  }
}

/**
 * Bounded depth history, one entry per market per scan.
 *
 * Recording is unconditional - the arm's flag gates the SIGNAL, not the
 * observation, so the history is already there the moment the ladder switches
 * the arm on (the mistake backlog 64 recorded: evidence that only starts
 * accruing when an arm is armed cannot answer the question that armed it).
 */
export class DepthHistory {
  private byMarket = new Map<string, DepthSample[]>()

  constructor(private readonly rule: RestRule = REST_DEFAULTS) {}

  /** Depth in dollars at the top `levels` levels of one side. */
  static depthOf(levels: readonly { price: number; size: number }[], top = 3): number {
    return levels.slice(0, top).reduce((s, l) => s + l.price * l.size, 0)
  }

  record(marketId: string, sample: DepthSample): void {
    const keep = sample.at - this.rule.windowMs
    const rows = (this.byMarket.get(marketId) ?? []).filter((s) => s.at >= keep)
    rows.push(sample)
    this.byMarket.set(marketId, rows)
    if (this.byMarket.size > 2000) {
      for (const [k, v] of this.byMarket) {
        const last = v[v.length - 1]
        if (!last || sample.at - last.at > 2 * this.rule.windowMs) this.byMarket.delete(k)
      }
    }
  }

  get(marketId: string): readonly DepthSample[] {
    return this.byMarket.get(marketId) ?? []
  }

  get size(): number {
    return this.byMarket.size
  }
}
