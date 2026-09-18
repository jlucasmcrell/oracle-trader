/**
 * Combinatorial Multi-Outcome Dutch Book Arbitrage Engine.
 *
 * Scans mutually exclusive Kalshi events for mathematical basket arbitrage:
 * 1. Buy-All-YES: sum(yes_ask) + taker_fees < $1.00 - minEdge
 *    Guaranteed $1.00 payout on resolution since exactly one leg must win.
 * 2. Buy-All-NO (Sell-All-YES): sum(yes_bid) - taker_fees > $1.00 + minEdge
 *    Guaranteed (N-1) * $1.00 payout on N legs since N-1 legs resolve NO.
 *
 * Enforces exhaustive slate rules (requires 'Other'/'None' leg or verified closed roster)
 * to avoid truncation risk on open-ended rosters.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { VenueAdapter } from '../../shared/venue'
import { kalshiTakerOrderFeeDollars } from '../util/kalshiFee'

const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

export interface DutchBookConfig {
  dutchEnabled: boolean
  dutchLiveEnabled: boolean
  dutchMinEdgeCents: number
  dutchMaxLegs: number
  dutchMaxBasketSpend: number
  dutchRequireExhaustive: boolean
}

export interface DutchOpportunity {
  ts: string
  eventTicker: string
  seriesTicker: string
  category: string
  title: string
  numLegs: number
  hasOther: boolean
  kind: 'buy-all-yes' | 'buy-all-no'
  sumPrice: number
  feeCents: number
  netEdgeCents: number
  maxContracts: number
  legs: {
    ticker: string
    title: string
    outcome: 'YES' | 'NO'
    price: number
    yesLegPrice: number
    availableSize: number
  }[]
}

export interface DutchBookStatus {
  enabled: boolean
  liveEnabled: boolean
  active: boolean
  scannedEvents: number
  exclusiveChecked: number
  opportunitiesFound: number
  executedBaskets: number
  lastScanAt?: number
  lastOpportunity?: DutchOpportunity | null
  note: string
}

interface DutchState {
  scannedEvents: number
  exclusiveChecked: number
  opportunitiesFound: number
  executedBaskets: number
  lastScanAt?: number
  history: DutchOpportunity[]
}

// Per-leg Kalshi taker fee in dollars, one separate order per leg.
//
// Routed through the canonical model (2026-09-18). Two known limitations, both
// deliberate and both CONSERVATIVE (they make a basket look worse than it is,
// never better):
//   1. count defaults to 1 because the basket size is derived from the fee
//      (buyNetEdge -> maxContracts) and is therefore not yet known here. Every
//      leg order is really maxContracts contracts, so the true per-contract fee
//      is LOWER than this, and the gate is harder to pass than reality.
//   2. the series multiplier is not available at this point - dutchBook reads
//      raw market JSON, and fee_type/fee_multiplier live on the SERIES - so the
//      plain 0.07 coefficient is assumed. Correct for quadratic series, 2x high
//      for the 0.5-multiplier index series.
function calcLegFee(p: number, count: number = 1): number {
  return kalshiTakerOrderFeeDollars(p, count)
}

export class DutchBookEngine {
  private state: DutchState = {
    scannedEvents: 0,
    exclusiveChecked: 0,
    opportunitiesFound: 0,
    executedBaskets: 0,
    history: []
  }
  private running = false
  private note = 'idle'
  private lastOpp: DutchOpportunity | null = null

  constructor(
    private readonly path: string,
    private readonly log: (s: string) => void = console.log
  ) {
    try {
      if (existsSync(path)) {
        this.state = { ...this.state, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<DutchState>) }
      }
    } catch {
      // fresh state
    }
  }

  status(cfg: DutchBookConfig): DutchBookStatus {
    return {
      enabled: cfg.dutchEnabled,
      liveEnabled: cfg.dutchLiveEnabled,
      active: this.running,
      scannedEvents: this.state.scannedEvents,
      exclusiveChecked: this.state.exclusiveChecked,
      opportunitiesFound: this.state.opportunitiesFound,
      executedBaskets: this.state.executedBaskets,
      lastScanAt: this.state.lastScanAt,
      lastOpportunity: this.lastOpp,
      note: this.note
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = this.path + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.path)
    } catch (e) {
      this.log('[dutch] persist failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  private recordOpportunity(opp: DutchOpportunity): void {
    this.lastOpp = opp
    this.state.opportunitiesFound++
    this.state.history = [opp, ...this.state.history.slice(0, 49)]
    try {
      const logFile = this.path.replace(/\.json$/, '') + '-opps.jsonl'
      appendFileSync(logFile, JSON.stringify(opp) + '\n')
    } catch (e) {
      this.log('[dutch] opp log failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /**
   * Scan Kalshi's open mutually exclusive events and execute fee-clearing Dutch baskets.
   */
  async scanAndExecute(
    adapter: VenueAdapter,
    cfg: DutchBookConfig,
    mode: 'paper' | 'live',
    armed: boolean,
    killed: boolean,
    /** Exchange trading paused (weekly maintenance): scan nothing, place nothing. */
    paused = false
  ): Promise<DutchOpportunity[]> {
    if (this.running || !cfg.dutchEnabled) return []
    if (paused) {
      this.note = 'exchange trading paused; not scanning'
      return []
    }
    this.running = true
    const opportunities: DutchOpportunity[] = []
    const now = Date.now()

    try {
      this.state.lastScanAt = now
      let cursor: string | undefined
      let totalEvents = 0
      let totalChecked = 0

      // Page open events with nested markets
      for (let page = 0; page < 8; page++) {
        let res: Response
        try {
          const url = `${KALSHI_API}/events?status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
          res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
        } catch {
          break
        }
        if (!res.ok) break
        const data = (await res.json()) as { events?: any[]; cursor?: string }
        const events = data.events ?? []
        totalEvents += events.length

        for (const ev of events) {
          if (ev.mutually_exclusive !== true) continue
          const markets = (ev.markets ?? []).filter((m: any) => m.status === 'active' || m.status === 'open' || !m.status)
          if (markets.length < 3 || markets.length > cfg.dutchMaxLegs) continue

          totalChecked++
          const hasOther = markets.some((m: any) =>
            /\b(other|none|another|else|no one|nobody|all others)\b/i.test(`${m.yes_sub_title ?? ''} ${m.subtitle ?? ''} ${m.title ?? ''}`)
          )

          // If exhaustive slate is required but no 'Other' leg exists, skip
          if (cfg.dutchRequireExhaustive && !hasOther) continue

          let sumAsk = 0
          let sumBid = 0
          let totalAskFee = 0
          let totalBidFee = 0
          let minAskSize = Infinity
          let minBidSize = Infinity
          let isComplete = true

          const legsAsk: DutchOpportunity['legs'] = []
          const legsBid: DutchOpportunity['legs'] = []

          for (const m of markets) {
            const ya = num(m.yes_ask_dollars)
            const yb = num(m.yes_bid_dollars)
            const yaSz = num(m.yes_ask_size_fp) ?? 0
            const ybSz = num(m.yes_bid_size_fp) ?? 0

            if (ya === null || yb === null || ya <= 0 || ya >= 1 || yb <= 0 || yb >= 1) {
              isComplete = false
              break
            }

            sumAsk += ya
            sumBid += yb
            totalAskFee += calcLegFee(ya)
            totalBidFee += calcLegFee(1 - yb)
            minAskSize = Math.min(minAskSize, yaSz)
            minBidSize = Math.min(minBidSize, ybSz)

            legsAsk.push({
              ticker: m.ticker,
              title: m.yes_sub_title || m.title || m.ticker,
              outcome: 'YES',
              price: ya,
              yesLegPrice: ya,
              availableSize: yaSz
            })
            legsBid.push({
              ticker: m.ticker,
              title: m.no_sub_title || m.title || m.ticker,
              outcome: 'NO',
              price: +(1 - yb).toFixed(4),
              yesLegPrice: yb,
              availableSize: ybSz
            })
          }

          if (!isComplete) continue

          // 1. Check Buy-All-YES: cost = sumAsk + totalAskFee
          const buyNetEdge = (1 - sumAsk) * 100 - totalAskFee * 100
          if (buyNetEdge >= cfg.dutchMinEdgeCents && sumAsk < 0.98) {
            const opp: DutchOpportunity = {
              ts: new Date().toISOString(),
              eventTicker: ev.event_ticker,
              seriesTicker: ev.series_ticker,
              category: ev.category ?? 'general',
              title: (ev.title ?? '').slice(0, 100),
              numLegs: markets.length,
              hasOther,
              kind: 'buy-all-yes',
              sumPrice: +sumAsk.toFixed(4),
              feeCents: +totalAskFee.toFixed(2),
              netEdgeCents: +buyNetEdge.toFixed(2),
              maxContracts: Math.max(1, Math.min(10, Math.floor(minAskSize))),
              legs: legsAsk
            }
            opportunities.push(opp)
            this.recordOpportunity(opp)
          }

          // 2. Check Buy-All-NO: payout = (N - 1) * $1, cost = sum(1 - yb) = N - sumBid
          // Net Profit = (N - 1) - (N - sumBid) = sumBid - 1
          const sellNetEdge = (sumBid - 1) * 100 - totalBidFee * 100
          if (sellNetEdge >= cfg.dutchMinEdgeCents && sumBid > 1.02) {
            const opp: DutchOpportunity = {
              ts: new Date().toISOString(),
              eventTicker: ev.event_ticker,
              seriesTicker: ev.series_ticker,
              category: ev.category ?? 'general',
              title: (ev.title ?? '').slice(0, 100),
              numLegs: markets.length,
              hasOther,
              kind: 'buy-all-no',
              sumPrice: +sumBid.toFixed(4),
              feeCents: +totalBidFee.toFixed(2),
              netEdgeCents: +sellNetEdge.toFixed(2),
              maxContracts: Math.max(1, Math.min(10, Math.floor(minBidSize))),
              legs: legsBid
            }
            opportunities.push(opp)
            this.recordOpportunity(opp)
          }
        }

        cursor = data.cursor
        if (!cursor) break
        await sleep(100)
      }

      this.state.scannedEvents = totalEvents
      this.state.exclusiveChecked = totalChecked

      // Execution Phase
      const canTrade = mode === 'live' && armed && !killed && cfg.dutchLiveEnabled
      for (const opp of opportunities) {
        this.log(`[dutch] FOUND ${opp.kind.toUpperCase()} on ${opp.eventTicker} (${opp.numLegs} legs): sum ${(opp.sumPrice * 100).toFixed(1)}c | Net Edge +${opp.netEdgeCents.toFixed(1)}c/basket | ${opp.title}`)

        if (!canTrade) continue

        // Calculate trade sizing
        const basketCost = opp.kind === 'buy-all-yes' ? opp.sumPrice : opp.numLegs - opp.sumPrice
        const contracts = Math.max(1, Math.min(opp.maxContracts, Math.floor(cfg.dutchMaxBasketSpend / Math.max(basketCost, 0.10))))

        this.log(`[dutch] EXECUTING synchronized basket on ${opp.eventTicker} x${contracts} ($${(contracts * basketCost).toFixed(2)} notional)...`)
        let executedLegs = 0
        const filledLegs: { ticker: string; outcome: 'YES' | 'NO'; shares: number }[] = []

        for (const leg of opp.legs) {
          try {
            // On Kalshi, placeOrder always expects the YES-leg limit price:
            // For YES: limit = yesLegPrice + 0.01 (cross the ask)
            // For NO: limit = yesLegPrice - 0.01 (cross the bid)
            const yesPrice = leg.yesLegPrice ?? (leg.outcome === 'YES' ? leg.price : +(1 - leg.price).toFixed(4))
            const limit = leg.outcome === 'YES'
              ? Math.min(0.99, +(yesPrice + 0.01).toFixed(2))
              : Math.max(0.01, +(yesPrice - 0.01).toFixed(2))

            const res = await adapter.placeOrder({
              venue: 'kalshi',
              marketId: leg.ticker,
              outcome: leg.outcome,
              amount: contracts * (leg.outcome === 'YES' ? limit : 1 - limit),
              limitPrice: limit,
              timeInForce: 'fill_or_kill'
            })
            if (res.shares >= contracts - 0.005) {
              executedLegs++
              filledLegs.push({ ticker: leg.ticker, outcome: leg.outcome, shares: res.shares })
            } else if (res.shares > 0) {
              filledLegs.push({ ticker: leg.ticker, outcome: leg.outcome, shares: res.shares })
              this.log(`[dutch] partial fill ${leg.ticker}: ${res.shares}/${contracts}`)
              break
            } else {
              this.log(`[dutch] no fill ${leg.ticker}; aborting basket`)
              break
            }
          } catch (e) {
            this.log(`[dutch] leg error on ${leg.ticker}: ${e instanceof Error ? e.message : String(e)}`)
          }
          await sleep(50)
        }

        if (executedLegs === opp.legs.length) {
          this.state.executedBaskets++
          this.log(`[dutch] BASKET COMPLETE: ${opp.eventTicker} successfully filled across all ${executedLegs} legs!`)
        } else {
          this.log(`[dutch] BASKET PARTIAL: ${executedLegs}/${opp.legs.length} legs filled on ${opp.eventTicker}; unwinding ${filledLegs.length}`)
          // A partial Dutch basket is directional risk, not arbitrage. Flatten
          // every filled leg immediately rather than leaving an orphaned slate.
          for (const f of filledLegs) {
            try {
              await adapter.sellPosition({ venue: 'kalshi', marketId: f.ticker, outcome: f.outcome, shares: f.shares, timeInForce: 'immediate_or_cancel' })
            } catch (e) {
              this.log(`[dutch] URGENT unwind failed ${f.ticker}: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        }
      }

      this.note = `scanned ${totalEvents} events (${totalChecked} exclusive), found ${opportunities.length} arb slates`
    } catch (e) {
      this.note = 'scan failed: ' + (e instanceof Error ? e.message : String(e))
      this.log('[dutch] error: ' + this.note)
    } finally {
      this.persist()
      this.running = false
    }

    return opportunities
  }
}
