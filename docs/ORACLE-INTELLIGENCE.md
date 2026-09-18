# Oracle Intelligence Engine

Implemented 2026-09-04 as a shadow-first replacement for permissive single-prompt vetting.

## Safety contract

- Deterministic strategy and portfolio gates remain authoritative.
- AI can only ALLOW_UNCHANGED, VETO, or ABSTAIN.
- AI cannot reverse direction, increase size, loosen a limit, or bypass a hard gate.
- Shadow mode never changes an order.
- Veto mode must be enabled explicitly after counterfactual evidence supports it.

## Decision path

1. Build a timestamped candidate packet from the executable book, exact one-contract fee, proposed side, strategy evidence, portfolio state, rules, and available headlines.
2. Route through OpenRouter with fallback: GPT-5.6 SOL, DeepSeek V4 Pro, GLM-5.3.
3. Require strict JSON-schema output with a conservative P(YES) interval.
4. Validate types, bounds, interval ordering, evidence citations, rule risk, and evidence sufficiency.
5. Calculate conservative edge in code from the unfavorable probability bound, executable price, exact fee, and slippage reserve.
6. Append the complete point-in-time record to `%APPDATA%/oracle-trader/intelligence/decisions.jsonl`.

## Current posture

`intelligenceEnabled=true`, `intelligenceMode=shadow`. Existing micro-live strategies are unchanged. The engine reviews only rules-eligible candidates in the main Kalshi scanner. Latency-sensitive BTC convergence remains deterministic; AI is not inserted in its execution path.

## Reporting

Run `npm run intelligence:report` for decision counts by model, strategy and action. Decision telemetry is not profitability. Promotion to veto-only authority requires settlement-linked counterfactual evidence showing improved net P&L or reduced drawdown after API cost.
