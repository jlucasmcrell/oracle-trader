# Review request prompt

Paste everything below the line into another model (one per model, fresh conversation). Models with web access
can read the repository directly; for models without it, attach the repository as files or a zip and delete the
"fetch it yourself" sentence.

The output is a report. Nothing in this prompt asks for code changes, and the reviewing model has no write
access to anything.

---

You are reviewing a real, running, open-source auto-trader for prediction markets. I am the operator. I want a
written report, not code: do not produce patches, pull requests, or rewritten files. Read, think, and report.

**Repository:** https://github.com/jlucasmcrell/oracle-trader (public, MIT). Fetch and read it yourself.

## What this system is

A single-operator desktop application (Electron + React + TypeScript) that trades prediction markets
automatically, at small size, with real money:

- **Kalshi** — live and funded, roughly $60 of cash, $1 per position. This is the only venue where strategies
  currently place real orders.
- **Polymarket US** — live account funded (~$40), every strategy on operator hold; an eight-account paper lab
  runs against live books.
- **IBKR / ForecastEx** — funded ($100), no strategy qualifies to go live; a 23-arm paper lab runs against the
  live gateway.

Runtime state (balances, fills, credentials) lives outside the repository and is not available to you. What is
in the repository is the code, the complete decision record, and the measured results.

## Read these first, in this order

1. `README.md` — orientation.
2. `docs/DEVELOPER-HANDBOOK.md` — architecture, operations, rules, and **§16 "Known defects, risks and sharp
   edges."** Findings already listed there are known; do not spend your report re-reporting them, though you
   may say one is worse than stated or wrongly closed.
3. `docs/reports/TRADE-HISTORY-2026-09-18-what-won-what-lost.md` — what has actually made and lost money.
4. `docs/REVIEW-CHANGES-2026-09-06.md` — the numbered change record. Large. Each round states the evidence that
   motivated a change and the read that will judge it. Skim for structure, read the rounds that touch whatever
   you end up focusing on.
5. `docs/BACKLOG.md` — everything deferred, each with a trigger condition. If you are about to recommend
   something, check here first: it may already be scheduled, and then the useful finding is "the trigger is
   wrong" or "this should be sooner," not the idea itself.
6. `docs/PREREGISTERED-*.md` — each strategy test, registered before it ran.

Then read the code that matters for your findings. The bulk of the trading logic is
`src/main/strategies/autoTrader.ts` (Kalshi arms and the entry gate), `src/main/strategies/leadLag.ts`,
`src/main/strategies/polyPaper.ts`, `src/main/strategies/ibkrLab.ts`, and `src/main/engine/engine.ts`.

## What I want you to cover

Cover as many of these as you can support with evidence. Depth on three areas beats a thin pass over all nine.

1. **Correctness defects.** Bugs that lose money, place wrong orders, miscount positions, mis-handle fills,
   corrupt state, or double-count. Concurrency, partial fills, restarts mid-order, timezone and settlement-time
   handling, rounding, and the paper-ledger/live-ledger split are the areas where this system has historically
   broken.
2. **Fee, settlement and venue mechanics.** Whether the modelled fees match each venue's published schedule and
   actual behavior, whether settlement semantics (strike inclusivity, "above/at least," upper-bound vs midpoint
   strikes, differing settlement sources across venues) are handled correctly. Errors here silently invert the
   sign of an edge.
3. **Statistical methodology.** This is the area I most want challenged. Is the evidence standard actually
   sound? Look for: multiple-comparisons across many simultaneous arms, survivorship and selection in what gets
   measured, confidence intervals computed on non-independent trades, pre-registrations that were amended after
   seeing data, "eras" chosen after the fact to make a result look real, and conclusions drawn from samples too
   small to support them. If a claimed edge in the trade history does not survive your own scrutiny, say so and
   show the arithmetic.
4. **Profitability.** Given the venue fee structures, the sizes, and the measured results: which arms have a
   plausible real edge, which are break-even spread capture being mistaken for edge, and which are losing in a
   way the current metrics hide? What is the realistic ceiling of this approach at this capital, and what would
   have to change for it to matter?
5. **Strategies not tried.** Structural and mechanical edges suited to prediction markets specifically — not
   generic equities strategies. Cross-venue and cross-market relationships, settlement-rule arbitrage, event
   decomposition and mutually-exclusive-outcome pricing, market-maker incentive and rebate programs, calendar
   and resolution-timing effects, information sources that are public and free and faster than the market.
   For each: the mechanism, why it should have an edge, what would falsify it, and the cheapest test.
6. **Risk.** Tail exposures, correlated positions that look independent, failure modes on restart or venue
   outage, anything that could lose materially more than the per-position size implies, and any way the
   position/loss caps can be bypassed.
7. **Engineering.** Architecture, testability, the areas where a defect would be expensive and the test coverage
   is thin. Practical improvements only.
8. **The record itself.** The docs are the operator's claims. Where does the code contradict what the docs say
   it does? A documented behavior that no longer matches the implementation is a finding.
9. **What is missing entirely.** Blind spots — things a system like this should have and this one does not.

## Constraints on your recommendations

Recommendations that violate these are not actionable, so do not make them:

- **Capital is about $200 total across three venues.** Nothing requiring meaningful capital, leverage, or
  institutional access.
- **Free data tiers only**, with one paid exception already in place (The Odds API). If a recommendation needs
  paid data, say what it costs and what it would have to return to be worth it.
- **No scraping of authenticated sessions**, no terms-of-service violations, no market manipulation.
- **US person.** Polymarket's global (non-US) venue is signal-only and cannot be traded.
- **Position sizes, loss limits, venue funding, and which strategies are allowed to go live are the operator's
  decisions**, not recommendations you should optimize around. You may say an edge deserves more size; do not
  build a recommendation whose only value comes from assuming more capital.
- **Single operator, no team, consumer hardware, Windows.**

## How to report findings

Be calibrated. Distinguish "I verified this in the code at this line" from "this is a hypothesis worth
checking." Overconfident findings waste more of my time than omitted ones. If you are not sure, say so and say
what would settle it.

Do not invent file paths, function names, line numbers, or API behaviors. If you could not verify something,
put it in the "could not check" section rather than guessing. I will be checking your citations.

For each finding:

```
ID:          short unique id, e.g. F-03
Area:        correctness | fees | methodology | profitability | strategy | risk | engineering | docs | missing
Severity:    critical | high | medium | low          (critical = loses money now, or will on the next restart)
Confidence:  verified | likely | hypothesis
Location:    file:line, or "N/A — design-level"
Claim:       one sentence.
Evidence:    what in the code or docs supports this. Quote the relevant lines.
Failure:     concrete scenario — specific inputs or state, and the wrong outcome that results.
Test:        the cheapest thing that would confirm or kill this.
```

Then close with:

- **Top 5 findings ranked by expected dollar impact**, with your reasoning for the ranking.
- **Strongest disagreement:** the one thing this operator believes, or is currently doing, that you think is
  most likely wrong. Commit to a position here rather than hedging.
- **Could not check:** what you could not verify without runtime access, private data, or venue documentation
  you do not have — and what you would need.

## Notes

This is a review of a software system and its measurement methodology. It is not a request for personalized
financial advice, and I am not asking you to predict any market. Evaluate whether the system does what it
claims, whether its claimed edges are real, and where its engineering and reasoning are weak.

Several other models are reviewing the same repository independently. Do not try to be comprehensive at the
expense of being right — a short report of well-evidenced findings is more useful than a long one padded with
generic advice. Anything you say that is true and non-obvious is worth more than anything you say that is
merely plausible.
