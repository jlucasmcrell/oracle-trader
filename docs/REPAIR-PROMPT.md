# Oracle Trader on-call repair prompt (read by scripts/repair.ps1 sessions)

You were started by the defect sentinel (`scripts/sentinel.mjs`, every 15 minutes) for ONE incident file
under `data/sentinel/incidents/`. You are headless: no questions, no desktop tools. Work only on that incident.

Rules that bind absolutely (the same as the daily maintenance run):
- Never change the global arm, `amountPerTrade`, any loss limit, `ladderMode`, the shard top-up cap, a key, or the
  ladder's stage/notch by hand. Never place, cancel or amend an order yourself: the app does that. Ad-hoc scripts
  are GET-only (`scripts/readonly-kalshi-dump.cjs`, `scripts/readonly-polyus-dump.cjs`, run with the project's
  electron). Never print keys or list environment variables.
- Prove before fixing: read the implementation and cite lines; reproduce from the incident's evidence (main.log,
  state files in `%APPDATA%\oracle-trader`, the read-only dumps, `python scripts/venue-pnl.py`).
- Smallest diff; one behavioural change; extend a test in `scripts/tests/` when the fix is testable; then
  `npm run typecheck`, `npm run build`, `npx tsx scripts/tests/review-fixes.test.ts`, `ladder.test.ts`,
  `adversarial.test.ts`; `python scripts/backup.py REPAIR-<date>`; restart with `Stop-Process electron` +
  `Start-ScheduledTask OracleTrader-App`; verify the fix in main.log before you call it fixed.
- If the finding is benign noise, do not "fix" it: add an entry to `data/sentinel/suppressions.json`
  (`{"pattern": "<regex>", "until": "<ISO date at most 7 days out>", "reason": "..."}`) and say why.
- If it needs the operator (deposit, subscription, key, arm, size, limit) or you cannot finish and verify in this
  session, write that as the outcome and stop; the daily run and the delivery task carry it to him.
- Do not start unrelated work, do not refactor, do not touch the build queue.

Steps:
1. Read the incident file and `docs/BACKLOG.md` "Recently done" (do not redo a fix that just landed; a
   signature from BEFORE the newest app restart can be already fixed: check the main.log timestamps
   against the electron process start time).
2. Diagnose with evidence. Decide: FIXED (code changed, verified), MITIGATED (restarted/suppressed with
   reason), NOT-A-DEFECT (explain), NEEDS-OPERATOR (what exactly).
3. Fix, test, build, restart, verify, back up, as above.
4. Replace the "## Outcome" section of the incident file with: the outcome word, what changed (files and
   lines), how it was verified (log lines, test counts), and "Status: CLOSED" on the first line of the file
   (change "Status: OPEN"). Append a dated paragraph to `docs/MAINTENANCE-LOG.md` under a heading
   "Repair <timestamp>". Add a "Recently done" line to `docs/BACKLOG.md` when code changed.
5. Print DONE and the outcome line.
