/**
 * Regression tests for the canonical Kalshi fee model and the 2026-09-18 fee
 * repairs (N1/N2).
 *
 * The load-bearing assertion here is the invariant the N1 bug broke:
 *
 *     entryFeeDollars(t) * 100 / shares === the fee term inside netCentsOf(t)
 *
 * and it must hold at EVERY contract count, not just C = 1. Before the fix the
 * two disagreed by exactly Cx, which meant the cash ledger (correct) and the
 * promotion metric (wrong) were reporting different fees for the same fill.
 *
 * Pure functions plus one in-memory PaperBroker; no network, no Electron
 * windows, no disk.
 */
import assert from 'node:assert/strict'
import {
  KALSHI_MAKER_FEE_COEF,
  KALSHI_TAKER_FEE_COEF,
  kalshiFeeCentsPerContract,
  kalshiMakerRate,
  kalshiModelFeeDollars,
  kalshiOrderFeeDollars,
  kalshiTakerFeeCentsFor,
  kalshiTakerOrderFeeDollars,
  kalshiTakerRate
} from '../../src/main/util/kalshiFee'
import { entryFeeDollars, netCentsOf } from '../../src/main/strategies/autoTrader'
import { kalshiTakerFeeCents } from '../../src/main/strategies/leadLag'
import { PaperBroker } from '../../src/main/engine/paper'

const R = KALSHI_TAKER_FEE_COEF
let n = 0
function ok(name: string): void {
  n += 1
  void name
}

// ---------------------------------------------------------------------------
// The venue model: fee = ceil to $0.0001 (4dp) of (rate x C x P x (1 - P)),
// ceil on the ORDER TOTAL. Settled empirically 2026-09-18 from 1,626 live
// fee-bearing orders: ceil-4dp matched 96.6% exactly, the old cent-ceil 2.4%.
// ---------------------------------------------------------------------------
// The RAW model value carries float dust: 0.07 x 10 x 0.25 is 0.17500000000000002.
// Without the 1e-9 guard a ceil would tip an exact 4dp boundary up a full tick.
assert.ok(Math.abs(kalshiModelFeeDollars(R, 0.5, 10) - 0.175) < 1e-12, 'raw model value')
assert.equal(kalshiOrderFeeDollars(R, 0.5, 10), 0.175)
assert.equal(kalshiOrderFeeDollars(R, 0.02, 50), 0.0686)
assert.equal(kalshiOrderFeeDollars(R, 0.5, 1), 0.0175)
assert.equal(kalshiOrderFeeDollars(R, 0.02, 1), 0.0014)
ok('order-total 4dp ceil')

// Fractional contract counts are charged as fractions (2026-09-19, §127): 536 of 596 fractional live fills
// matched the fractional-C formula, 2 matched the rounded one. A $1 YES at 67c is 1.49 contracts and pays
// 2.31c, not the 1.55c a whole-contract rounding produced; a 0.5-contract fill pays half the fee, not all of it.
assert.equal(kalshiOrderFeeDollars(R, 0.67, 1.49), 0.0231)
assert.equal(kalshiOrderFeeDollars(R, 0.5, 0.5), 0.0088)
assert.equal(kalshiOrderFeeDollars(R, 0.93, 1.0753), 0.005)
assert.ok(Math.abs(kalshiFeeCentsPerContract(R, 0.5, 0.5) - 1.76) < 1e-9, 'per-contract on a half contract')
assert.equal(kalshiOrderFeeDollars(R, 0.5, 0), 0.0175, 'a non-positive count still prices one contract')
assert.equal(kalshiOrderFeeDollars(R, 0.5, Number.NaN), 0.0175, 'a bad count still prices one contract')
ok('fractional contracts')

// Per contract is the order fee spread across the contracts.
assert.equal(kalshiFeeCentsPerContract(R, 0.02, 50), 0.1372)
assert.equal(kalshiFeeCentsPerContract(R, 0.5, 10), 1.75)
assert.ok(Math.abs(kalshiFeeCentsPerContract(R, 0.5, 1) - 1.75) < 1e-9, 'per-contract at C=1 is the order fee (1.75c at p=0.5)')
ok('per-contract derivation')

// The ceil is order-level, so the per-contract cost is now nearly FLAT as size
// grows. Under the old per-contract cent-ceil this pair overstated by 7.14x
// (1c vs 0.14c); the order-level 4dp ceil cuts that to ~1.02x.
assert.ok(Math.abs(kalshiFeeCentsPerContract(R, 0.02, 1) - 0.14) < 1e-9, '1-contract fee is 0.14c')
assert.ok(kalshiFeeCentsPerContract(R, 0.02, 50) < kalshiFeeCentsPerContract(R, 0.02, 1), 'per-contract fee falls slightly with size')
assert.ok(Math.abs(kalshiFeeCentsPerContract(R, 0.02, 1) / kalshiFeeCentsPerContract(R, 0.02, 50) - 1.0204) < 0.01, 'order-level 4dp ceil amortises (was 7.14x under per-contract cent-ceil)')
ok('order-level ceil amortises')

// The legacy 1-contract helper now DELEGATES to the canonical model, so the
// two always agree exactly (it is no longer a separate cent-ceil).
for (const p of [0.5, 0.95, 0.99, 0.1]) {
  assert.equal(kalshiTakerFeeCents(p), kalshiFeeCentsPerContract(R, p, 1), `legacy helper delegates to canonical at ${p}`)
}
assert.ok(Math.abs(kalshiTakerFeeCents(0.5) - 1.75) < 1e-9, 'fee at 50c is 1.75c, not the old 2c')
assert.ok(Math.abs(kalshiTakerFeeCents(0.95) - 0.34) < 1e-9, 'fee at 95c is 0.34c, not 1c')
assert.ok(Math.abs(kalshiTakerFeeCents(0.99) - 0.07) < 1e-9, 'fee at 99c is 0.07c, not 1c')
assert.equal(kalshiTakerFeeCents(0.1), 0.63)
ok('legacy helper delegates to the 4dp model')

// The size-aware helper must NOT round the per-contract figure up to a whole
// cent, or it would restore the overstatement it exists to remove.
assert.equal(kalshiTakerFeeCentsFor(0.02, 50), 0.1372)
assert.ok(kalshiTakerFeeCentsFor(0.02, 50) < 1, 'size-aware fee is fractional, not ceiled to a cent')
assert.equal(kalshiTakerOrderFeeDollars(0.02, 50), 0.0686)
ok('size-aware helper is exact')

// ---------------------------------------------------------------------------
// Series multipliers. feeRate carries them: 0.07 x mult.
// ---------------------------------------------------------------------------
assert.equal(kalshiTakerRate(1), R)
assert.equal(kalshiTakerRate(0.5), R * 0.5)
assert.equal(kalshiTakerRate(2), R * 2)
assert.equal(kalshiTakerRate(undefined), R)
assert.equal(kalshiTakerRate(null), R)
assert.equal(kalshiTakerRate(0), R)
assert.equal(kalshiTakerRate(-3), R)
assert.equal(kalshiTakerRate(NaN), R)
assert.equal(kalshiTakerRate(Infinity), R)
assert.equal(kalshiMakerRate(1), KALSHI_MAKER_FEE_COEF)
assert.equal(kalshiMakerRate(0.5), KALSHI_MAKER_FEE_COEF * 0.5)
ok('multiplier handling, degenerate inputs fall back to 1')

// ---------------------------------------------------------------------------
// Degenerate inputs must never produce NaN or a phantom charge.
// ---------------------------------------------------------------------------
for (const p of [0, 1, -1, 2, NaN, Infinity, -Infinity]) {
  assert.equal(kalshiOrderFeeDollars(R, p, 5), 0, `price ${p}`)
}
for (const c of [0, -5, NaN]) {
  assert.ok(Number.isFinite(kalshiOrderFeeDollars(R, 0.5, c)), `contracts ${c}`)
}
assert.equal(kalshiOrderFeeDollars(0, 0.5, 10), 0)
assert.equal(kalshiOrderFeeDollars(-0.07, 0.5, 10), 0)
assert.equal(kalshiOrderFeeDollars(NaN, 0.5, 10), 0)
ok('degenerate inputs are inert')

// Float dust must not push an exact 4dp total up a tick.
assert.equal(kalshiOrderFeeDollars(R, 0.5, 4), 0.07)
assert.equal(kalshiOrderFeeDollars(R, 1 / 7, 7), Math.ceil(0.07 * 7 * (1 / 7) * (1 - 1 / 7) * 10000 - 1e-9) / 10000)
ok('float-dust guard')

// ---------------------------------------------------------------------------
// N1: the invariant. entryFeeDollars (cash ledger) and the fee term inside
// netCentsOf (promotion metric) must agree at every size.
// ---------------------------------------------------------------------------
const cases: Array<[string, number]> = [
  ['YES', 0.5],
  ['NO', 0.5],
  ['YES', 0.02],
  ['NO', 0.07],
  ['YES', 0.93],
  ['NO', 0.35]
]
for (const [outcome, entryPrice] of cases) {
  // Fractional counts too (audit 2026-09-19, B-34): the ledger helpers take the fractional count like the venue.
  for (const shares of [0.5, 1, 1.075, 1.49, 2, 3, 10, 23, 50]) {
    const t = { outcome, entryPrice, shares, feeRate: R }
    const yesPx = outcome === 'YES' ? entryPrice : 1 - entryPrice
    const C = shares
    const feeTerm = kalshiFeeCentsPerContract(R, yesPx, C)

    // A win minus a loss is always the full 100c payout per contract.
    assert.ok(Math.abs(netCentsOf(t, 1) - netCentsOf(t, 0) - 100) < 1e-9, `win-loss spread at ${outcome}/${entryPrice}/C${C}`)
    // The win figure is the payout minus exactly that fee term.
    assert.ok(
      Math.abs(netCentsOf(t, 1) - ((1 - entryPrice) * 100 - feeTerm)) < 1e-9,
      `netCentsOf win leg at ${outcome}/${entryPrice}/C${C}`
    )
    // THE INVARIANT.
    assert.ok(
      Math.abs((entryFeeDollars(t) * 100) / C - feeTerm) < 1e-9,
      `entryFeeDollars vs netCentsOf fee term at ${outcome}/${entryPrice}/C${C}`
    )
  }
}
ok('N1 invariant holds at every contract count')

// Show the size of the pre-fix error, so a regression is unmistakable.
const bigT = { outcome: 'YES', entryPrice: 0.5, shares: 50, feeRate: R }
const trueTerm = kalshiFeeCentsPerContract(R, 0.5, 50)
const preFixTerm = trueTerm / 50
assert.ok(Math.abs(netCentsOf(bigT, 1) - (50 - trueTerm)) < 1e-9, "netCentsOf win leg on the big trade")
assert.ok((50 - preFixTerm) - netCentsOf(bigT, 1) > 1.7, "the pre-fix fee term UNDERSTATED the fee, so pre-fix netCents read ~Cx too optimistic")
assert.ok(Math.abs(entryFeeDollars(bigT) - 0.875) < 1e-9, "big-trade entry fee is 0.875 dollars")
ok('N1 pre-fix error magnitude characterised')

// The NO leg must cost the same fee as the equivalent YES leg: p(1-p) is
// symmetric, so the outcome price is safe to pass straight through.
for (const p of [0.02, 0.1, 0.5, 0.9]) {
  assert.equal(kalshiOrderFeeDollars(R, p, 10), kalshiOrderFeeDollars(R, 1 - p, 10), `fee symmetry at ${p}`)
}
ok('YES/NO fee symmetry')

// ---------------------------------------------------------------------------
// N2: the paper simulator must charge the venue's real (rounded) fee for
// Kalshi, while every other venue keeps its existing continuous model.
// ---------------------------------------------------------------------------
async function paperChecks(): Promise<void> {
  const quote = (price: number) => ({ venue: 'kalshi' as const, marketId: 'M1', outcome: 'YES', price, probability: price, timestamp: Date.now() })
  for (const [amount, price] of [[10, 0.5], [1, 0.02], [5, 0.33]] as Array<[number, number]>) {
    const broker = new PaperBroker('kalshi', 'USD', 1000)
    const res = await broker.buy(
      { venue: 'kalshi', marketId: 'M1', outcome: 'YES', amount, limitPrice: price, timeInForce: 'immediate_or_cancel', feeRate: R },
      quote(price)
    )
    assert.ok(res.shares > 0, `paper fill for ${amount}@${price}`)
    assert.ok(Math.abs((res.fee ?? 0) - kalshiOrderFeeDollars(R, price, res.shares)) < 1e-9, `kalshi paper fee at ${amount}@${price}`)
  }
  ok('paper simulator charges the Kalshi order-level fee')

  // A maker fill carries feeRate 0 (plain quadratic series), so it is free.
  const broker = new PaperBroker('kalshi', 'USD', 1000)
  const free = await broker.buy(
    { venue: 'kalshi', marketId: 'M1', outcome: 'YES', amount: 10, limitPrice: 0.5, timeInForce: 'good_till_canceled', feeRate: 0 },
    quote(0.5)
  )
  assert.equal(free.fee ?? 0, 0, 'maker fill on a plain quadratic series is fee-free')
  ok('maker fill is fee-free')

  // A non-Kalshi venue must be untouched by the Kalshi branch.
  const poly = new PaperBroker('polymarket-us', 'USD', 1000)
  const pres = await poly.buy(
    { venue: 'polymarket-us', marketId: 'M1', outcome: 'YES', amount: 1, limitPrice: 0.02, timeInForce: 'immediate_or_cancel', feeRate: R },
    { venue: 'polymarket-us', marketId: 'M1', outcome: 'YES', price: 0.02, probability: 0.02, timestamp: Date.now() }
  )
  assert.ok(pres.shares > 0, 'poly fill')
  assert.ok(Math.abs((pres.fee ?? 0) - R * pres.shares * 0.02 * 0.98) < 1e-9, 'non-Kalshi venues keep the continuous model')
  ok('other venues keep the continuous model')
}

paperChecks()
  .then(() => {
    console.log(`kalshi fee model: ${n} checks passed`)
  })
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
