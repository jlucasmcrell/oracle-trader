# Git setup, PII scrub, and the ordered repair list  2026-09-18

Session goal, in the operator's stated order: (1) put the repo under git with **no
personal information in it**, then work down the agreed list: (2) why the Polymarket
arm stopped filling, (3) quoter queue discipline, (4) maker-rebate capture,
(5) nightly-maintenance retry. Items (6) Manifold removal and (7) `/decrease` sizing
are deferred  see "Still open" at the end, with the reason for each.

Everything below was verified. `npx tsc --noEmit` exits 0 and all 17 test suites pass
after every change in this document.

---

## 1. Git

### 1.1 What the repo now contains

`git init` was run in `G:\PROJECTS\oracle-trader` on branch `main`. **300 tracked
files, 4.9 MB working tree, 1.81 MB `.git`.** First commit is `d094e18`.

Tracked: `src/`, `scripts/`, `docs/`, and the root build/config files
(`package.json`, `tsconfig.json`, `electron.vite.config.ts`, `pnpm-lock.yaml`,
`README.md`, `Start Oracle Trader.bat`, `.gitignore`).

### 1.2 What is excluded, and why

The pre-existing `.gitignore` (7 lines: `node_modules/`, `out/`, `dist/`, `*.log`,
`.DS_Store`, `.env`, `.env.local`) was not enough. It was extended to cover four
categories of real exposure:

| Excluded | Size | What is actually in it |
|---|---|---|
| `data/` | 1.9 GB | Live state: balances, fills, settlement history, ladder history, and `polymarket-consensus/wallets.json` (497 tracked wallet addresses) |
| `tmp/` | 365 MB | Scratch  including Chromium **UI profiles** (`ibkr-ui-smoke-profile`, `poly-ui-profile`) which contain cookies and session tokens |
| `backups/` |  | Snapshot dirs containing **`config.json` and `kalshi-auto.json` with encrypted venue credentials**, including a full RSA private key (2,284 chars) and `kalshiApiKeyId` / `polymarketUsPrivateKey` |
| `.audit/` |  | `kalshi_snapshot.json` (real balance and open positions) **and `electron-data/Local State`, which holds the `os_crypt.encrypted_key`**  the key that decrypts Electron's saved cookies and passwords |

Also excluded: `logs/`, `scratchpad/`, `out/`, `node_modules/`, `__pycache__/`,
`*.pyc`, all `*.bak_*` (99 files of source copies), the root `_ui_verify*.png`
screenshots (a live-money UI can show balances), `config.json` (defensive, anywhere),
`*.pem`, `*.key`, `.npmrc`, `.netrc`, and `.env*`.

**The single most important exclusion is `.audit/electron-data/Local State`.** On its
own that file is a decryptor for Electron's credential store. It must never leave this
machine.

Good news, verified: the app's real credentials live in
`%APPDATA%\oracle-trader\config.json`  **outside the repo**  and no copy of a live
`config.json` existed anywhere in the tracked set (the only ones found were inside
`backups/`, now excluded).

### 1.3 PII scrub  including a history rewrite

**A correction to an earlier report of mine.** In the audit pass I concluded there were
"no personal paths" in `src/scripts/docs`. That was wrong. Scanning the *committed
index* instead of the filesystem surfaced real PII:

- the Windows username in home paths  in 4 files
- a **personal email address** in the maintenance prompt
- the **machine hostname** in 2 docs
- the operator's **first name**, ~280 times across 30 files (including a protocol
  label written into incident reports)

All of it is now gone. The scrub was applied before the commits that survive, so it is
not merely deleted-but-recoverable.

Scrubbing was done in two classes on purpose, so nothing breaks at runtime:

- **Descriptive docs**  readable placeholders: `C:\Users\<you>`, `<machine>`,
  "the operator". The phrase "the operator" was already used 48 times in the existing
  docs, so this improved consistency rather than inventing a convention.
- **Operational files**  working env-var forms. `_diag_balance.js`,
  `_diag_settlements.js`, `_diag_settlements.cjs` and `scripts/backup.py` now resolve
  paths via `process.env.APPDATA` / `os.environ["APPDATA"]`, and the agent-read
  `docs/MAINTENANCE-PROMPT.md` uses `%USERPROFILE%` / `%APPDATA%` / `%TEMP%`. These
  still work; a literal placeholder would have broken them.

The protocol label `NEEDS-JOE` was renamed to `NEEDS-OPERATOR`. **This is safe and was
checked before doing it**: nothing parses it  it appears only as prose in
`scripts/sentinel.mjs`, `docs/REPAIR-PROMPT.md` and docs. No code greps for it.

**Left alone deliberately:** private LAN addresses (`192.168.50.1`, in 7 files).
These are RFC1918, not routable from outside, and `.50.1` is a common router default 
they cannot identify anyone. One is used by `scripts/lib/dns-fallback.mjs`, where
changing it would break the documented meaning of the code.

### 1.4 The history rewrite

The PII had already been committed, so scrubbing the working tree was not sufficient 
it would have remained readable via `git log -p`. Because the repo was minutes old,
had **no remote and no clones**, the cleanest fix was to rebuild history rather than
carry a scrub commit on top.

Method: `git checkout --orphan` from the root commit, apply the scrub, re-commit as the
new root, then `git cherry-pick` the three change-commits on top  so the structure and
all commit messages survive. Then the old branch was deleted and
`git reflog expire --expire=now --all && git gc --prune=now` purged the unreachable
objects, so the old content is not recoverable from `.git/objects`.

Final history (4 commits, oldest first):

```
d094e18 Initial commit: Oracle Trader prediction-market auto-trader
e725342 quoter: drop the standalone size restore (it forfeits queue position)
d81c9c4 reconciler: record maker-rebate credits instead of modelling them as income
e73ced0 maintenance: per-day idempotence guard, 11:30 catch-up, real exit code
```

**A backup of the pre-scrub `.git` was taken first**, outside the repo, at
`G:\PROJECTS\oracle-trader-backups\git-prePII-<timestamp>\`. Delete it once you are
satisfied  it still contains the old PII history.

### 1.5 Verification of the scrub

- Content sweep across **every commit** for the username, the personal email local
  part, the hostname and the email provider's domain  **0 hits each**
- First name, word-boundary, across every commit  **0 hits**
- Working tree  clean; 300 files tracked
- `npx tsc --noEmit`  exit 0; 17/17 suites pass

### 1.6 Deliberate choices you should know about

- **Commit identity is repo-local and non-identifying.** The machine's global git
  identity carries a personal address, so it is deliberately *not* used; this repo uses
  a GitHub-style noreply handle instead. Two consequences: the real address is never
  recorded, and if you later push to a GitHub repo, commits may or may not link to your
  account depending on the handle's exact form. Change it with
  `git config user.email ...` before more commits if you want attribution  but note
  that changing it *after* commits requires a rewrite.
- **No remote is configured.** Nothing can be pushed by accident.
- **`docs/` records real account balances and P&L in prose.** That is normal for a
  private repo and I did not destroy it. It is the one remaining thing to be aware of:
  scrub `docs/` before this ever goes somewhere public.
- **Line endings are not rewritten** (`core.autocrlf=false`), so files round-trip
  byte-identically with what is on disk.

### 1.7 Two doc defects found while doing this

- `docs/MAINTENANCE-PROMPT.md` said **"repo G:\PROJECTS\oracle-trader (no git)"** 
  stale as of this session, and it is the maintenance agent's source of truth. It now
  reads "git-tracked since 2026-09-18", and carries a short, safe instruction to commit
  each day's work (with an explicit warning *not* to `git add -f` the ignored paths and
  *not* to push).
- The same file has pre-existing mojibake (`1<binary>24` where an en-dash range was
  meant). Cosmetic, not fixed.

---

## 2. Why the Polymarket arm stopped filling  it didn't break

**Answer: the arm is idle by configuration, deliberately, and the app was right.**

`mini-auto-polymarket-us.json` shows `enabled: true`, `autoPoll: true`,
`pollIntervalSeconds: 60`, `liveArmed: true`  and **every strategy switched off**:
`fadeEnabled: false`, `microMakerEnabled: false`, `bookEnabled: false`,
`weatherFairEnabled: false`. It polls, scans, and can never trade.

It was not a bug. `ladder.json` records the reason for each, with `operatorHold: true`
on all four so the ladder will not re-enable them on its own:

| Strategy | Parked | Recorded reason |
|---|---|---|
| `polyus-fade` | 2026-09-12 | "evidence-condemned, see REVIEW-CHANGES A5.67"  operator-approved |
| `polyus-micro-maker` | 2026-09-12 | 2026-09-07 checkpoint at 20 trades: net **$2.05**, mean $0.10/trade, 80% band 0.14..0.06  "losing money with 80% confidence"; re-tested 09-10 |
| `polyus-book-imbalance` | held to 2026-12-01 | **1W/39L lifetime  0 of 40 round trips positive net of fees.** Paid ~$6.70 in commission, "essentially every fee the account paid on the venue". Signal carries no directional information (residual drift median 0.000) |
| `polyus-weather-fair` | retired 2026-09-09 | Maker seat in the high/low temperature series is **1.70c/contract over 801,258 contracts** across 78 station-days; plus a measured 10.3F remaining-hours artifact |

The timestamps line up: `polyus-fade`'s park event at `1789199212502` is within ~35
minutes of the reconciler's last recorded Poly fill (`1789197111475`).

**Recommendation: do not re-enable any of them.** These are evidence-backed
retirements with figures attached, and `operatorHold` is an explicit decision the
ladder respects. Re-enabling would be re-funding strategies that were provably losing
after fees. The one that looks least bad (`polyus-fade`, +$0.18 over 67 trades) has a
structural blocker documented in `docs/BACKLOG.md:395`  **it cannot fire**: the scan
sees a fixed 1,000-row slice of a 60,000+ market catalogue with `volume` null on every
row, so the slice is arbitrary.

Two smaller notes:

- The arm is burning a 60-second poll cycle with no strategy enabled  wasted API calls
  against a rate-limited venue. Consider `autoPoll: false` while it is parked, so
  re-enabling a strategy is an explicit act.
- Kalshi's `fade` is the standout performer in the whole app: **+$8.11 over 242 trades
  at a ~94% win rate** (229W/13L). That is where the evidence points, not Polymarket.

---

## 3. Quoter queue discipline

### 3.1 The rule that was wrong

Last session's fix kept a "restore to full size" path for a shrunk quote, justified by
a comment claiming that *a price change* forfeits queue position but *a size increase
does not*. **Kalshi's own amend documentation contradicts that directly:**

> "Amending a resting order preserves queue position only when the amendment decreases
> size. All other amendments  like **increasing size** or changing price  forfeit
> queue position and place the order at the back of the queue."

So restoring size can **never** preserve the slot. A standalone restore is strictly
self-defeating: it trades a front-of-queue slot for a back-of-queue slot, in exchange
for size that  now sitting at the back  is unlikely to fill. Worse, the old condition
fired on `priceDelta < 0.01`, so it triggered on a *favourable* reversion too.

### 3.2 The fix

In `src/main/strategies/quoter.ts`, the standalone restore branch is gone
(`restoreSize`, `amendPrice`). Repricing now happens only when the price is genuinely
wrong  the book crossed us, or fair value moved 3c  and **full size is restored only
as part of such a reprice**, where the slot is forfeited regardless. A quote shrunk by
tier-1 stays shrunk, and keeps its slot, until it fills, is cancelled, or truly
reprices. The misleading comment was replaced with the actual rule and its source.

Bounded by design: because `existing.yesPrice` is not changed by a shrink, drift keeps
accumulating, so a quote that keeps moving against us is repriced at the 3c threshold
rather than shrinking indefinitely.

`src/main/venues/kalshi.ts`'s own comment ("only size decreases keep it") was already
correct and is unchanged.

### 3.3 Also verified while here

`POST /portfolio/events/orders/{order_id}/decrease` accepts **exactly one of
`reduce_by` or `reduce_to`**  confirmed against the live docs, so the `reduce_to`
implementation shipped last session is valid, as is its idempotency rationale.

### 3.4 Scope note

The quoter is `disabled` with `operatorHold: true` and fails its own shadow promotion
gate (needs CI lower bound > 0; currently 8.54c on 35 fills / 21 events). This change
is therefore **inert in live trading**  it improves the policy the shadow evidence
will measure. I did **not** widen the 3c reprice threshold: beyond 3c the quote is
genuinely mispriced and repricing is correct, so widening it would hold a stale quote at
the front of the queue rather than help. That would need evidence, not a guess.

---

## 4. Maker-rebate capture

Largely already correct. `polyPaperFee` returns `maker ? 0`, which matches the
empirically-observed venue behaviour  the header comment records "No rebates credited",
and across 432 real fills the only credit seen was a single isolated maker rebate. The
paper model is right not to invent that income.

What was missing was the **instrument**: if the venue ever starts paying rebates, we
should find out from data rather than notice months later. A rebate arrives as a
**negative fee** on the fill, and `fillReconciler.ts` copies `f.fee` verbatim into
history rows, so the detector is a negative-fee scan there. It records
(`rebateCredits`, `rebateCents` in reconciler state) and logs once on first detection.
**It records; it never credits.**

Note this will produce no data while every Polymarket strategy is parked  it is
dormant until a Poly maker strategy runs again.

---

## 5. Nightly maintenance

### 5.1 The problem

`data/sentinel/incidents/2026-09-18T12-05-maintenance-failed.md` is OPEN. Maintenance
runs at **07:00** via the `OracleTrader-Maintenance` scheduled task. It fails on an LLM
**weekly quota** ("resets 11am"). So on an exhausted week the 07:00 run **can only ever
fail**  the reset is four hours after it starts. The sentinel's quota handling was
already fixed in an earlier session (it stands down rather than looping); the schedule
was the remaining gap.

A second, quieter defect: **the task always reported success.** `maintenance.ps1` never
propagated its exit code, so `LastTaskResult` was 0 even for the failing runs  a failed
maintenance was indistinguishable from a clean one.

### 5.2 The fix

- **Per-day idempotence guard** at the top of `maintenance.ps1`: if today's log already
  contains `] exit 0`, exit 0 immediately. This makes the script safe to run more than
  once a day and is what allows a catch-up run to do the day's work *late rather than
  not at all*.
- **An 11:30 catch-up trigger** added to `OracleTrader-Maintenance` (daily triggers at
  07:00 and 11:30). Verified: both triggers present, the action is unchanged, next run
  11:30 today.
- **Real exit code propagation** (`exit $code`), so Task Scheduler reports failures
  accurately from now on.

Verified: PowerShell parses with 0 errors; the guard correctly does *not* skip today
(today's log has only `exit 1`); the task's action and principal were untouched.

**Known consequence, not a bug:** the desktop task that delivers the maintenance report
runs at 08:30, so on a catch-up day the report is written after delivery has already
happened. The work gets done and the report lands in `docs/reports/`; it just is not
pushed that day. Fixing that means also adding a late trigger to the delivery task,
which I did not touch.

Task definition backed up to `backups\_repair_20260918_maint\OracleTrader-Maintenance.xml`.

---

## 6. Still open

- **(6) Manifold removal  deferred to its own session, deliberately.** You said you do
  not use it and that it should probably come out, and agreed to it being its own
  session. It is a cross-cutting removal  Manifold appears as a first-class venue
  across the app  so it is a real refactor with real breakage risk, and it is hygiene
  rather than profit. It should not be tacked onto a session that also changed live
  trading code. It is the next piece of work.
- **(7) `/decrease` sizing  deferred until stakes rise.** The code is correct and
  shipped, but it shrinks by exactly 1 contract with a 60-second cooldown and needs
  `remaining > 1` to act. At the current `amountPerTrade = 1` it will rarely fire and
  barely reduce exposure, so it cannot yet deliver its purpose. It stays in shadow
  (log-only, no API calls). Revisit at $5 stakes.
- **Rebate data** accumulates only once a Polymarket maker strategy runs again.
- **`git init` follow-up:** consider whether `docs/` financial figures should be
  scrubbed before any remote is added.

---

## 7. Verification summary

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| Test suites | **17 passed, 0 failed** |
| PowerShell parse, `maintenance.ps1` | 0 errors |
| `git status` | clean, 300 files tracked |
| PII sweep, every commit | username / email / hostname / first name  **0 hits** |
| Quoter / reconciler / maintenance fixes present after history rewrite | yes |
| Structured edits | anchored replacement with occurrence assertions; each verified with a real diff against a byte-exact backup |
| Encodings | preserved per-file (LF/CRLF), no BOM introduced |

Backups for this session: `backups\_gitinit_20260918\`, `backups\_repair_20260918_quoter\`,
`backups\_repair_20260918_rebate\`, `backups\_repair_20260918_maint\`, plus the
pre-scrub `.git` at `G:\PROJECTS\oracle-trader-backups\git-prePII-*\`.

The live app (electron pid unchanged) was never restarted or disturbed by any of this.
