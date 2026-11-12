# Pre-registered: the late-game leader on Kalshi sports (paper)

Registered 2026-11-12, before the recorder wrote a row. Operator, shown the result of the top-winners study and asked
"Build both paper tests and push?": "Yes". It trades nothing.

## Where the idea came from

A study of 246 Polymarket leaderboard wallets (1.5M trades, 2026-10-20 to 11-12) found one pattern that survived on
wallets not chosen for a good month: sports bots buying the side at 70-97c in the 15-60 minutes before a game
resolved won 89% at an average 85c, about +5c a market (801 markets, strongest in the NBA). Longshots in the same
window lost. That is what other people bought on another venue; "late" was inferred from the resolution time.
Whether the same trade pays at Kalshi's ask is not known, and Kalshi's market makers see the same scoreboard.

The gated leg is the live lead-lag arm in a new place: enter only when Polymarket's price is ahead of Kalshi's.

## The recorder (fixed)

`scripts/lategame-shadow.mjs`, task `OracleTrader-LateGame`, public data only. For every live NBA, NFL and NHL game:
the scoreboard (ESPN's public feed), Kalshi's top of book for both game-winner contracts, and Polymarket's top of
book for the same game, every 5 s while any game is in its final period, every 30 s otherwise.

## The rule (fixed)

`scripts/lategame-gate.mjs`. Unit: one game. A row qualifies when the game is in the final period of regulation or in
overtime (NBA and NFL fourth quarter, NHL third period), one team is ahead, and that team's Kalshi YES ask is
**70c to 95c** with at least one contract offered.

- **blind**: the first qualifying row of the game.
- **gated**: the first qualifying row where Polymarket's mid for that team is at least **4c above Kalshi's ask**
  (Polymarket spread 5c or less).

One contract at Kalshi's ask, held to settlement, after Kalshi's taker fee rounded up to a whole cent. 90% band per
leg (two legs), clustered on the New York day. Printed beside it and deciding nothing: each league alone, and the
same contract's bid 60 s after entry.

## Decision (fixed, read by hand)

On or after **2026-11-27**, per leg, at 100 games on 10 New York days:

- **PASS**: band wholly above zero. A live arm is proposed under its own registration, at one contract.
- **FAIL**: band wholly below zero. The leg is closed.
- Otherwise continue to **2026-12-18**, then INCONCLUSIVE: closed, and the task is disabled.

## Known limits

The scoreboard is polled, not pushed, so a row's score can be a few seconds old; Kalshi's and Polymarket's books are
fetched within about a second of each other and each row carries both offsets. A fill at the ask is assumed for one
contract when at least one is displayed.
