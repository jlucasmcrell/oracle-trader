# Pre-registration: the challenger forecaster (paired read)

**Registered 2026-09-24, by the daily maintenance session, before the first read.** Backlog 65b/80c named today as
the read date and recorded that **no rule had ever been registered** while the challenger spends about $0.15 a day.
This document is that rule, written before its numbers were looked at: `node scripts/hunch-paired.mjs` reports 426
paired forecasts and **0 settled pairs**, so nothing is decidable yet and no verdict is being back-fitted.

## Claim under test

The challenger model, run alongside the incumbent on the same markets since 2026-09-12
(`hunchChallengerEnabled`, `src/main/strategies/hunch.ts`), forecasts settled outcomes better than the incumbent.
It is a shadow: it places no orders and changes no price the engine acts on. Its only cost is tokens.

## The rule (fixed)

Unit: the PAIRED difference, per market, of Brier score against the settled outcome - incumbent minus challenger,
so a positive difference means the challenger is better. Only markets where BOTH models forecast and the market has
settled count; `scripts/hunch-paired.mjs` is the reader. Band: day-clustered 80%, the bar every other shadow here is
read on.

- **Read at >= 20 paired AND settled markets.**
  - **No advantage** - the 80% band does not exclude zero on the challenger's side - **`hunchChallengerEnabled`
    goes to false.** A model that costs money and cannot be shown to be better does not keep running.
  - **Advantage** - lower bound above zero - the challenger stays on, and swapping it for the incumbent is its own
    pre-registration, because that would change a number the engine acts on.
- **If 20 paired-and-settled markets do not exist by 2026-10-24** (six weeks of spend for an unreadable
  experiment), `hunchChallengerEnabled` goes to false on that date regardless of what the partial numbers say. A
  registration whose evidence never arrives must still terminate; today's 426 paired / 0 settled is exactly that
  risk, and most of the challenger's markets close days out.

## Who acts

The maintenance session, on the read date, from the log and the report; the operator is not asked.
`hunchChallengerEnabled` is a shadow flag - it is not a size, a loss limit, a venue key or the global arm, all of
which stay the operator's. Nothing here places, amends or cancels an order.
