"""Implication arbitrage on Kalshi's own strike ladders, from the recorded books. Offline, read-only, no money.

For a threshold ladder (tickers `<SERIES>-<EVENT>-T<strike>`), "above k2" implies "above k1" when k1 < k2, so
P(above k2) <= P(above k1) must hold. A violation at EXECUTABLE prices is a lock:

    buy YES(k1) at its ask, buy NO(k2) at 1 - bid(k2)
    payoff: below k1 -> 0 + 1; between -> 1 + 1; above k2 -> 1 + 0   (always >= 1)
    cost:   ask(k1) + 1 - bid(k2)   <  1   iff   bid(k2) > ask(k1)
    margin per contract = bid(k2) - ask(k1) - taker fees on both legs

"Below" ladders (prices rising with strike) are the mirror; the direction is inferred per event from the
sign of price against strike, and pairs are only compared within one snapshot of one event.

Prior (backlog 70): the Dutch-book engine found same-event sum-over-one gaps not executable at size. This
asks the other question the tradoxvps guide raised: do LOGICAL-dependency violations exist at executable
prices, how large, how deep, and do they outlive one scan?

    python scripts/ladder_implication_scan.py [episodes dir] [--days N]
"""
import glob
import json
import math
import os
import re
import sys
from collections import defaultdict

EP = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else os.path.join(os.environ.get('APPDATA', ''), 'oracle-trader', 'episodes')
DAYS = int(sys.argv[sys.argv.index('--days') + 1]) if '--days' in sys.argv else 99
TICK = re.compile(r'^(KX[A-Z0-9]+)-([0-9A-Z]+)-T([0-9.]+)$')
# One snapshot = one scan; book rows of a scan share a ts to within a few seconds.
SNAP_MS = 20_000


def taker_fee(p):
    """Kalshi taker fee in whole cents per contract: ceil(0.07 * p * (1-p) * 100)."""
    return math.ceil(7 * p * (1 - p) - 1e-9)


def best(levels, hi):
    """(price, size) of the best level: highest bid or lowest ask."""
    lv = [l for l in levels if isinstance(l, list) and len(l) == 2 and l[1] > 0]
    if not lv:
        return None
    return max(lv, key=lambda l: l[0]) if hi else min(lv, key=lambda l: l[0])


files = sorted(glob.glob(os.path.join(EP, 'kalshi-*.jsonl')))[-DAYS:]
print(f'files: {len(files)}  ({os.path.basename(files[0])} .. {os.path.basename(files[-1])})' if files else 'no episode files')

# event -> snapshot bucket -> {strike: (bid, bidsz, ask, asksz)}
snaps = defaultdict(lambda: defaultdict(dict))
rows = 0
ladder_rows = 0
for f in files:
    with open(f, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            if '"book"' not in line[:60]:
                continue
            rows += 1
            try:
                r = json.loads(line)
            except Exception:
                continue
            m = TICK.match(r.get('marketId') or '')
            if not m:
                continue
            ladder_rows += 1
            series, event, strike = m.group(1), m.group(2), float(m.group(3))
            b = best(r.get('bids') or [], True)
            a = best(r.get('asks') or [], False)
            if b is None or a is None:
                continue
            key = (series, event)
            bucket = (r.get('ts') or 0) // SNAP_MS
            snaps[key][bucket][strike] = (b[0], b[1], a[0], a[1], r.get('ts'))

print(f'book rows {rows:,}; threshold-ladder rows {ladder_rows:,}; events {len(snaps):,}')

viol = []  # (margin_c, depth, series, event, k1, k2, ts, direction)
pairs = 0
snapshots = 0
persist = defaultdict(int)  # (series,event,k1,k2) -> consecutive snapshots in violation (max)
run = {}
for (series, event), buckets in snaps.items():
    for bucket in sorted(buckets):
        book = buckets[bucket]
        if len(book) < 2:
            continue
        snapshots += 1
        ks = sorted(book)
        # direction: do mids fall with strike ("above" ladder) or rise ("below" ladder)?
        mids = [((book[k][0] + book[k][2]) / 2) for k in ks]
        falling = sum(1 for i in range(len(ks) - 1) if mids[i + 1] < mids[i])
        rising = sum(1 for i in range(len(ks) - 1) if mids[i + 1] > mids[i])
        direction = 'above' if falling >= rising else 'below'
        for i in range(len(ks)):
            for j in range(i + 1, len(ks)):
                lo, hi = (ks[i], ks[j]) if direction == 'above' else (ks[j], ks[i])
                # lo is the weaker claim (should be priced higher); hi the stronger (should be priced lower).
                bid_lo, bsz_lo, ask_lo, asz_lo, ts = book[lo]
                bid_hi, bsz_hi, ask_hi, asz_hi, _ = book[hi]
                pairs += 1
                # lock: buy YES(lo) at ask_lo, buy NO(hi) at 1 - bid_hi
                gross = bid_hi - ask_lo
                if gross <= 0:
                    run.pop((series, event, lo, hi), None)
                    continue
                fee = taker_fee(ask_lo) + taker_fee(1 - bid_hi)
                margin_c = round(gross * 100 - fee, 1)
                depth = min(asz_lo, bsz_hi)
                k = (series, event, lo, hi)
                run[k] = run.get(k, 0) + 1
                persist[k] = max(persist[k], run[k])
                viol.append((margin_c, depth, series, event, lo, hi, ts, direction, gross * 100))

print(f'ladder snapshots {snapshots:,}; strike pairs checked {pairs:,}')
gross_pos = len(viol)
net_pos = [v for v in viol if v[0] > 0]
print(f'\npairs priced the wrong way round (gross > 0): {gross_pos:,}  ({gross_pos / max(pairs, 1) * 100:.2f}% of pairs)')
print(f'of those, positive AFTER taker fees on both legs: {len(net_pos):,}')
for thr in (1, 2, 5, 10):
    sub = [v for v in net_pos if v[0] >= thr]
    deep = [v for v in sub if v[1] >= 10]
    print(f'  margin >= {thr:2d}c: {len(sub):6,}   with >= 10 contracts on both legs: {len(deep):6,}   dollars at depth (sum margin x depth): ${sum(v[0] * v[1] for v in deep) / 100:,.2f}')
by_series = defaultdict(lambda: [0, 0.0, 0])
for v in net_pos:
    s = by_series[v[2]]
    s[0] += 1
    s[1] = max(s[1], v[0])
    s[2] += v[1] >= 10
print('\nby series (net-positive violations, max margin c, count with depth >= 10):')
for s, a in sorted(by_series.items(), key=lambda x: -x[1][0])[:12]:
    print(f'  {s:14s} {a[0]:6,}  max {a[1]:5.1f}c  deep {a[2]:5,}')
pers = sorted(persist.values(), reverse=True)
if pers:
    print(f'\npersistence (consecutive snapshots a pair stayed in violation): max {pers[0]}, ' + ', '.join(f'>= {n}: {sum(1 for p in pers if p >= n)}' for n in (2, 3, 5, 10)))
print('\ntop 10 by margin x depth:')
for v in sorted(net_pos, key=lambda v: -(v[0] * v[1]))[:10]:
    print(f'  {v[2]}-{v[3]}  T{v[4]:g} vs T{v[5]:g} ({v[7]})  gross {v[8]:.1f}c net {v[0]:.1f}c  depth {v[1]:g}  at {v[6]}')
