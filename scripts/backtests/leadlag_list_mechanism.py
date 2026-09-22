"""Does the good era's lead-lag mechanism still work? Grades it against what the arm does now, from the shadow quote log.

    python scripts/backtests/leadlag_list_mechanism.py [--since 2026-09-22T19:00Z] [--list-gap 4] [--live-gap 6]

Reads %APPDATA%/oracle-trader/leadlag-quotes-shadow.jsonl (one row per coin per scan: Polymarket mid, the live Kalshi
book, and the Kalshi LIST quote; written from 2026-09-22, REVIEW-CHANGES section 156).

OLD mechanism (until round 116, 2026-09-17): the gap is Polymarket vs the LIST quote (stale by 20-40 s). The IOC is
sent at the list price + 1c and fills only if the live book still offers that price - i.e. only when a Kalshi order
has not caught up with a move. That is how the arm made +19c/contract from 09-07 to 09-12 on real fills, while the
same gaps priced at Kalshi's going rate were worth about +2c.
NEW mechanism (now): the gap is Polymarket vs the live book, the IOC fills at the live ask.

Both are graded one contract, first trigger per ticker and side, at the price actually available in the live book,
with Kalshi's 1-contract taker fee, held to settlement. Results come from Kalshi's public settled-markets list
(a few GETs per coin, paced). Read-only.
"""
import argparse, json, math, os, statistics as st, sys, time, urllib.request, datetime as dt

ap = argparse.ArgumentParser()
ap.add_argument('--since', default='2026-09-22T00:00Z')
ap.add_argument('--list-gap', type=float, default=4.0, help='old mechanism trigger, cents (the good era ran 4)')
ap.add_argument('--live-gap', type=float, default=6.0, help='new mechanism trigger, cents (leadLagMinDislocationCents)')
ap.add_argument('--file', default=os.path.join(os.environ.get('APPDATA', ''), 'oracle-trader', 'leadlag-quotes-shadow.jsonl'))
ap.add_argument('--results', help='optional JSON {ticker: "yes"|"no"} instead of the public API (tests)')
a = ap.parse_args()
since = dt.datetime.fromisoformat(a.since.replace('Z', '+00:00'))


def fee(p):  # Kalshi taker fee for ONE contract: 0.07 P(1-P) ceiled to $0.0001 (src/main/util/kalshiFee.ts, matched
    # 96.6% of 1,626 real fee-bearing orders; the whole-cent ceil this used first overstated fees ~1.4x)
    return math.ceil(round(0.07 * p * (1 - p) * 10000, 6)) / 10000


rows = []
for line in open(a.file, encoding='utf-8', errors='replace'):
    try:
        r = json.loads(line)
    except Exception:
        continue
    if dt.datetime.fromisoformat(r['ts'].replace('Z', '+00:00')) >= since and None not in (r.get('lb'), r.get('la')):
        rows.append(r)
if not rows:
    sys.exit('no shadow rows since %s in %s' % (a.since, a.file))

if a.results:
    RES = json.load(open(a.results))
else:
    RES, coins = {}, sorted({r['c'] for r in rows})
    lo = int(since.timestamp())
    for coin in coins:
        cur = ''
        while True:
            u = 'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KX%s15M&status=settled&limit=1000&min_close_ts=%d%s' % (coin, lo, ('&cursor=' + cur) if cur else '')
            d = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'oracle-trader-readonly'}), timeout=25))
            RES.update({m['ticker']: m.get('result') for m in d.get('markets', [])})
            cur = d.get('cursor') or ''
            time.sleep(0.5)
            if not cur or not d.get('markets'):
                break

old, new, fired = {}, {}, {'old': 0, 'old_filled': 0, 'new': 0}
for r in sorted(rows, key=lambda x: x['ts']):
    res = RES.get(r['t'])
    if res not in ('yes', 'no'):
        continue
    pm, bb, ba, lb, la = r['pm'], r['bb'], r['ba'], r['lb'], r['la']
    for side in ('YES', 'NO'):
        key = (r['t'], side)
        won = (res == 'yes') == (side == 'YES')
        # OLD: gap against the list; IOC at list + 1c; fills only if the live book is still at or through that price
        list_gap = 100 * ((pm - la) if side == 'YES' else (lb - pm))
        if list_gap >= a.list_gap and key not in old:
            fired['old'] += 1
            limit = (la + 0.01) if side == 'YES' else (1 - lb + 0.01)
            live = ba if side == 'YES' else 1 - bb
            if live <= limit + 1e-9:
                fired['old_filled'] += 1
                old[key] = 100 * ((1 if won else 0) - live - fee(live))
        # NEW: gap against the live book; fills at the live price
        live_gap = 100 * ((pm - ba) if side == 'YES' else (bb - pm))
        if live_gap - 100 * fee(ba if side == 'YES' else 1 - bb) >= a.live_gap and key not in new:
            fired['new'] += 1
            px = ba if side == 'YES' else 1 - bb
            new[key] = 100 * ((1 if won else 0) - px - fee(px))


def band(xs):
    if len(xs) < 2:
        return '%+.1f (n=%d)' % (xs[0] if xs else 0.0, len(xs))
    return '%+.1f +/- %.1f c/contract (n=%d)' % (st.mean(xs), 1.96 * st.stdev(xs) / math.sqrt(len(xs)), len(xs))


print('shadow rows since %s: %d, settled tickers: %d' % (a.since, len(rows), len({r['t'] for r in rows if RES.get(r['t']) in ('yes', 'no')})))
print('OLD (list gap >= %.0fc, IOC at list + 1c): %d triggers, %d would have filled (%.0f%%)'
      % (a.list_gap, fired['old'], fired['old_filled'], 100 * fired['old_filled'] / max(1, fired['old'])))
print('     result of the fills:   %s' % band(list(old.values())))
print('NEW (live gap >= %.0fc net of fee):  %d triggers' % (a.live_gap, fired['new']))
print('     result:                %s' % band(list(new.values())))
both = set(old) & set(new)
print('overlap: %d tickers/sides traded by both; OLD-only %d; NEW-only %d' % (len(both), len(set(old) - set(new)), len(set(new) - set(old))))
