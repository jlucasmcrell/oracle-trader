# Pre-registered: Kalshi leads Polymarket US in play (live micro-test)

Registered 2026-09-22, before the first order. Operator: "Get Poly back up, it hasn't been doing great in paper, but
again, maybe it needs a complete review."

## Claim under test

Polymarket US is a slow venue: in `data/sports-books` its top of book is unchanged in ~92% of 60-second cycles
(63% in play). When, in play, Kalshi's price for a team moves between two consecutive cycles and Polymarket US's
price for the same team does not, Polymarket US is still quoting the old game state. Buying on Polymarket US the side
Kalshi moved toward, and holding to settlement, earns after Polymarket US's taker fee. The mispricing closes over
minutes (by the next cycle only 23-29% of it; by five cycles 75-87%), so a 60-second loop is fast enough - this is
not a millisecond race.

## Evidence before registration (and why it is not the verdict)

`scripts/backtests/polyus_lag.py --public-results` on 2026-09-18..09-22, every market resolved from Kalshi's public
results, the exact trigger the app runs (`lagTrigger`, identical trigger for trigger on the recorded books), in play,
at least one contract at the price. Band = 95%, clustered by game.

| Kalshi move | every trigger | | first trigger per game (what the trader can hold) | |
|---|---|---|---|---|
| >= 3c | 639, +6.5c | [+1.9, +11.2] | 96 games, -1.4c | [-10.2, +7.5] |
| >= 5c | 307, +10.3c | [+3.5, +17.1] | 70 games, +4.0c | [-7.1, +14.8] |
| **>= 8c (primary)** | 113, +12.9c | [+2.9, +23.2] | **38 games, +14.9c** | **[+0.1, +28.9]** |

The first draft of this registration named 5c. It was changed to 8c before any order, for one reason: the trader holds
one position per market to settlement, and Polymarket US nets opposite buys on a market into one position, so a game
gives one entry - and at 5c the per-trigger edge came from re-entering the same game four or five times (first
trigger per game: +4.0c, band across zero). At 8c the edge is the same per trigger and per game. That choice was made
after comparing sixteen entry rules on the same five days, so these in-sample numbers flatter the rule; they are the
reason to test, not the result. Other limits: five days; four leagues (NFL, NCAAF, MLB, WNBA); most of it recorded
while the recorder dropped games early; fills assumed at the recorded top of book seconds before an order would
arrive. Only live fills count below.

## The rule (fixed)

`src/main/strategies/polyusLag.ts` `lagTrigger` with `LAG_DEFAULTS`: in play; Kalshi mid moved >= 8c since the
previous cycle 30-100 s earlier; Polymarket US's implied price for the team moved < 1c; the side bought still >= 1c
below Kalshi's new price after Polymarket US's taker fee; at least one contract at that price. A taker order at that
price, refused when a fresh book is already more than one tick worse; the Polymarket US trader's standard $1 stake;
**one entry per Polymarket US market per game** (the first trigger that fills); held to settlement. Arm
`polyus-lag` on the ladder, trader strategy `lag`.

## Size and risk

$1 per trade. At most 10 entries a day. The Polymarket US trader's own daily loss cap ($10) and the ladder's standard
rules apply. Worst single trade: the stake.

## Decision (fixed)

- The cohort starts at the first live order under this rule.
- **Read at 60 settled entries over at least 15 games, or on 2026-10-13, whichever comes first.** The unit is the
  entry; the band is clustered by game.
- **PASS**: the 80% band's lower bound above zero per contract after fees. The ladder may then scale it under its own
  rules; M = 5c with re-entry may be proposed as a separate registration.
- **FAIL**: the band's upper bound below zero, or the live fill price averaging more than 2c worse than the price the
  rule saw (the edge would be a recording artefact). Stop and close the registration.
- Otherwise: continue to 150 entries.
- Also reported, from the research log (`lag-trigger`, `lag-gone`, `lag-nofill`, `lag-fill`): how often an order found
  the price already gone, which measures how stale "stale" was.
- Also reported: results by league. The evidence covered NFL, NCAAF, MLB and WNBA; the rule takes every league the
  matcher maps (NHL, MLS and the European football leagues included), so a league outside the evidence is read
  separately before it counts toward scaling.

## Amendment 2026-09-23 (section 162) - the first entry was not the registered order

The rule is a taker order at the price the trigger saw, one tick of slippage at most. The build that went live sent a
Polymarket US MARKET order with a slippage band, and the band did not bound a short-side buy: the first entry
(GSV-POR, 2026-09-23 03:49Z, short side seen at 0.17, gap 21.5c) bought 2.38 contracts at an average 0.42 and won
(+$1.34). It was 25c worse than the price seen, so it is **excluded from the cohort**, which now starts at the first
order sent as an immediate-or-cancel LIMIT one tick through the price seen (the build deployed 2026-09-23 07:21Z). That order
cannot fill worse than a tick; it fills at the price seen or not at all.

What the first night showed, reported here because it bears on the FAIL condition: 22 triggers (13 MLB, 9 WNBA), 17
orders, **none filled at the displayed price** - 7 found the book already moved more than a tick when re-read 5 s
later, 9 sent and filled nothing, 1 filled 25c worse (above); the other 5 were the same game while the position was
held. In the GSV-POR case the displayed book did not move from 0.83 x 25,216 / 0.84 x 37,725 between 03:47 and
03:52Z while Kalshi went 0.75 to 0.54, and the order executed near Kalshi's price. If the in-play book this endpoint
shows is mostly not what can be traded, the measured edge is an artefact of the recording - the registration's own
FAIL condition - and the IOC limit now measures exactly that: fills at the price seen, or none.
