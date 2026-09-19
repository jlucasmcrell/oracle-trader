# Pre-registration: Polymarket CLOB WebSocket as lead-lag's quote feed (shadow first)

**Registered 2026-09-19 10:45Z, before any row exists.** Operator asked for the free latency work (§131).

## Hypothesis

Lead-lag polls the Polymarket CLOB book by REST once a minute per pair. The CLOB market WebSocket pushes
every top-of-book change for free. If (a) the pushed top agrees with the REST book at the instant of the poll
and (b) the top moves several times between polls, then the arm is reacting to a 60-second-old picture of the
leader and an event-driven read of Kalshi on WebSocket moves would find dislocations the poll never sees.
Neither is assumed; both are measured.

## What is recorded (no behaviour change)

`src/main/services/polyClobWs.ts` keeps a pushed top per watched token. Every dislocation row in
`leadlag-dislocations.jsonl` written from this registration on carries `polyWs: { bid, ask, ageMs, changes }` -
the socket's top at decision time, its age, and the number of top changes since the token was subscribed
(windows roll every 15 minutes, so `changes` is a per-window count). The REST book (`polyBid`/`polyAsk`) is
unchanged and remains the price the engine acts on.

## Decision units and read

Rows with `polyWs.ageMs <= 5000`, per UTC day, five days minimum, read on **2026-09-24** or later.

1. **Agreement.** Share of rows where |polyWs.bid − polyBid| ≤ 1c and |polyWs.ask − polyAsk| ≤ 1c. PASS at
   ≥ 98% over ≥ 500 rows. Below that the socket's interpretation is wrong or stale and nothing else is read.
2. **Opportunity.** Median and p90 of `changes` per window at decision time. If the median is < 3, the book
   rarely moves between polls and the socket is a convenience, not an edge: the registration closes there.
3. **Only if both pass:** a second registration for an event-driven Kalshi read (WebSocket move → fresh Kalshi
   orderbook → the existing gate), with the per-ticker window cap of one sweep kept (the 10 s cadence lesson,
   §108: re-sweeping a window at the same latency lost money). No live change under this registration.

## What PASS earns

A proposal, not a switch. Any change to the quote the live arm acts on is its own pre-registration with the
five-cluster bar and the +1.5c/contract planning number (handbook §12.17).

**Amendment 2026-09-19 11:00Z - who acts on PASS.** The operator will not be asked. If both reads pass on or
after 2026-09-24, the maintainer writes the follow-on registration for the event-driven Kalshi read and ships it
as a shadow first; if THAT passes its own five-cluster read, the maintainer switches the live arm's quote source
and reports it, the way every lead-lag configuration change to date was made (gap floor, cadence, coin set).
Nothing here touches sizes, loss limits, funding, keys or the global arm, which stay the operator's. The read
dates are surfaced automatically: `scripts/due-triggers.mjs` runs before every daily maintenance session and
pushes the due list to the operator's alert webhook.
