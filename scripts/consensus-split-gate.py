"""Read for docs/PREREGISTERED-consensus-split.md. Reads data/polymarket-consensus/grades.jsonl only: no network, no orders.

    python scripts/consensus-split-gate.py [--since 2026-11-03T00:00:00Z] [--verdict]

Two legs, each the FIRST graded signal per market (conditionId) with a Polymarket price from 5c to 95c, not a
short crypto Up-or-Down window, resolving 3 h or more after the signal:
  fade:   the top traders bought a longshot (price under 40c) -> one contract of the other side at 1 - price;
  follow: they bought a favourite (price over 70c)            -> one contract of the same side at price.
Unit: cents per contract at settlement less the Polymarket US taker fee (0.0695 p(1-p), to the cent).
Band: day-clustered (New York calendar day), 90% per leg (two legs, ~80% family).
"""
import datetime as dt
import json
import math
import os
import sys
from collections import defaultdict
from zoneinfo import ZoneInfo

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRADES = os.path.join(REPO, 'data', 'polymarket-consensus', 'grades.jsonl')
NY = ZoneInfo('America/New_York')
READ_ON = dt.datetime(2026, 11, 16, tzinfo=dt.timezone.utc)
LAST = dt.datetime(2026, 11, 30, tzinfo=dt.timezone.utc)
MIN_N, MIN_DAYS, Z90 = 150, 10, 1.6449


def arg(k, d):
    return sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d


SINCE = dt.datetime.fromisoformat(arg('--since', '2026-11-03T00:00:00+00:00').replace('Z', '+00:00'))


def fee(p):
    return round(0.0695 * p * (1 - p) * 100) / 100


def band(units):
    n = len(units)
    if not n:
        return dict(n=0, days=0, mean=None, lo=None, hi=None)
    m = sum(c for _, c in units) / n
    by = defaultdict(float)
    for d, c in units:
        by[d] += c - m
    g = len(by)
    se = math.sqrt(g / (g - 1) * sum(v * v for v in by.values())) / n if g >= 2 else math.inf
    return dict(n=n, days=g, mean=round(m, 2), lo=round(m - Z90 * se, 2), hi=round(m + Z90 * se, 2))


legs = {'fade': [], 'follow': []}
seen = set()
for line in open(GRADES, encoding='utf-8'):
    try:
        g = json.loads(line)
    except ValueError:
        continue
    p, y, cid = g.get('poly_price'), g.get('y'), g.get('conditionId')
    if p is None or y is None or not cid or cid in seen:
        continue
    ts = dt.datetime.fromisoformat(g['ts'])
    if ts < SINCE:
        continue
    seen.add(cid)
    if not 0.05 <= p <= 0.95:
        continue
    # The recorder polls hourly, so its price can postdate the outcome: a 15-minute crypto window has often closed by
    # the time the signal is written, and a game may be over. Short crypto windows are lead-lag's market and are out;
    # everything else must resolve at least 3 h after the signal.
    if 'Up or Down' in (g.get('title') or '') or (g.get('hours_to_resolution') or 0) < 3:
        continue
    day = ts.astimezone(NY).date().isoformat()
    if p < 0.40:
        q = round(1 - p, 3)
        legs['fade'].append((day, 100 * ((1 - y) - q - fee(q))))
    elif p > 0.70:
        legs['follow'].append((day, 100 * (y - p - fee(p))))

now = dt.datetime.now(dt.timezone.utc)
out = {}
for name, units in legs.items():
    b = band(units)
    v = 'WAIT'
    if now >= READ_ON and b['n'] >= MIN_N and b['days'] >= MIN_DAYS:
        v = 'PASS' if b['lo'] > 0 else 'FAIL' if b['hi'] < 0 else ('INCONCLUSIVE' if now >= LAST else 'CONTINUE')
    out[name] = v
    print(f"{name:7s} n={b['n']} over {b['days']} NY days: {b['mean']}c/contract, 90% [{b['lo']}, {b['hi']}] -> {v}")
print('read from 2026-11-16 at 150 signals on 10 days per leg; INCONCLUSIVE after 2026-11-30')
if '--verdict' in sys.argv:
    sys.exit(0 if 'PASS' in out.values() else 1)
