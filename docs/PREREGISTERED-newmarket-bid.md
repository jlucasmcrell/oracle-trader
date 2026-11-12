# Pre-registered: a resting bid against early favourites in brand-new markets (paper)

Registered 2026-11-12, before the recorder wrote a row. Operator, shown the result of the new-markets study and asked
"Build both paper tests and push?": "Yes". It trades nothing.

## Where the idea came from

A study of 23,955 Kalshi markets opened since 2026-10-01 found that every taker rule in a market's first hour loses
3 to 15c (opening spreads are enormous). The one positive number was on the passive side: takers who paid over 85c in
the first hour lost 4.2c after the fee, and whoever sold to them made about +3.9c a contract [+1.7, +6.0] (319
markets, 32 days), nearly all of it in Sports, Mentions and Entertainment (+9.8c; that split was found by slicing).

That is a ceiling measured on other people's fills. A new order joins the back of the queue: it fills less often and
on worse prints. The study could not measure that, and it treated the maker fee as zero, which is wrong for series
that charge makers (the NBA, NFL and NHL game series do). This test measures both.

## The recorder (fixed)

`scripts/newmarket-shadow.mjs`, task `OracleTrader-NewMarkets`, public data only. Every binary market in the Sports,
Mentions and Entertainment categories, from the minute it opens until 60 minutes later: best bid and its size on both
sides every 20 s, then every print of that hour.

## The rule (fixed)

`scripts/newmarket-gate.mjs`. Unit: one market. At the first book row in the first 60 minutes where one side's best
ask is **88c to 95c**, a paper post-only bid for **one contract** on the other side at 100 minus that ask. That is
the price of the best bid already there, so the order stands behind all of its displayed size. It is cancelled 60
minutes after the market opened. One order per market.

A fill counts only when later prints, before the cancel, either trade **through** the price, or trade **at** the
price for more than the size that was displayed ahead of the order. Size that was ahead and later cancelled is not
credited. Held to settlement, after the maker fee where the series charges one, rounded up to a whole cent.

90% band clustered on the New York day. Printed beside it and deciding nothing: each category alone, and the share of
paper bids that filled.

## Decision (fixed, read by hand)

On or after **2026-11-27**, at 50 fills on 10 New York days:

- **PASS**: band wholly above zero and a mean of at least **+2c**. A live arm is proposed under its own
  registration, at one contract.
- **FAIL**: mean under +2c. Closed, and the task is disabled.
- Otherwise continue to **2026-12-18**, then INCONCLUSIVE: closed, and the task is disabled.

## Known limits

A market created more than 26 hours before it opens is missed. At most 1,000 markets are tracked at once; a burst
beyond that is skipped and counted in the log. The book is sampled every 20 s, so size that joined ahead of the paper
order between two samples is not seen (the fill rule is generous by that much), and size that cancelled is not
credited (strict by that much).
