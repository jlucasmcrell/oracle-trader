/**
 * CANONICAL KALSHI FEE MODEL - the single source of truth for every fee
 * number the application computes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS (read this before "optimising" anything here)
 * ---------------------------------------------------------------------------
 * Before this module the identical economic quantity - "what does this Kalshi
 * order cost in fees" - was implemented SEVEN separate times, and the six
 * implementations disagreed with each other and with the venue:
 *
 *   1. autoTrader.ts  kalshiOrderFeeCents()   ceil on the ORDER total, multiplier-aware
 *   2. autoTrader.ts  netCentsOf()            (1) but then divided by contracts AGAIN -> Cx too low
 *   3. engine/paper.ts feeFor()               no rounding at all (continuous "ideal" fee)
 *   4. leadLag.ts     kalshiTakerFeeCents()   ceil per CONTRACT, hardcoded 0.07
 *   5. cryptoConvergence.ts calcTakerFee()    ceil per CONTRACT x count, hardcoded 0.07
 *   6. dutchBook.ts   calcLegFee()            ceil on the order total but always called with
 *                                             count=1 and then used as a per-contract figure
 *   7. intelligence/candidatePacket.ts oneContractFeeCents()  ceil per contract (correct
 *                                             only because the packet declares contracts:1)
 *
 * Only (1) was right. The divergences are not cosmetic: (3) understates the fee
 * and is the simulator that grades strategies BEFORE they go live; (2) is the
 * metric the promotion ladder ranks strategies on; (4) and (5) overstate the
 * fee by up to 7x on low-priced legs and therefore REJECT trades that clear
 * the real fee.
 *
 * ---------------------------------------------------------------------------
 * THE VENUE'S ACTUAL MECHANIC (settled empirically 2026-09-18)
 * ---------------------------------------------------------------------------
 * Kalshi's fee is quadratic:  fee = rate x C x P x (1 - P)
 * where rate is a per-series coefficient (0.07 for plain `quadratic` series,
 * scaled by the series `fee_multiplier`).
 *
 * The rounding question was settled against the live fill archive, not the
 * vendored docs: 2,505 real orders / 2,826 fills carried Kalshi's
 * authoritative `fee_cost`, and the charged fee matches
 *
 *     ceil to $0.0001 (four decimal places) of the ORDER total
 *
 * on 1,571 of 1,626 fee-bearing orders (96.6%, exact). The old cent-ceil
 * matched 2.4% and OVERSTATED the aggregate fee by 1.42x ($108.70 modelled
 * vs $76.68 actually charged); the vendored-doc 6dp claim matched 10.9%
 * (only the degenerate cases where 6dp already equals 4dp).
 *
 * CONSEQUENCE, and this is the decision this module encodes:
 *   - For CASH ACCOUNTING use kalshiOrderFeeDollars() - the $0.0001-snapped
 *     figure. That is what the balance loses on this order, today.
 *   - For EDGE GATING the same figure is the accurate one, because it is
 *     what we actually pay. There is no un-modelled rebate at the sizes this
 *     app trades: the charged fee is exactly the 4dp ceil.
 *
 * Full derivation and per-market breakdown:
 * docs/AUDIT-REVIEW-VERIFICATION-2026-09-18.md (D1) and
 * docs/REPAIR-COMPLETE-2026-09-18.md (Part A).
 *
 * ---------------------------------------------------------------------------
 * UNITS - the trap that caused bug (2)
 * ---------------------------------------------------------------------------
 *   kalshiOrderFeeDollars()      -> DOLLARS for the whole order
 *   kalshiFeeCentsPerContract()  -> CENTS for one contract of that order
 *
 * The old helper was named "kalshiOrderFeeCents" but returned the second of
 * those; the name invited callers to divide by contracts a second time.
 * These names are deliberately unambiguous. Do not add a shorter alias.
 *
 * All functions are pure, total and side-effect free: bad input yields 0
 * rather than NaN, because every caller feeds persisted user data that older
 * builds may have written as null/NaN.
 */

/** Taker coefficient for series whose fee_type is plain `quadratic`. */
export const KALSHI_TAKER_FEE_COEF = 0.07

/**
 * Maker coefficient. Charged ONLY on `quadratic_with_maker_fees` series
 * (see kalshi.ts:1408). On a plain `quadratic` series the maker fee is ZERO,
 * which is the entire reason resting quotes can be profitable at all.
 */
export const KALSHI_MAKER_FEE_COEF = 0.0175

/** Balance precision the exchange settles to, in dollars (empirically $0.0001). */
export const KALSHI_BALANCE_PRECISION = 0.0001

/**
 * Absorbs binary-float dust. Without it `ceil` can push a mathematically exact
 * $0.0001 boundary up by one tick (e.g. a true 0.0175000000001 becomes 0.0176).
 */
const EPS = 1e-9

/**
 * A series fee multiplier of 0, negative or NaN is meaningless; treat it as an
 * absent multiplier rather than as a discount or a NaN cascade.
 */
export function kalshiNormaliseMultiplier(multiplier?: number | null): number {
  if (multiplier === undefined || multiplier === null) return 1
  if (!Number.isFinite(multiplier) || multiplier <= 0) return 1
  return multiplier
}

/** Taker rate for a series, from its fee multiplier. */
export function kalshiTakerRate(multiplier?: number | null): number {
  return KALSHI_TAKER_FEE_COEF * kalshiNormaliseMultiplier(multiplier)
}

/** Maker rate for a series, from its fee multiplier. */
export function kalshiMakerRate(multiplier?: number | null): number {
  return KALSHI_MAKER_FEE_COEF * kalshiNormaliseMultiplier(multiplier)
}

/**
 * The fee is charged on the FRACTIONAL contract count. Kalshi has traded fractional contracts on every
 * active market since its 2026-04-17 API change, and the app sizes by dollars (a $1 NO at 93c is 1.075
 * contracts). Measured 2026-09-19 on the fills archive (§127): of 596 fractional fills carrying a fee, the
 * venue's fee equals ceil-4dp of rate x C x P(1-P) with the fractional C on 536 and with the rounded C on 2.
 * Rounding here (the rule until 2026-09-19) understated a 1.49-contract order's fee by a third.
 * Non-finite or non-positive counts fall back to one contract so a bad input cannot price a free order.
 */
export function kalshiNormaliseContracts(contracts: number): number {
  if (!Number.isFinite(contracts) || contracts <= 0) return 1
  return contracts
}

/**
 * The un-rounded quadratic model fee in DOLLARS: rate x C x P x (1 - P).
 * This is the theoretical figure, useful for diagnostics and for the empirical
 * rounding probe. It is NOT what the balance loses; do not account with it.
 */
export function kalshiModelFeeDollars(feeRate: number, yesPrice: number, contracts: number): number {
  if (!Number.isFinite(feeRate) || feeRate <= 0) return 0
  if (!Number.isFinite(yesPrice) || yesPrice <= 0 || yesPrice >= 1) return 0
  return feeRate * kalshiNormaliseContracts(contracts) * yesPrice * (1 - yesPrice)
}

/**
 * What this order actually costs in fees, in DOLLARS, on a balance settled to
 * $0.0001 (four decimal places). THE cash-accurate figure - every accounting
 * path must use this.
 *
 * Note the ceil is applied to the ORDER total, not per contract. That ordering
 * is the whole point: rounding per contract and then multiplying by the
 * contract count overstates the fee, which is bug (4)/(5) above.
 */
export function kalshiOrderFeeDollars(feeRate: number, yesPrice: number, contracts: number): number {
  const raw = kalshiModelFeeDollars(feeRate, yesPrice, contracts)
  if (raw <= 0) return 0
  return Math.ceil(raw * 10000 - EPS) / 10000
}

/**
 * The same order fee expressed as CENTS per contract. This is the figure the
 * per-trade edge calculations want, because entry prices and payoffs are
 * quoted per contract.
 *
 * At C=1 this is the order fee itself (e.g. 1.75c at p=0.5, not the old
 * whole-cent ceil of 2c).
 */
export function kalshiFeeCentsPerContract(feeRate: number, yesPrice: number, contracts: number): number {
  const C = kalshiNormaliseContracts(contracts)
  return (kalshiOrderFeeDollars(feeRate, yesPrice, C) * 100) / C
}

/**
 * Size-aware taker fee in cents per contract, for a given series multiplier.
 * This replaces the old leadLag `kalshiTakerFeeCents(p)` helper, whose
 * 1-contract value the edge gates were wrongly applying to multi-contract
 * orders.
 *
 * Returns the EXACT per-contract figure and is deliberately NOT rounded up to a
 * whole cent: the dislocation maths it feeds compares against a gap expressed
 * in tenths of a cent, and rounding 0.33c up to 1c here would restore the very
 * overstatement this fix removes (3x at the default 3-contract sweep).
 */
export function kalshiTakerFeeCentsFor(yesPrice: number, contracts: number, multiplier?: number | null): number {
  const rate = kalshiTakerRate(multiplier)
  return kalshiFeeCentsPerContract(rate, yesPrice, contracts)
}

/**
 * Maker fee in DOLLARS for an order. Zero on a plain `quadratic` series -
 * callers must pass the series' own maker rate (0 for quadratic), because this
 * function cannot know the fee_type. See kalshi.ts:1408.
 */
export function kalshiMakerOrderFeeDollars(makerRate: number, yesPrice: number, contracts: number): number {
  return kalshiOrderFeeDollars(makerRate, yesPrice, contracts)
}

/**
 * Taker fee in DOLLARS for a whole order of `contracts` contracts. This is the
 * signature the strategy gates actually want: pass the price you would pay and
 * the size you would trade, and get the venue's real charge.
 */
export function kalshiTakerOrderFeeDollars(yesPrice: number, contracts: number, multiplier?: number | null): number {
  return kalshiOrderFeeDollars(kalshiTakerRate(multiplier), yesPrice, contracts)
}

// A6 (2026-09-18): a `kalshiNetEdgeCents` helper used to live here. Its name
// promised a surviving net edge, but it returned the NEGATED FEE
// (`-kalshiFeeCentsPerContract`), so a caller adding it to an edge would have
// double-counted the cost. It had no callers, so it is deleted rather than
// renamed: `kalshiFeeCentsPerContract` above is the honest name for what it
// computed. Do not reintroduce it without a test that proves the sign.
