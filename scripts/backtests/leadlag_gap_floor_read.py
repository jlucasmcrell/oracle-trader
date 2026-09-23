"""Backlog 146b: the registered read of the lead-lag 6c gap floor.

Registration: docs/PREREGISTERED-leadlag-gap-floor.md (2026-09-18 19:50Z), amended 2026-09-19 (REVIEW-CHANGES
section 127, review M-01): only fills placed under the rule judge it, on the venue ledger, and the rule must also
be positive on orderbook-quoted rows alone.

    python scripts/backtests/leadlag_gap_floor_read.py <kalshi_dump.json> [--since 2026-09-18T19:50:00]

Venue ledger only: every Kalshi fill whose order-journal ref names the `leadlag` arm, marked to its market's
published result exactly as scripts/venue-pnl.py does, in markets settled since the registration. Day-clusters are
the settlement day. The stop rule is stated at 95%, so the band here is the two-sided 95% one, not the 80% band
scripts/backtests/bands.py draws for the ladder.
"""
import collections
import json
import math
import os
import sys

import importlib.util

# scripts/venue-pnl.py is the ledger formula of record; its name is not importable, so load it by path.
_spec = importlib.util.spec_from_file_location(
    'venue_pnl', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'venue-pnl.py'))
_vp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_vp)
f, kalshi_fill_pnl, journal_arms = _vp.f, _vp.kalshi_fill_pnl, _vp.journal_arms

REGISTERED = '2026-09-18T19:50:00'

# Student t, upper 0.975 quantile (two-sided 95%), by degrees of freedom.
_T975 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
         11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093,
         20: 2.086, 25: 2.060, 30: 2.042, 40: 2.021, 60: 2.000}


def t975(df):
    if df < 1:
        return float('inf')
    for k in sorted(_T975):
        if df <= k:
            return _T975[k]
    return 1.960


def main(argv):
    since = REGISTERED
    path = None
    i = 0
    while i < len(argv):
        if argv[i] == '--since':
            since = argv[i + 1]
            i += 2
        else:
            path = argv[i]
            i += 1
    journal = os.path.join(os.environ.get('APPDATA', ''), 'oracle-trader', 'order-journal.jsonl')
    arms = journal_arms(journal)
    d = json.load(open(path, encoding='utf-8'))

    fills = collections.defaultdict(list)
    for x in d.get('fills', []):
        fills[x.get('ticker') or x.get('market_ticker')].append(x)

    rows = []  # (day, contracts, net dollars)
    for s in d.get('settlements', []):
        settled = s.get('settled_time') or ''
        if settled < since or s.get('market_result') not in ('yes', 'no'):
            continue
        for x in fills.get(s['ticker'], []):
            if arms.get(('kalshi', x.get('order_id'))) != 'leadlag':
                continue
            cnt = f(x.get('count_fp') or x.get('count'))
            if cnt <= 0:
                continue
            rows.append((settled[:10], cnt, kalshi_fill_pnl(x, s['market_result'])))

    n = sum(r[1] for r in rows)
    net = sum(r[2] for r in rows)
    days = sorted({r[0] for r in rows})
    print('leadlag venue-ledger fills settled since %s: %d contracts over %d day-clusters, net $%.2f'
          % (since, int(n), len(days), net))
    if not rows:
        return 0
    mean_c = net / n * 100.0
    resid = collections.defaultdict(float)
    for day, cnt, pnl in rows:
        resid[day] += pnl * 100.0 - mean_c * cnt
    g = len(days)
    if g >= 2:
        se = math.sqrt(g / (g - 1.0)) * math.sqrt(sum(v * v for v in resid.values())) / n
        half = t975(g - 1) * se
        lo, hi = mean_c - half, mean_c + half
    else:
        lo = hi = None
    print('  net per contract %.2fc; day-clustered 95%% band %s'
          % (mean_c, 'n/a (one cluster)' if lo is None else '[%.2fc, %.2fc]' % (lo, hi)))
    by = collections.defaultdict(lambda: [0.0, 0.0])
    for day, cnt, pnl in rows:
        by[day][0] += cnt
        by[day][1] += pnl
    for day in days:
        print('    %s  n=%-4d $%.2f  (%.2fc/contract)' % (day, int(by[day][0]), by[day][1], by[day][1] / by[day][0] * 100.0))

    enough = n >= 60 and g >= 5
    print('  sample rule (>=60 contracts, >=5 day-clusters): %s' % ('MET' if enough else 'NOT MET'))
    if not enough:
        print('  VERDICT: not yet readable; deadline 2026-10-02 (starved -> report to the operator)')
    elif hi is not None and hi < 0:
        print('  VERDICT: FAIL - upper bound < 0; revert leadLagMinDislocationCents to 4')
    elif lo is not None and lo > 0:
        print('  VERDICT: PASS - lower bound > 0; the ladder checkpoint decides, no config change')
    else:
        print('  VERDICT: INCONCLUSIVE - band spans zero; the floor stays at 6, re-read later')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
