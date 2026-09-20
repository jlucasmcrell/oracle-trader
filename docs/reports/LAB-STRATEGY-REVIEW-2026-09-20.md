# Paper-lab strategy review — Polymarket US and IBKR ForecastEx

Read-only, 2026-09-20 09:00Z, at the operator's request. Every number is recomputed from the labs' own ledgers,
contract-weighted with a day-clustered 80% band (`scripts/backtests/degraded.py` conventions), counting only
trades opened under each lab's current rules. Neither lab's configuration was changed.

Coverage against `docs/DEGRADED-WINDOWS.md`: both cohorts begin after the execution window closed
(09-17 08:07Z), so neither is contaminated by it.

---

## 1. Polymarket US — the lab is measuring its own friction

**Cohort:** 210 closed trades over 0.94 days (the lab was reset to live cash, $39.85 per account, on 09-19 09:38Z).

| arm | n | net $ | c/contract | 80% band | maker fills |
|---|---|---|---|---|---|
| favorite (control, holds) | 3 | +0.03 | +1.17 | one day | 0 |
| pressure | 1 | -0.05 | -5.00 | one day | 1 |
| improve | 1 | -0.05 | -5.00 | one day | 1 |
| **benchmark (control)** | **191** | **-10.43** | **-5.46** | **[-6.32, -4.60]** | 0 |
| longshot (control, holds) | 3 | -0.18 | -6.00 | one day | 0 |
| momentum | 7 | -0.60 | -8.57 | [-10.96, -6.18] | 0 |
| reversion | 4 | -0.40 | -10.00 | [-11.54, -8.46] | 0 |
| join | 0 | — | — | never filled | 0 |

**The control is 91% of the sample.** The benchmark takes any market on an alternating side and traded 204 times a
day; the signal arms traded 1 to 7 times each. Whatever the lab is learning, it is learning it about the control.

**Nothing exits on its own terms.** 204 of 210 closes are the 15-minute timer. The profit target (+3c net) and the
stop (-5c from the mark) have never fired. Per trade: gross move **-3.24c**, fees **2.32c**, net **-5.56c**. A
taker entry at ask+1c and a taker exit at bid-1c fifteen minutes later costs about five and a half cents, and the
quote does not move enough in fifteen minutes to pay for it. **No arm can show a positive result under this design
unless its signal predicts more than ~6c inside fifteen minutes**, which on these books is rare.

**Two arms are decisively worse than doing nothing.** momentum (-8.57) and reversion (-10.00) both sit with their
whole band below the control's -5.46. On this venue and horizon, following a 3c move and fading a 4c move are each
worse than an alternating coin flip. That is a real finding, and the clearest one the lab has produced.

**The strategically interesting arms produce no data.** join has never filled once. improve and pressure have one
trade each. The maker rebate is the only income on this venue that does not require being right about anything
(-0.0125 x p(1-p) per contract, plus the unmodelled liquidity incentive pools), and the three arms that would
measure it are the three with no sample. At the observed rate: momentum reaches the lab's 100-trade gate in 12
days, reversion 22, the controls 30, improve and pressure 93, join never.

**Why the passive arms starve.** The lab tracks **12 markets at a time**, resampled from ~5,000 eligible every 30
minutes. A resting order needs a later executable trade-through on a market that is still being tracked; the
rotation removes most of them first.

---

## 2. IBKR ForecastEx — the entry price is the whole result

**Cohort:** 274 closed trades over 3.1 days, 281 markets in the universe, 90 positions still open.

| arm | n | contracts | net $ | c/contract | 80% band | days |
|---|---|---|---|---|---|---|
| spot-first | 3 | 3 | +0.30 | +10.00 | [+7.95, +12.05] | 2 |
| weather-morning | 13 | 13 | +0.66 | +5.08 | [-30.22, +40.37] | 2 |
| **fade** | **10** | **10** | **+0.42** | **+4.20** | **[+2.89, +5.51]** | **3** |
| calibration (pre-slopes cohort) | 16 | 16 | +0.13 | +0.81 | [-9.26, +10.89] | 2 |
| book-imbalance | 51 | 51 | -3.15 | -6.18 | [-8.01, -4.34] | 4 |
| favorite | 11 | 11 | -0.68 | -6.18 | [-22.93, +10.56] | 3 |
| log-momentum | 16 | 16 | -0.99 | -6.19 | [-11.41, -0.97] | 4 |
| microprice | 47 | 47 | -2.93 | -6.23 | [-7.43, -5.03] | 4 |
| weather-forecast | 16 | 16 | -1.06 | -6.62 | [-15.81, +2.56] | 2 |
| momentum | 20 | 20 | -1.44 | -7.20 | [-11.48, -2.92] | 4 |
| maker | 4 | 4 | -0.29 | -7.25 | [-11.10, -3.40] | 2 |
| fade-maker | 21 | 21 | -1.53 | -7.29 | [-30.06, +15.49] | 3 |
| breakout | 17 | 17 | -1.34 | -7.88 | [-11.54, -4.22] | 4 |
| ladder-value | 5 | 5 | -0.58 | -11.60 | [-51.49, +28.29] | 2 |
| mean-reversion | 7 | 7 | -1.28 | -18.29 | [-34.37, -2.20] | 2 |
| benchmark (control) | 4 | 4 | -0.77 | -19.25 | one day | 1 |
| weather-maker | 13 | 13 | -4.08 | -31.38 | [-43.81, -18.96] | 3 |

**The handicap is at entry, not exit.** Splitting by how each position closed:

| closed by | n | gross (exit − fill) | fees | net |
|---|---|---|---|---|
| crossing the spread to exit | 168 | -5.15c | 2.00c | -7.15c |
| settlement, no exit spread | 106 | -5.18c | 1.05c | -6.23c |

The gross figure is the same either way, so the ~5c is paid when the position is opened (ask + 1c modelled
slippage), not when it is closed. Every arm starts five cents under water and the signal has to earn that back
before it earns anything. Six arms are confidently below zero even so: book-imbalance, microprice, momentum,
breakout, log-momentum and weather-maker all have their whole band under zero. **The quote-following family —
momentum, log-momentum, breakout, microprice, book-imbalance — is the largest sample in the lab and the clearest
negative: 151 trades, every one of them at roughly the entry cost.**

**One candidate.** fade (+4.20c, band clear of zero over 3 days, 7 events) is the only arm whose result survives
its own band. It is the same favourite-longshot rule the Kalshi arm runs, and the same rule the 127-million-row
Becker backtest supported. Ten trades is not a verdict.

**Nothing is live-eligible, and nothing is close.** The gate is 30 closed trades, 10 events, 3 days and a positive
day-cluster lower bound. Every arm fails at least one leg; fade fails only on volume and reaches 30 trades and 10
events around **Sep 26**. book-imbalance and microprice have the volume and fail on the lower bound, which is the
gate working as intended.

**The control cannot anchor anything, and now we know why.** The benchmark has 4 closed trades on 1 day. It is in
`IBKR_HOLD_TO_SETTLEMENT`, and the twelve contracts it is holding expire **12 to 80 days out (median 24)**. It is
not slow because it rarely fires; it is slow because it bought long-dated paper and is waiting. The same applies to
fade, favorite, ladder-value and calibration, whose open positions run out to 47-58 days. The universe is
bimodal: of 281 contracts, 82 expire within two days and the median is 47 days. The external review (GLM 5.3,
F-07) asked for arms to be judged against the control rather than against zero; at n=4 with no band that is not
computable, and no amount of waiting fixes it while the control keeps choosing 47-day paper.

**Three arms have never fired; three more have fired and are still holding.** Corrected 2026-09-20 10:00Z after
reading the lab's own signal counter and open positions, which the first pass did not check:

| arm | signals seen | open | closed | what it means |
|---|---|---|---|---|
| dutch | 0 | 0 | 0 | never fired: the YES+NO-under-$1 arbitrage has not appeared |
| implication | 0 | 0 | 0 | never fired: same, for the two-strike basket |
| convergence | 0 | 0 | 0 | never fired, and cannot here: it wants the last 2-6 minutes before expiry, and the universe's median contract expires in 47 days |
| news | 1 | 1 | 0 | fired; capped by its own "daily eight-call forecast budget" |
| market-conditioned | 1 | 1 | 0 | fired; holding a contract 12 days out |
| political-favorite | 2 | 1 | 0 | fired; holding a contract 58 days out |

Only the first three are silent. The other three are working and simply hold long-dated contracts that have not
settled, which is the same reason the control has almost no closed trades. `spot-first` also deserves a note: 10
signals, 4 closed, and its status carries "Crypto source stale or invalid" — its Coinbase spot input requires a
last-trade timestamp under 30 seconds old and fails closed when it is not.

---

## 3. What I would change, in order

1. **Polymarket's exit rule is the binding constraint.** A 15-minute taker round trip costs 5.6c and the signal
   cannot pay it. Either hold to settlement (as the longshot and favorite controls already do) or enter passively.
   Changing it resets the cohort, which is cheap right now at one day of data.
2. **Give the Polymarket passive arms a market to rest in.** Twelve rotating markets is why join has never filled.
   Pin the tracked set for the life of a resting order, or track more markets.
3. **Rate-limit the Polymarket benchmark.** A control that outnumbers the arms 20:1 spends the lab's whole sample
   budget on friction measurement. One entry per arm-opportunity is enough to keep it comparable.
4. **Retire the IBKR quote-following family or re-seat it.** 151 trades say a taker entry on these books does not
   pay. If the hypothesis is worth keeping, it belongs on a passive entry, not a crossed one.
5. **Let fade run to its gate** (about Sep 26) and give the IBKR benchmark enough throughput to be a real control.
6. **Mark convergence unavailable on ForecastEx** until a short-dated product exists; say in the panel that dutch
   and implication are rare-by-nature rather than beaten, and that news, market-conditioned and political-favorite
   are holding rather than silent.

None of this was changed. Items 1-3 alter a pre-registered lab and item 4 retires arms, so they are the operator's
call; items 5 and 6 are bookkeeping I can do on a word.
