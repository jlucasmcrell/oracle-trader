# Pre-registered: fade the top traders' longshots, follow their favourites (paper)

Registered 2026-11-02, before any signal in the cohort. Operator: "Yes, try it." It trades nothing.

## What prompted it (looked at first, so it does not count)

`data/polymarket-consensus/grades.jsonl`, 2026-10-23..11-02, 7,159 graded signals (3+ top-profit wallets on one side
in 48 h). Graded at the recorded Polymarket price, all signals: buying their longshots under 40c lost 3.5-5.8c, their
favourites over 70c made 2-4.5c. Most of that was an artefact: the recorder polls hourly, so on a 15-minute crypto
window or a finished game its price already knew the outcome. With those removed (no Up-or-Down windows, resolution
3 h or more after the signal, first signal per market, 5-95c, Polymarket US taker fee): fade -1.11c [-5.28, 3.06]
n=315; follow +2.01c [0.06, 3.97] n=738 (90%, day-clustered, 11 days). Found by slicing; it counts for nothing below.

## The rule (fixed)

`scripts/consensus-split-gate.py`, reading only the recorder's grades. Cohort: signals from **2026-11-03T00:00Z**.
Each leg takes the first graded signal per market at 5-95c, excluding short crypto Up-or-Down windows and markets
resolving under 3 h after the signal:

- **fade**: price under 40c, one contract of the other side at 1 - price;
- **follow**: price over 70c, one contract of the same side at price.

Unit: cents per contract at settlement less the Polymarket US taker fee; 90% band per leg, clustered on the New York day.

## Decision (fixed, read by hand)

On or after **2026-11-16**, per leg, at 150 signals on 10 New York days:

- **PASS**: band wholly above zero. A live arm is built under its own registration (venue, matching and size are the
  operator's); the recorded price is not a fill price, so the arm starts at one contract.
- **FAIL**: band wholly below zero. The leg is closed.
- Otherwise continue to **2026-11-30**, then INCONCLUSIVE: closed, reported to the operator.

## Amendment 2026-11-10 — recorder outage, fee, and what the recorded price is

- **Outage.** The recorder's signal pass crashed on a Kalshi ticker that is not a date (`KXCCAVSICE-26NOV49`) on most
  runs from 11-05 and every run from 2026-11-09T02:58Z to 11-10T10:15Z. The cohort has that hole; fixed 11-10.
- **Fee.** Polymarket US moved small accounts to a 0.095 taker coefficient on 2026-11-06; the grader uses it.
- **Close time.** Grades from 11-10 carry `hours_to_close` (signal to the market's own close). Older rows only have
  signal-to-grading time, which is what the 3 h filter used; the grader falls back to it for those rows.
- **Known weakness, from the 11-10 review.** The recorded price is the wallets' last trade, a median 18 minutes old.
  On the whole period, signals priced under 30 minutes old grade +0.43c [-1.07, +1.92]; the apparent edge grows with
  staleness. A PASS here is therefore a reason to build a recorder that prices at a live ask on a venue the operator
  can trade, not a reason to trade.
