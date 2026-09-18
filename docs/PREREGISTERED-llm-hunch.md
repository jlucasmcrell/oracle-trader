# Pre-registered test: LLM "hunch" forecasts vs Kalshi's price

Registered 2026-09-02 14:05Z, BEFORE the first hunch was logged. Nothing below changes after
data starts; amendments are dated and restart scoring.

## Question

Can a general reasoning model, given the market's own rules text plus fresh public headlines
at decision time, produce probabilities that beat Kalshi's price on low-attention,
news-driven markets? The app's existing LLM was graded as a VETO and added nothing
(counterfactual ledger, 2026-09-01). This is the generator version, forward-only, because any
backtest is contaminated by what the model may already know about settled outcomes.

## The rule (fixed)

Model: `deepseek-v4-pro` via the app's configured endpoint, thinking disabled, temperature 0.

Universe: Kalshi markets (production, public data) whose SERIES category matches
Politics / World / Elections / Entertainment / Climate and Weather / Science / Companies /
Health / Social, EXCLUDING numeric ladders (rates, gas, commodities, FX, CPI/payrolls/GDP,
Truflation indexes) and anything Sports/Crypto/Commodities/Financials. Close between 12 hours
and 30 days ahead; mid price between 5c and 95c.

Cadence: one pass every 8 hours; at most 100 markets per pass, soonest close first; a market
is hunched at most once per 20 hours. THE FIRST HUNCH ON A MARKET is the one the trading rule
scores (later hunches are logged for lead-time analysis only).

Inputs the model sees: title, rules text (truncated), close time, the current yes bid/ask, up
to 8 Google News headlines (title, source, date) retrieved at decision time for the market's
subject, and for rain markets the NWS point forecast for the city. Nothing else.

Output: `p_yes` in [0.01, 0.99]. Logged with the market's mid/bid/ask at decision time.

Trading rule: when `|p_yes - mid| >= threshold` for threshold in {0.10, 0.15, 0.25}, buy the
side the model favors at the current ask (YES at yes_ask; NO at 1 - yes_bid), TAKER, Kalshi
fee `ceil(0.07 * contracts * p * (1-p) * 100)/100` with `contracts = floor(10 / cost)`, graded
at settlement. One trade per market.

## The gate (fixed)

Pass requires ALL of:

1. At least 200 settled markets with a scored first hunch, clustered by `event_ticker`.
2. Brier(model) < Brier(mid) with the event-clustered 95% interval on the per-market
   difference excluding zero. (Does the model know something the market does not?)
3. For at least one threshold cell, event-clustered mean net taker cents per contract with a
   Bonferroni-corrected interval (3 cells: z = 2.39) whose lower bound exceeds +1.0c; the
   day-clustered interval must also exclude zero.
4. Report the result split by category; a pass carried entirely by one category is reported
   as such and only that category is eligible for the next stage.

Fail on any one, and no hunch-driven trading is built. Passing authorizes the same path as
the other pre-registered rules: minimal implementation, then tiny-live ($1-2 per contract,
capped), never money directly.

## What is NOT allowed

- Re-selecting the model, prompt, universe, or thresholds after seeing results.
- Scoring later-lead hunches as if they were the first.
- Counting a market whose settlement the model could have seen at decision time (close
  time must be after the hunch timestamp by at least 12 hours; enforced by the universe rule).

## Amendments

- 2026-09-02 14:10Z - The first pass (14:01Z) was discarded before any scoring: the model's
  reasoning overflowed a 500-token limit before the JSON on 5 of 6 markets, and the universe
  filter admitted numeric-bucket markets (temperature ladders, an exact-value approval bucket)
  that the rule never intended. Fixes: JSON response mode with full headroom; any market with a
  floor or cap strike is excluded. The rule, thresholds, and gate are unchanged; data starts
  from the next pass.
