#!/usr/bin/env python
"""Live-data check of the Becker finding (calibration_slopes.py, 2026-09-14): Politics-group favourites at
75-94c bought at the ask with >= 6 h to close earn after the taker fee. Read-only: our own recorded books
(episodes `book` rows) plus Kalshi's PUBLIC market endpoint for close time and result. Places nothing.

Decision unit: one per (ticker, side) = the FIRST recorded book where that side's ask is in the band with
>= MIN_HOURS to close. Net = (won ? 100 - paid : -paid) - ceil(7 P (1-P)). Day-clustered (close date) 80% band.
Mention series are excluded (they lose in the archive at every favourite band except 95+).

  python scripts/backtests/politics_favourite_live.py [--days 9] [--min-hours 6]
"""
import argparse
import glob
import json
import math
import os
import re
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kalshi_categories import get_group  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('--days', type=int, default=9)
ap.add_argument('--min-hours', type=float, default=6)
ap.add_argument('--max-fetch', type=int, default=800)
args = ap.parse_args()
EP = os.path.join(os.environ.get('APPDATA', ''), 'oracle-trader', 'episodes')
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tmp', 'politics-live-cache.json')
K = 'https://api.elections.kalshi.com/trade-api/v2'
BANDS = [(75, 84), (85, 94), (95, 99)]
Z = 1.28


def fee_c(p):
    return math.ceil(7 * p * (1 - p) - 1e-9)


def prefix_of(ticker):
    return ticker.split('-')[0]


# kalshi_categories matches substrings first-hit (DIMAYOR -> "MAYOR", SERIEC -> "EC"...), so football series land in
# Politics; the same exclusions as the archive replay (scratch politics_rule.py) keep the two reads comparable.
SPORTY = re.compile(r'(GAME|SPREAD|TOTAL|MATCH|CUP|HR|GOAL|WIN[A-Z]*$|SERIE|DIMAYOR|SLGREECE|ECULP)')


def is_politics(ticker):
    p = prefix_of(ticker)
    if 'MENTION' in p or SPORTY.search(p):
        return False
    return get_group(p[2:] if p.startswith('KX') else p) == 'Politics'


def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'oracle-trader-research/1.0'})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:  # noqa
            if i == tries - 1:
                print('GET failed', url, str(e)[:80], file=sys.stderr)
                return None
            time.sleep(1.2 * (i + 1))


files = sorted(glob.glob(os.path.join(EP, 'kalshi-*.jsonl')))[-args.days:]
print(f'episode files {len(files)}: {os.path.basename(files[0])} .. {os.path.basename(files[-1])}')
books = defaultdict(list)  # ticker -> [(ts, yes_ask, no_ask)]
rows = 0
for f in files:
    with open(f, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            if '"book"' not in line[:60]:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            t = r.get('marketId') or ''
            if not t.startswith('KX') or not is_politics(t):
                continue
            rows += 1
            bids = [b for b in (r.get('bids') or []) if isinstance(b, list) and len(b) == 2 and b[1] > 0]
            asks = [a for a in (r.get('asks') or []) if isinstance(a, list) and len(a) == 2 and a[1] > 0]
            yes_ask = min(a[0] for a in asks) if asks else None
            yes_bid = max(b[0] for b in bids) if bids else None
            no_ask = round(1 - yes_bid, 4) if yes_bid is not None else None
            books[t].append((r['ts'], yes_ask, no_ask))
print(f'politics book rows {rows:,} on {len(books)} tickers, series: '
      + ', '.join(f'{p}:{n}' for p, n in sorted(((p, sum(1 for t in books if prefix_of(t) == p)) for p in {prefix_of(t) for t in books}), key=lambda x: -x[1])[:15]))

cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
fetched = 0
for t in sorted(books):
    c = cache.get(t)
    if c and c.get('result') in ('yes', 'no'):
        continue
    if c and time.time() - c.get('at', 0) < 6 * 3600:
        continue
    if fetched >= args.max_fetch:
        break
    d = get(f'{K}/markets/{t}')
    fetched += 1
    time.sleep(0.25)
    m = (d or {}).get('market') or d or {}
    cache[t] = {'at': time.time(), 'close_time': m.get('close_time'), 'result': m.get('result'), 'status': m.get('status'), 'title': (m.get('title') or '')[:80]}
os.makedirs(os.path.dirname(CACHE), exist_ok=True)
json.dump(cache, open(CACHE, 'w'), indent=0)
print(f'fetched {fetched} markets this run; cached {len(cache)}')

decisions = []  # (ticker, side, paid_c, won, net, close_day, hours_to_close, ts)
unsettled = 0
for t, rs in books.items():
    c = cache.get(t) or {}
    ct = c.get('close_time')
    if not ct:
        continue
    close_ms = datetime.fromisoformat(ct.replace('Z', '+00:00')).timestamp() * 1000
    res = c.get('result')
    if res not in ('yes', 'no'):
        unsettled += 1
        continue
    rs.sort()
    for side, idx in (('YES', 1), ('NO', 2)):
        for ts, ya, na in rs:
            price = (ya, na)[idx - 1]
            if price is None:
                continue
            hours = (close_ms - ts) / 3.6e6
            if hours < args.min_hours:
                continue
            pc = round(price * 100)
            if 75 <= pc <= 99:
                won = (res == 'yes') == (side == 'YES')
                net = (100 - pc if won else -pc) - fee_c(pc / 100)
                decisions.append((t, side, pc, won, net, ct[:10], hours, ts))
                break


def band_stats(ds):
    n = len(ds)
    if not n:
        return None
    m = sum(d[4] for d in ds) / n
    g = defaultdict(float)
    for d in ds:
        g[d[5]] += d[4] - m
    se = math.sqrt(sum(v * v for v in g.values())) / n
    return n, len(g), sum(1 for d in ds if d[3]), m, m - Z * se, m + Z * se


print(f'\nsettled tickers with a qualifying book: {len({d[0] for d in decisions})}; unsettled (excluded) {unsettled}')
print('| band | side | n | day-clusters | wins | net c | 80% band |')
for lo, hi in BANDS:
    for side in ('YES', 'NO', 'both'):
        ds = [d for d in decisions if lo <= d[2] <= hi and (side == 'both' or d[1] == side)]
        s = band_stats(ds)
        if not s:
            continue
        n, D, w, m, l, h = s
        print(f'| {lo}-{hi} | {side} | {n} | {D} | {w} | {m:+.2f}{" **" if l > 0 else ""} | [{l:+.2f}, {h:+.2f}] |')
print('\nby series (75-94c, both sides):')
by = defaultdict(list)
for d in decisions:
    if 75 <= d[2] <= 94:
        by[prefix_of(d[0])].append(d)
for p, ds in sorted(by.items(), key=lambda x: -len(x[1]))[:15]:
    s = band_stats(ds)
    print(f'  {p:22s} n={s[0]:3d} D={s[1]:2d} wins={s[2]:3d} net {s[3]:+.2f}c [{s[4]:+.2f}, {s[5]:+.2f}]')
losers = [d for d in decisions if 75 <= d[2] <= 94 and not d[3]]
print('\nlosing favourites 75-94c:')
for d in sorted(losers, key=lambda d: d[5])[:25]:
    print(f'  {d[0]:40s} {d[1]:3s} paid {d[2]:2d}c  {(cache.get(d[0]) or {}).get("title", "")}')
