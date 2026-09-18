# Oracle Trader  Queue-Preserving Shrink (Tier-1) & API Gap Completion

**Date:** 2026-09-18
**Scope:** Implementation of the remaining enhancements from AUDIT-REVIEW-VERIFICATION-2026-09-18.md and REPAIR-COMPLETE-2026-09-18.md, plus a correction to one earlier finding (D2).
**Status:** Code complete, verified, SAFE-BY-DEFAULT (new live-order mutation is OFF until explicitly enabled).
**No code was left in a broken or half-edited state.** `tsc --noEmit` exit 0; full test suite 15/15 passing.

---

## 1. Executive summary

This session completed the last outstanding enhancement  the quoter's **queue-preserving shrink ("Tier-1")**  and its supporting API primitives, and closed out the verification of two previously-open findings (D2 revised; two false leads already struck). The result:

- **Two new Kalshi adapter methods** (`decreaseOrder`, `getOrderQueuePosition`)  thin, inert wrappers.
- **Tier-1 shrink logic** in the quoter, gated behind a new `quoterDecreaseEnabled` config flag that **defaults to false** (shadow-log only, zero API calls).
- **Full config plumbing** (interface, persisted-config type, defaults, `quoterCfg()`).
- **D2 revised from "defect" to "correct, keep"**  with the reasoning documented so nobody "fixes" it back.

Nothing here touches live orders unless three conditions are all true: the quoter is live (`quoterEnabled: true`  currently **false**), the strategy is armed, and `quoterDecreaseEnabled` is explicitly set true.

---

## 2. What changed (5 files, all backed up first)

Byte-exact pre-edit backups are in `backups\_repair_20260918_enhance\` (venue.ts, kalshi.ts, quoter.ts, ipc.ts, autoTrader.ts). The apply script is also there (`apply_edits.py`) for reproducibility.

### 2.1 `src/shared/venue.ts`  VenueAdapter interface
Added two **optional** methods (optional = non-breaking for IBKR/other adapters):
```ts
decreaseOrder?(orderId: string, marketId: string, reduceTo: number): Promise<{ fillCount: number; remainingCount: number }>
getOrderQueuePosition?(orderId: string): Promise<number>
```

### 2.2 `src/main/venues/kalshi.ts`  the two implementations
- **`decreaseOrder(orderId, marketId, reduceTo)`**  `POST /portfolio/events/orders/{id}/decrease` with body `{ ticker, reduce_to, exchange_index? }`. Returns `{ fillCount, remainingCount }` parsed from the V2 order response. Shard-routed exactly like `amendOrder`.
- **`getOrderQueuePosition(orderId)`**  `GET /portfolio/orders/{id}/queue_position`, returns `queue_position_fp` as a number. Diagnostic only.

Key correctness decisions (all verified against Kalshi docs):
1. **`reduce_to`, never `reduce_by`.** `reduce_to` is idempotent; the HTTP adapter retries on timeout, and `reduce_by` (a delta) could double-apply on a retry. (Source: Kalshi API changelog  "exactly one of `reduce_by` or `reduce_to` must be provided".)
2. **`reduceTo` is the REMAINING count, not total fillable.** The decrease endpoint is documented as "decreasing the **remaining** count of an existing order." This is the *opposite* of `amendOrder`'s `count`, which is *total fillable* (= filled + remaining). So the caller passes `remaining - 1` directly, with no `filledSoFar` addition. **This was the one hazard that could have silently converted a shrink into a full cancel** (`reduce_to <= filledSoFar` completes the order)  now explicitly guarded by using remaining-count semantics.

### 2.3 `src/main/strategies/quoter.ts`  Tier-1 shrink
- New `QuoterConfig.quoterDecreaseEnabled?: boolean`.
- New `Quote.shrunkAt?: number`  a 60s cooldown stamp that prevents shrink/restore churn.
- New `decreased` counter on `QuoterState`/`QuoterStatus`, surfaced in `status()`.
- **Tier-1 block** inserted into the amend branch of the placement loop (lines ~9961027):

  When a resting quote experiences a **small adverse move**  fair value moved **1 to <3 away** from our side (YES bid: fair dropped; NO ask: fair rose)  and the quote is **not crossed** and has **remaining > 1**, the quoter shrinks the threatened side by 1 contract **in place** via `/decrease` instead of (a) leaving it to be picked off at the front of the queue, or (b) repricing (which forfeits the queue slot).

  The 60s cooldown gates **both** the shrink and the size-restore arm of the amend condition, so:
  - a persistent adverse move ratchets 321 once per minute, never back up while threatened;
  - a calm book restores size normally after the cooldown;
  - a genuine 3 move or a crossed book **still reprices immediately** (correct  the price is genuinely wrong there).

  When `quoterDecreaseEnabled` is false, the branch **logs the would-be decrease and `continue`s without any API call**  pure shadow instrumentation. It also samples `getOrderQueuePosition` (best-effort, `try/catch`) so the queue-position thesis becomes measurable.

### 2.4 `src/shared/ipc.ts` + `src/main/strategies/autoTrader.ts`  config
- `AutoTraderConfig.quoterDecreaseEnabled?: boolean` (ipc.ts).
- `DEFAULT_CONFIG.quoterDecreaseEnabled: false` and `quoterCfg()` plumbing (`cfg.quoterDecreaseEnabled ?? false`).

---

## 3. D2  revised from "defect" to "correct, keep"

**My earlier review confirmed D2**: "*`mult > 0 ? mult : 1` coerces a legitimate `fee_multiplier: 0` to full fee*" (AUDIT-REVIEW-VERIFICATION 4). **That confirmation was wrong.** On re-examination against the vendor docs and the canonical fee module:

1. `fee_multiplier` is documented as **"a floating point multiplier applied to the fee calculations"**  a plain multiplier, not a discount flag. In practice it is positive (`0.5` for reduced-fee S&P/Nasdaq series, `1` default, higher for high-fee series).
2. A fee-free/waived series is signalled by **`fee_waiver_expiration_time`** (a *separate* field the app already reads as `feeWaiverUntil`), **not** by `fee_multiplier: 0`.
3. The canonical module's `kalshiNormaliseMultiplier` already encodes the intent: *"0, negative or NaN is meaningless; treat it as an absent multiplier rather than as a discount."*
4. **Error direction is decisive** for a live-money app: coercing `0  1` **overstates** fees (safe  misses marginal trades, never loses money on a fee miscalc). Preserving `0` would **understate** fees (dangerous  enters trades that actually cost more).

**Conclusion:** `mult > 0 ? mult : 1` is the conservative, correct behavior. **No change made.** The inline coercion is functionally identical to `kalshiNormaliseMultiplier` (they differ only for `Infinity`, which JSON cannot produce). A cosmetic centralization into the canonical function is optional and was deliberately skipped to avoid touching the live fee path for zero functional benefit.

**Also struck as false leads this session (already noted in prior docs, restated for completeness):** N4/`ttl = 0` does not exist (the only series-fee TTL is `24 * 3600_000`); N5's "$1.00 entry IOC" is impossible (`clamp01` caps at 0.99); the `-1.93c` markout figure was unverifiable (quoter records no markout  `markWatch: []`) and the verified quoter signal is `placed 1432 / amended 793 (55%) / filled 33`; `engine.ts:495`'s `Math.round` is log formatting, not a fractional-contract bug.

---

## 4. New API surface (previously unimplemented  now addressed or documented)

| Endpoint / field | Status | Notes |
|---|---|---|
| `POST /portfolio/events/orders/{id}/decrease` (`reduce_to` \| `reduce_by`) | **Implemented** (`decreaseOrder`) | Remaining-count semantics; `reduce_to` chosen for idempotency. |
| `GET /portfolio/orders/{id}/queue_position` (`queue_position_fp`) | **Implemented** (`getOrderQueuePosition`) | 0-indexed contracts ahead of the order. Makes the quoter's repricing cost measurable. Batch variant `GET /portfolio/orders/queue_positions` exists but is not wrapped (not needed yet). |
| `fee_type = flat` | **Documented, not implemented** | `flat` series use the *Specific Trading Fees Table* (flat per-trade fee), **not** the quadratic `rate  C  P  (1-P)` model the app applies universally. The app would misprice flat series. Recommended: either implement the flat-fee table or **exclude `flat` series from taker flow** until the fee is known. |
| `fee_type = quadratic_with_combo_maker_fees` | **Documented, not implemented** | Maker multiplier 0.5 (vs 0.25 for `quadratic_with_maker_fees`), applies to combo/MVE markets. Low impact  MVE markets are already excluded  but worth an explicit `else` branch if MVE ever trades. |

---

## 5. Verification

- **Backups:** `backups\_repair_20260918_enhance\`  byte-exact copies of all 5 changed files, taken before editing.
- **Type check:** `npx tsc --noEmit`  exit 0 (no errors, including the optional-interface additions across adapters).
- **Tests:** full suite **15/15 passing, 0 failures** (`test:settlement-accounting`, `test:review`, `test:ladder`, `test:adversarial`, `test:risk`, `test:ibkr`, `test:ibkr-execution`, `test:ibkr-lab`, `test:remaining`, `test:completion`, `test:model-usage`, `test:execution-quality`, `test:collection`, `test:migration`, `test:fee`).
- **Edit integrity:** every insertion was anchored on a string verified to occur exactly once before writing; each changed region was read back and confirmed.

---

## 6. How to enable / test

The feature is **inert by default** and safe to leave as-is.

**Shadow observation (recommended first step, zero risk):**
1. Leave `quoterDecreaseEnabled: false`.
2. Set `quoterEnabled: true` (or observe existing shadow logs) so the live path runs.
3. Watch logs for `[quoter] tier1 shrink ... (shadow)` lines and the sampled `queue=` values.
4. Confirm the thesis: the would-be-shrunk cohort should show fewer/better fills than unshrunk quotes over enough ticks.

**Enable the real shrink (after shadow data supports it):**
1. Set `quoterDecreaseEnabled: true` in config (UI or persisted config).
2. Start small (the quoter's `quoterMaxContracts` is already 14 contracts/side).
3. Watch `status().decreased` and the `tier1 decrease failed` logs for any 400s.

**One residual to confirm before first live enable:** the `/decrease` request body was built by mirroring the working `amendOrder` (`ticker` + `exchange_index`). `reduce_to` is verified from the changelog; if the endpoint also requires `side`, add it in one line in `decreaseOrder`. A failed call is caught and logged (`tier1 decrease failed`), never fatal.

---

## 7. Remaining open items (exact specs for handoff)

These are the items from prior docs still genuinely open, in recommended order. None are required for the current testing phase.

1. **D1 empirical settlement** (HIGH, needs live API): measure whether the venue's charged fee matches `ceil_to_balance_precision(cost + ceil_6dp(modelFee))  cost` vs the app's cent-ceil. Gated on the canonical module (already done), so it is now a one-file experiment against `/series` + `/portfolio/balance`. Resolution decides whether the cent-ceil in the accounting path (`autoTrader.ts:4744`) should be dropped (the EV gate at `:2557` already uses the correct un-ceiled value).
2. **`flat` fee-type modeling** (MEDIUM): implement the Specific Trading Fees Table, or exclude `flat` series from taker strategies. See 4.
3. **D5 outcome-side storage** (LOW): persist `outcome_side` on fills and derive the verb/`filledYes` from it, rather than inferring.
4. **D3 incentive-program pagination** (LOW): `/incentive_programs` paginates; persist all rows instead of the first page.
5. **N3 remaining** (LOW, conservative as-is): the series fee cache is in-memory and resolves 20 series/scan; after restart it defaults to 1 until re-resolved. This **overstates** fees (safe direction). Persisting the cache to disk is optional.
6. **Manifold removal** (deferred per instruction): Manifold modules remain but are unused; removal is a standalone cleanup task.

---

## 8. Fee economics & strategy guidance (carried forward)

Round-trip taker fee in ticks at the sizes a **$1 stake** actually produces:

| Contract price | Contracts per $1 | Round-trip fee (ticks) | Implication |
|---|---|---|---|
| 0.02 | 50 | 0.28 | nearly fee-free |
| 0.10 | 10 | 1.40 | cheap |
| 0.50 | 2 | 4.0 | **worst**  needs >4 mispricing to break even |
| 0.80 | 1 | 2.0 | the order-level ceil barely amortises |

**Actionable:** a taker strategy on a 5080 contract needs **>4 of mispricing just to break even**; one on a 5 contract needs 0.7. This alone explains which arms can and cannot work. **Maker flow is structurally advantaged**  maker fee is exactly **0** on plain-`quadratic` series (`kalshi.ts:1430`; only `quadratic_with_maker_fees` carries a 0.0175mult maker fee). Recommendation: route taker flow to the cheap and 0.90 bands; reserve the mid band (0.30.7) for resting/maker orders.

---

## 9. Risk notes

- The Tier-1 shrink **cannot** fire in the current default configuration (quoter off, decrease off). Enabling it is a two-flag decision.
- `decreaseOrder` is idempotent by construction (`reduce_to`) and failure-safe (caught + logged; the quote is left as-is on error).
- `getOrderQueuePosition` is diagnostic-only; a 404 (if the endpoint path were wrong) is caught and rendered as `queue=?` in the log  never fatal.
- The 60s cooldown (`shrinkCooldownMs`, one constant in the amend block) is the single tuning knob for shrink/restore behaviour; it is intentionally conservative.
