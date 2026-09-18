/**
 * Fractional Kelly Capital Allocation Calculator.
 *
 * Implements mathematically optimal position sizing for binary options:
 *
 * Kelly Fraction:
 *   f* = (p * b - q) / b
 *
 * Where:
 *   p = true win probability (modeled from quantitative distribution or spot distance)
 *   q = 1 - p (loss probability)
 *   b = net payout odds received = (1.00 - cost) / cost
 *
 * Why Fractional Kelly (Quarter-Kelly):
 *   Full-Kelly produces severe drawdowns when probabilities are slightly miscalibrated.
 *   Quarter-Kelly (0.25 * f*) captures ~75% of maximum geometric growth rate while reducing
 *   portfolio variance by 75% and eliminating risk of ruin.
 */

export interface KellySizingResult {
  kellyFraction: number
  fractionalFraction: number
  recommendedDollars: number
  recommendedContracts: number
  expectedValueCents: number
  roiPct: number
}

export function calcQuarterKellySizing(params: {
  accountBalance: number
  costPrice: number // e.g. 0.70 (cents/100)
  trueProbability: number // e.g. 0.75
  maxBalancePct?: number // e.g. 0.05 (hard ceiling per trade)
  maxContracts?: number // e.g. 10
  fractionMultiplier?: number // default 0.25 (quarter Kelly)
}): KellySizingResult {
  const {
    accountBalance,
    costPrice,
    trueProbability,
    maxBalancePct = 0.05,
    maxContracts = 10,
    fractionMultiplier = 0.25
  } = params

  if (costPrice <= 0.01 || costPrice >= 0.99 || trueProbability <= 0 || trueProbability >= 1) {
    return {
      kellyFraction: 0,
      fractionalFraction: 0,
      recommendedDollars: 0,
      recommendedContracts: 0,
      expectedValueCents: 0,
      roiPct: 0
    }
  }

  // Net odds received: b = profit / risk = (1 - cost) / cost
  const b = (1.0 - costPrice) / costPrice
  const p = trueProbability
  const q = 1.0 - p

  // Full Kelly formula: f* = (p * b - q) / b
  const fullKelly = (p * b - q) / b

  // Expected edge per contract in cents
  const evCents = (p * 1.0 - costPrice) * 100
  const roiPct = (evCents / (costPrice * 100)) * 100

  if (fullKelly <= 0 || evCents <= 0) {
    return {
      kellyFraction: 0,
      fractionalFraction: 0,
      recommendedDollars: 0,
      recommendedContracts: 0,
      expectedValueCents: evCents,
      roiPct
    }
  }

  // Apply fractional multiplier (Quarter-Kelly)
  const fractional = fullKelly * fractionMultiplier

  // Bounded by max balance percentage ceiling
  const effectiveFraction = Math.min(fractional, maxBalancePct)
  const targetDollars = accountBalance * effectiveFraction

  // Translate dollars to integer contracts
  const contracts = Math.min(
    maxContracts,
    Math.max(1, Math.floor(targetDollars / costPrice))
  )

  const actualDollars = contracts * costPrice

  return {
    kellyFraction: fullKelly,
    fractionalFraction: fractional,
    recommendedDollars: Math.round(actualDollars * 100) / 100,
    recommendedContracts: contracts,
    expectedValueCents: Math.round(evCents * 100) / 100,
    roiPct: Math.round(roiPct * 10) / 10
  }
}
