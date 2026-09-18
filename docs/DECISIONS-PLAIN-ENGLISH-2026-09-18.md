# ORACLE TRADER - OPEN DECISIONS IN PLAIN ENGLISH (2026-09-18)

Companion to `REPAIR-COMPLETE-2026-09-18.md` (repairs) and `AUDIT-BUGS-2026-09-18.md` (audit).
That pair lists *what is outstanding and why*. This one is *what I would actually do about it*,
in ordinary language, with the evidence behind each call.

The operator's standing steer: every choice should be weighed by one question - does it make the app
more likely to win trades and grow the balance? That is the lens used below.

-------------------------------------------------------------------------------
## PART 0 - WHAT CHANGED WHILE WRITING THIS

Two of the decisions below looked like judgement calls. They were not - they are now
measurements, so I measured them and fixed what the measurement condemned.

**Item 6.4.3 (Polymarket US fee rounding) - SETTLED, AND FIXED.**

Source of truth: 432 real `polymarket-us` fills in the fill-reconciler archive
(`%APPDATA%\oracle-trader\fill-reconciler-polymarket-us.json.fills.jsonl`, 2026-09-02..12),
read-only. Every one of those fills carried a venue-reported `fee`.

Of the 87 fills that were charged a non-zero fee, the venue's reported figure was matched by:

| hypothesis | matched |
|---|---|
| round to the nearest cent | **85 / 87 = 97.7%** |
| round down to the cent | 50 / 87 = 57.5% |
| round up to the cent | 38 / 87 = 43.7% |
| bill the exact fraction (what the app modelled) | 2 / 87 = 2.3% |

The 2 that did not match: one **maker rebate** (a *credit* on a different schedule - see below),
and one single 1-cent case in 432 fills that stays unexplained. That is a good enough fit to
act on.

The app's `polyPaperFee()` billed the exact fraction with no rounding. So the paper lab - the
rig that decides which Polymarket strategies look worth real money - was mispricing every
Poly order. Direction of the error: the venue bills the *rounded* number, and rounding to the
nearest cent is unbiased on average, so this was not a systematic bleed; it was a per-trade
noise of up to half a cent, and on the lab's unit (one share per position) it *mattered at the
low end* - a 1-share buy at 6c bills exactly **zero** after rounding (0.392c rounds to 0),
where the app charged 0.39c.

Fixed, in `src/main/strategies/polyPaper.ts`:
- `polyPaperFee()` stays as the exact per-share rate (unchanged, so its tests still pin the
  published schedule);
- new `polyPaperOrderFee(shares, price, at, maker, rate)` is the fee the venue actually bills -
  the per-share rate times the size, **rounded to the cent at the order level**;
- all 5 ledger call sites (unrealised mark, close, exit, entry, entry mark) now charge the
  order-level figure.

Order-level, not per-share, is the important detail - it is the same lesson as Kalshi, and the
reason the share count is a parameter rather than baked in.

**Item 6.4.2 (Polymarket US maker rebate) - MEASURED, AND MY EARLIER ADVICE WAS WRONG.**

I previously called this "the largest un-monetised item I found" and recommended modelling the
rebate as income for maker strategies, because the simulator scores them as paying zero.

The fills say otherwise. The rebate **formula** is real and confirmed exactly: one fill, buy
7 shares at 0.40, reported `fee = -0.02`, which is `round(-0.0125 x 7 x 0.40 x 0.60) =
round(-0.021) = -0.02`. Formula and the -0.0125 coefficient both check out, rounded to the cent.

But the **incidence** is 1 fill in 432. The other 345 zero-fee fills are charged exactly zero,
not credited. So crediting the rebate in the simulator would make the paper P&L look better
than the bank account - it would invent income the archive does not show.

**Recommendation: do NOT model the rebate as income yet.** Keep maker = 0 (which is also what
the code already documents: "No rebates credited"). Instead, *capture* rebates so we learn the
real rate. Revisit when we know whether it is 0.2% of maker fills or 40%.

Two things to note while we are here:
- **The Polymarket live arm has produced no fills since 2026-09-12** - six days before this
  writing - while the Kalshi arm traded through this morning. Either it is switched off, or it
  is finding nothing worth taking. Worth a look; a silently idle arm is a wasted arm.
- **Every Poly fill on disk predates the 2026-09-17 fee increase**, so the new 0.0695 rate is
  still unproven against real charges. It will be validated automatically once post-09-17
  fills land. (`kalshiFee.ts`'s Kalshi model *is* validated - 2,505 live Kalshi orders.)

Verification of the whole session: `npx tsc --noEmit` rc=0; **16 / 16 test suites pass,
0 failures**; `test:poly-paper` passes with the new pins.
Backups (byte-exact, pre-edit): `backups\_repair_20260918_polyfee\`.
Receipt scripts: `tmp\poly_fee_rounding_probe*.py`, `tmp\patch_poly_cent_rounding.py`,
`tmp\patch_poly_comment.py`.

-------------------------------------------------------------------------------
## PART 1 - DECISIONS, WITH MY RECOMMENDATION

Each one: what it is, what I would do, why in plain terms, and how we would know it worked.

### D-1. Put the project under version control (`git init`). DO THIS FIRST.

**What it is:** the repo has no git history (`git: not a git repository`). Three repair
sessions have now been done by scripted find-and-replace plus whole-directory backups.

**Recommendation: yes, today, before anything else.** One command, and a `.gitignore` for
`node_modules`, `backups\`, and build output.

**Why in plain terms:** backups are snapshots. If a change turns out wrong three edits later,
a snapshot lets me go back to "before this session" but not "before this one line". With git I
can see exactly what changed, by whom, when, and undo precisely that. The current method works
- I verify every edit against a byte-exact copy - but it is the hard way to do something that
has a one-command answer. This is the cheapest risk reduction available to us and it protects
everything else on this list.

**How we know it worked:** `git log` shows the current state committed, and the next session
can `git diff` instead of diffing against backup folders.

### D-2. Position size: $1 now, $5 later. Formalise the ladder.

**What it is:** `amountPerTrade` is $1 while testing; `DEFAULT_CONFIG` says 5.

**Recommendation: keep $1. And adopt an explicit rule for raising it:**

1. stay at **$1** until an arm shows positive net over at least 50 closed trades at $1;
2. step that arm to **$2**, hold until it is still positive over another 50;
3. only then **$5** - and raise it arm by arm, not account-wide.

**Why in plain terms:** you already gave the right reason - at $5 a dozen bad trades is a
quarter of the account. The addition I would make is that scaling should be *earned per
strategy*. An arm that has proven itself at $1 has earned a bigger bet; an unproven arm has
not, and account-wide scaling promotes the losers along with the winners.

One second-order point in favour of $2 sooner rather than later: at $1 a stake buys 1-2
contracts, and Kalshi rounds its fee at the **order** level. With 1-2 contracts that rounding
is a large fraction of the fee, so your $1 results carry unnecessarily wide error bars. $2-3
buys 4-6 contracts and gives a cleaner read of whether an edge is real. So the ladder above is
not just caution - the middle rung is genuinely more informative than the bottom one.

**How we know it worked:** the ladder's per-arm promotion metric is now correct at any size
(the N1 fix), so "positive net at $1" is a trustworthy gate for the first time. Watch for an
arm whose net stays positive across two sizes.

### D-3. The queue-preserving `/decrease` shrink (Tier 1). LEAVE IT OFF for now.

**What it is:** when the market moves a little against a resting quote, instead of leaving it
to be picked off, make it smaller without giving up your place in the queue. Currently built,
inert by default, logging what it *would* do.

**Recommendation: leave it off.** Not because the code is wrong - it is tested and correct -
but because at $1 it cannot do its job: it trims **1 contract**, and needs at least 2 to work
with. At your current size it either never fires or halves your order. It needs 10+ contracts
before a 1-contract trim is a trim rather than a cancellation.

So: leave it shadow-logging, and revisit when stakes are at $5 and quotes are 8+ contracts.

**Why in plain terms:** the feature is the right idea at the wrong scale. Turning it on now
would mean the "protection" sometimes cancels half a position for no benefit - which is worse
than doing nothing, because it also gives up the queue slot it was trying to protect.

**How we know it worked:** before enabling it, read the shadow log. The test is whether quotes
that *would have been* shrunk go on to be picked off more often than quotes that would not
have been. If both groups look the same, the trigger is firing at random and enabling it would
only shrink good quotes. That evidence is being collected now, at zero cost.

### D-4. Stop the quoter from losing its place in line. HIGHEST-VALUE BEHAVIOUR CHANGE.

**What it is:** your quoter rests orders on Kalshi. Kalshi fills in queue order - the person
who got there first gets filled first. Changing the *price* of a resting order sends you to the
back of the line; changing only the *size downwards* keeps your place.

The quoter's own numbers: **1,432 quotes, 793 amended, 741 cancelled, 33.1 contracts filled.**
**55% of quotes get amended.** Every price-changing amend is a queue forfeit.

**Recommendation:** make amends that only need a *size* change send no price at all, and widen
the price-moving threshold so small drifts stop triggering a reprice. Concretely:
- price unchanged, size changed -> size-only amend (keeps the slot);
- price moved >= 3c -> full amend (the price is genuinely wrong, forfeiting is correct).

**Why in plain terms:** there is a self-defeating pattern in the current logic. If the price
you already have is *correct*, you amend to it and drop to the back - so you only get filled
after everyone ahead of you is exhausted, which happens under heavy flow, and heavy flow into
a correctly-priced quote usually means the person hitting you knows something you do not. If
your price is *stale*, you were resting there first, so you are at the front - and the informed
taker hits you immediately. **The policy puts you at the front when you are wrong and at the
back when you are right.** That is the mechanism behind the quoter being switched off, and it
is not a speed problem: polling faster would forfeit the queue *more* often.

Supporting evidence from the quoter's own shadow log, measured offline: markout (the value of
the position 15 minutes later) is **-1.98c on 1,060 marked quotes, t = -7.67** - a solidly
negative number. And crucially, quotes the gates *allowed* (-2.14c) are statistically
indistinguishable from quotes the gates *blocked* (-1.98c). A gate set that worked would show
a big gap between those two. It shows none.

**That is why re-tuning `quoterMinEdgeCents` has never helped - it cannot.** I would stop
tuning that dial and spend the effort on queue position instead.

**Open item to check while doing this:** confirm from Kalshi's docs whether amending to
*increase* size at an unchanged price also forfeits the queue. The vendored docs say amending
preserves position "when it decreases size", which by implication means a size *increase* may
still forfeit. If so, a restore is a forfeit either way and the current comment overstates the
win. The fix still helps (a restore happens when the price is right again, so being at the back
is far less costly than being at the front while wrong) - but the doc comment should say so.

**How we know it worked:** queue forfeits per filled contract should fall, and markout on the
allowed cohort should move towards zero. Both are already logged; no new instrumentation
needed.

### D-5. Don't credit the Polymarket maker rebate yet. (Revision of earlier advice.)

Covered in Part 0. Recommendation: **capture, do not credit.** Add the rebate to the fill
record so we can count how often it is actually paid, keep charging maker = 0 in the
simulator until we have an incidence rate, then decide with data.

**Why in plain terms:** the formula is real - I confirmed one exact match - but 1 occurrence in
432 fills is not a basis for booking income. If the true rate is high, this is free money
waiting and we will find it in a week of logging. If it is near zero, we have avoided lying to
ourselves about how profitable the maker arms are.

### D-6. Maintenance should retry *after* the quota resets, not immediately. YES.

**What it is:** the nightly self-repair job dies when the LLM quota is exhausted (it happened
this week: `sentinel/incidents/2026-09-18T12-05-maintenance-failed.md`, still OPEN). The
sentinel's fix has already been corrected - it no longer loops - but it still does not come
back after the reset.

**Recommendation: yes, add a single retry scheduled for the reset time** (the error message
names it, e.g. "resets 11am"). Not an immediate retry - a *scheduled* one.

**Why in plain terms:** a retry that fires now cannot possibly succeed, because the thing that
failed is still exhausted. Waiting until the quota returns costs nothing and turns a lost
night's maintenance into a late night's maintenance. This is free reliability: no new
dependencies, no new failure modes, and it stops the safety net from being silently offline
for the rest of the quota week.

**How we know it worked:** the incident closes on the next reset instead of staying OPEN
until you notice it.

### D-7. Multi-outcome (many-answer) markets: leave settlement manual. YES, LEAVE IT.

**What it is:** markets with many possible answers (e.g. "who wins X" with a dozen candidates)
can be bought in the app, and now can be sold and settled correctly (that was the A1/A2 fix).
What is *not* automated is deciding a winner automatically when the market resolves, because
the market feed does not carry a field saying which answer won in a form the app can read.

**Recommendation: leave it manual.** No strategy trades these markets, so automating it buys
nothing today. Revisit only if you start trading them.

**Why in plain terms:** the alternative is guessing which answer won from fields that were not
meant to answer that question. Guessing in a settlement path is how you credit the wrong
payout. The app is now *correctly* able to settle these when told; that is the part that
mattered.

### D-8. Remove Manifold. YES, but as its own tidy session.

**What it is:** a play-money venue the app can still route through, with its own adapter,
paper state, and special-case branches.

**Recommendation: remove it - adapter, venue id, paper state, and the Manifold-specific
branches in a live strategy path - in one dedicated session with the test suite green before
and after.** Back up first; the only irreversible step is deleting its state file.

**Why in plain terms:** it is not a profit decision, it is a risk decision. Dead code sitting
*inside* a live strategy path is exactly where a silent bug hides - an `if` for a venue you no
longer use is an `if` nobody tests. Removing it shrinks the surface area of the code that
spends money. Low urgency, but worth doing properly rather than as a side edit.

**How we know it worked:** tests green, no Manifold strings left in the live paths, and the
remaining venues unaffected.

### D-9. The idle Polymarket arm. LOOK AT IT.

**What it is:** no Polymarket fills since 2026-09-12 - six days - while Kalshi traded this
morning. This is an observation, not a code defect.

**Recommendation: check whether the arm is enabled and whether it is finding markets.** Two
benign explanations (paused while the fee change landed; genuinely no qualifying markets) and
one bad one (silently wedged). The cost of looking is minutes; the cost of a quietly dead arm
is the whole venue.

-------------------------------------------------------------------------------
## PART 2 - ORDER I WOULD DO THESE IN

1. **`git init` + commit** (D-1). Do this first so everything after is revertible.
2. **Check the idle Poly arm** (D-9). Cheap, and it might be a live problem.
3. **Landed and verified already:** the Poly fee-rounding fix (Part 0). Nothing to do.
4. **Quoter queue discipline** (D-4). The one change on this list that plausibly adds money
   rather than protecting it. Implement behind the existing shadow instrumentation, prove the
   markout moves, then let it run.
5. **Rebate capture, credit nothing** (D-5). A week of logging buys a real answer.
6. **Scheduled maintenance retry** (D-6). Small, free, closes an OPEN incident.
7. **Manifold removal** (D-8). Hygiene, own session.
8. **`/decrease` go-live** (D-3). Gated on stakes reaching $5 and on shadow evidence.
9. **MC auto-settlement** (D-7). Only if you start trading those markets.

Steps 1, 2, 4, 5, 6 are all safe to do in any order after the git commit. Only step 4 changes
anything that trades.

-------------------------------------------------------------------------------
## PART 3 - WHAT I STILL CANNOT ANSWER, AND WHY

Honest list, so nobody mistakes silence for certainty:

- **Is the Polymarket maker rebate actually paid often?** One occurrence in 432 fills. The
  formula is confirmed; the frequency is not. Needs capture, then time.
- **Does a same-price size *increase* forfeit Kalshi's queue?** The vendored docs only confirm
  the decrease case. It changes how much credit the D-4 fix deserves, not whether to do it.
- **One unexplained cent on one Poly fill in 432.** Not material, but not explained either.
  Consistent with a multi-fill aggregate being rounded once at the end.
- **Whether the new 0.0695 Polymarket rate matches reality.** It is a published schedule the
  code implements; no post-09-17 fill has charged it yet. Settles itself with time.

-------------------------------------------------------------------------------
## PART 4 - THE ONE-SENTENCE SUMMARY

Everything that was mis-measuring money has now been fixed and verified; the Polymarket paper
rig now bills what the venue actually bills. The remaining decisions are about *behaviour*, and
my ranking is: put the code under git, confirm the idle Poly arm, then attack the quoter's
queue discipline - because that is the only remaining change with a mechanism, a measurement,
and a plausible route to profit.
