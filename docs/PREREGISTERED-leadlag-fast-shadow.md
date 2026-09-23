# Pre-registered: lead-lag at event speed (shadow)

Registered 2026-09-22, before the first row exists. Operator: "I still don't understand why we can't order in
milliseconds. Do I need to co-locate somewhere?"

## Why this exists

Measured the same day (REVIEW-CHANGES section 159): once lead-lag sees a gap it acts in milliseconds - gap to fill or
cancel median 60 ms (p90 107 ms), Kalshi's answer to an order median 45 ms, network to Kalshi 13-29 ms. What is slow
is how often it looks: once every 60 seconds. The only edge this app ever had was lead-lag catching Kalshi orders not
yet updated after a Bitcoin move (section 156), and the spot-first shadow found gaps by its model lasting a median
2 s. A once-a-minute look cannot see a two-second gap except by luck. Both venues already push their books to this
app; nothing acted on them.

## Claim under test

With both books held in memory and checked every 250 ms, Polymarket-vs-Kalshi gaps that clear Kalshi's taker fee
(a) occur often enough to matter and (b) pay when bought at the Kalshi price available the moment they open, held to
settlement.

## Instrument

`fastGaps` in `src/main/strategies/leadLag.ts`, run by the lead-lag engine on a 250 ms timer; a second Kalshi
WebSocket book client for the 15-minute windows; Polymarket's CLOB socket top. Rows in
`%APPDATA%/oracle-trader/leadlag-fast-shadow.jsonl`: 'open' when a side's net gap first reaches 2c, 'close' with its
duration. Refusals are in the code and the tests: the last minute of a window, a Polymarket top older than 5 s or
wider than 5c, prices outside 5-95c, a Kalshi book the client has not confirmed live. It records only; it has no
order path.

## Decision (fixed)

- Grader: `python scripts/backtests/leadlag_fast_shadow.py --since <first row>`.
- **Read on or after 2026-09-26**, and only with at least 3 UTC days of rows.
- **Primary threshold: 6c net** (the live arm's floor). Decision unit: the first gap per market and side.
- **PASS**: at least 150 settled decisions and a day-clustered 80% band whose lower bound is above zero. PASS earns a
  proposal to the operator for an event-driven live path at one contract through the ladder - nothing automatic.
- **FAIL**: the band's upper bound below zero. Then gaps at event speed are not an edge for us either, and lead-lag
  stays a one-contract probe.
- Otherwise: keep recording to 2026-10-03 and read again.
- **Reported whatever the verdict**: gaps per hour and their durations (median, p90, share under 1 s and 5 s). If the
  gaps that pay last under ~100 ms, being faster than this machine's 60 ms order path would be required, and the
  honest answer to "do we need to co-locate" becomes yes; if they last seconds, it is no.

## Amendment 2026-09-23 (sections 161, 163) - the read runs itself and acts

Operator, before the read: "I will not remember to flip switches on the 26th. If anything requires me remembering to
do something, it will never happen, things should be automatic." So the rule above is now code
(`src/main/ladder/registeredReads.ts`, `fastLeadLagRead`), run by the app once a UTC day from 2026-09-26: the same
statistic as the grader (first settled gap per market and side at 6c net, bought at the opening price plus Kalshi's
one-contract fee, day-clustered 80% band), the same thresholds (3 UTC days of rows; PASS at n >= 150 and a lower bound
above zero; FAIL at an upper bound below zero; otherwise read again the next day until 2026-10-03). **A PASS switches
`leadLagFastLive` on by itself** (one contract per first gap, under the lead-lag arm's ladder stage and caps); a FAIL or
a still-open result on 2026-10-03 leaves it off. Every decided verdict is pushed to the alert webhook. The rule itself
is unchanged; only who carries it out.
