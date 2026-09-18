# Fee Model Verification Against LIVE Fills
**Date:** 2026-09-18 ~10:30 local
**Scope:** validate the D1 four-decimal Kalshi fee model against fills the app itself produced.
**Code changed:** none. This is a measurement.

## 1. What was asked

Before scaling, confirm the D1 fee model (settled earlier today at 4-decimal precision) against
**live fills**, not just the historical ones it was derived from. No API calls, no credentials -
the reconciler archive only.

## 2. Data

`C:\Users\<user>\AppData\Roaming\oracle-trader\fill-reconciler-kalshi.json.fills.jsonl`
- 2857 fill rows, 2857 unique `id`, 2534 distinct `orderId`
- 251 orderIds have more than one fill row (323 extra rows) - partial fills exist
- 1867 fee-bearing (taker), 990 zero-fee (maker)
- span 2026-09-02 16:00Z .. 2026-09-18 14:00Z

## 3. Result: the 4dp model is confirmed

Exact-match rate on the 1867 fee-bearing fills:

| fee model | exact match | % |
|---|---|---|
| **4dp ceil (current)** | **1703** | **91.2%** |
| 6dp ceil (the original audit's claim) | 189 | 10.1% |
| cent ceil (the pre-fix code) | 36 | 1.9% |

Aggregate dollars, fee-bearing fills only:

| | |
|---|---|
| actually charged | **$77.12162** |
| 4dp ceil model | $78.94840 |
| overstatement | **$1.82678  = +2.37%** |

Segmented by order shape:

| segment | fills | fee-bearing | exact | actual | model | delta |
|---|---|---|---|---|---|---|
| single-row orders | 2283 | 1494 | 96.7% | $68.0973 | $69.8178 | +2.53% |
| multi-row orders | 574 | 373 | 69.2% | $9.0243 | $9.1306 | +1.18% |

**Conclusion: D1 stands. The 4dp model is correct and, on clean single-fill orders, exact 96.7% of
the time.** The old cent-ceil was catastrophic by comparison (1.9%).

## 4. Rounding direction - a minor, safe deviation

On 93-106 fills the actual fee is **exactly 1e-4 lower** than the ceiling, and on **zero** fills is
it higher. Total dollar value of this: **$0.00915**. The venue is not strictly ceiling at the 4th
decimal; it rounds down in some path (most consistent with round-to-nearest at a finer precision).

This is negligible and it errs **conservative** (we estimate a slightly higher fee than charged).
**Do not chase it.** Recorded so nobody runs the same query and "fixes" the ceil.

## 5. The 990 maker fills - the number that actually matters

The venue charged **$0.00** on 990 fills. If the taker model were ever applied to those, it would
predict **$16.03910** of phantom fees - **21% of all fees in the archive**.

So the single largest fee-correctness risk in this codebase is not precision, it is
**classifying maker vs taker before applying the model**. The code applies `maker ? 0`, which is
correct. This section exists to give that guard a number: misclassifying maker flow as taker costs
**$16 per 990 fills**, roughly 9x the entire precision residual.

## 6. Residual anomaly: 71 fills, 3.8%

71 taker fills (3.8%) do not match any rounding rule. They account for **$1.81763 of the
$1.82678 total overstatement** - i.e. essentially all of it.

Signature:
- every one is a **round-dollar notional** - `amount` exactly $1.00 or $3.00
- the venue's own `fee` implies a count **exactly 1/4** (38 fills) or 1/2 (9 fills) of the
  venue's own reported `shares`, with a long tail 0.58-0.95 (13 fills)

Worked example:

```
KXUCLGAME-26SEP09PSGSLO-PSG  sell NO  p=0.05  shares=60  amount=3.00  fee=0.0499
   0.07 * 60 * 0.05 * 0.95 = 0.1995           <- what the model predicts
   0.07 * 15 * 0.05 * 0.95 = 0.049875 ->0.0499 <- what the venue charged
```

Venue-reported `shares` and venue-reported `fee` disagree by 4x, on the same row.

**Cause: NOT DETERMINED, and I am not going to guess.** The candidates are (a) a Kalshi-side
reporting quirk on fills that are part of a multi-level sweep, where fee is summed per level while
count is reported in aggregate, or (b) an order-level fee-rounding residue attributed to one fill.
Resolving it needs one probe of a specific orderId against the live API. It is not resolvable from
the archive.

**Impact: immaterial in dollars ($1.83 total) and it errs conservative** - the EV gate would
overstate the fee and skip a marginal trade, never the reverse. **Recommendation: do not change
code. Log the marketIds and re-check when convenient.**

Note for whoever picks this up: the app sizes orders as `amountPerTrade / price`, i.e. **round
dollars** - the exact shape this anomaly appears on. Worth understanding before scaling, even
though it currently costs nothing.

## 7. A test of mine that could not fail

`fillReconciler.ts:79` builds the archive record as:

```ts
amount: Math.round(f.shares * f.price * 1e6) / 1e6,
shares: f.shares,
```

`amount` is **derived** from `shares` and `price`. So the check I ran - "does `amount == shares *
price` on every row?" - was an identity by construction and returned "0 inconsistencies on 2857
rows" for free. It proved nothing.

This is the third vacuous check in this engagement (previously: a PII scan that returned 0 for a
string known to be present; a bundle grep that misinterpreted esbuild constant folding). Pattern:
**a green result is not evidence unless you have first confirmed the check can go red.** Where
possible, run it against a known-bad input before trusting it.

The consequence here is mild - `shares` and `fee` are both taken straight from the venue, so the
anomaly in section 6 is genuinely a venue-side disagreement, not an app artefact - but I would
have reported the wrong thing if I had trusted that check.

## 8. Verdict

- D1's 4dp model: **confirmed on live data.** 91.2% exact overall, 96.7% on clean fills, +2.37%.
- Corrects the mid-investigation figure of "+23.17%", which was my own scripting error: I summed
  the model over *all* rows including the 990 maker fills the venue correctly charged zero for.
  The true taker-only overstatement is **+2.37%**.
- No code change is warranted from this verification.
- The largest fee risk in the codebase is maker/taker classification ($16 phantom per 990 fills),
  not rounding precision ($0.009) or the residual anomaly ($1.83).

## 9. Housekeeping found while here

- `data/sentinel/incidents/2026-09-18T12-05-maintenance-failed.md` is **still OPEN** (last failure
  07:05 local). The 11:30 catch-up trigger is the first run that can succeed (quota resets 11:00).
- **81 `.bak` files sit inside `src/`** and none are tracked by git. They inflate any recursive
  grep - the Manifold scope query returned 48 `src/` hits where the true tracked count is lower.
  This has already cost accuracy in this engagement. Recommend moving them out of `src/`.
