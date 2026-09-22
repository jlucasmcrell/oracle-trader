"""Grade the event-speed lead-lag shadow (PREREGISTERED-leadlag-fast-shadow, REVIEW-CHANGES section 159).

    python scripts/backtests/leadlag_fast_shadow.py [--since 2026-09-22T22:00Z] [--results r.json]

Reads %APPDATA%/oracle-trader/leadlag-fast-shadow.jsonl: an 'open' row when Polymarket's pushed price first clears
Kalshi's pushed ask (or bid, for NO) by more than Kalshi's one-contract taker fee, and a 'close' row with the gap's
duration when it falls back. Both books are in memory and checked every 250 ms - no polling - so this measures what
an event-driven arm would see.

Reports, per net threshold (2, 4, 6c): how many gaps opened per hour, how long they lasted, and the P&L of buying
one contract at the Kalshi price available when each gap opened, held to settlement, with a day-clustered band.
Duration answers "how fast would we have to be"; P&L answers "would it pay". Results come from Kalshi's public
settled-markets list (paced) unless --results is given. Read-only.
"""
import argparse, collections, json, math, os, statistics as st, sys, time, urllib.request
from datetime import datetime, timezone

ap = argparse.ArgumentParser()
ap.add_argument('--since', default='2026-09-22T00:00Z')
ap.add_argument('--file', default=os.path.join(os.environ.get('APPDATA', ''), 'oracle-trader', 'leadlag-fast-shadow.jsonl'))
ap.add_argument('--results', help='JSON {ticker: "yes"|"no"} instead of the public API (tests)')
a = ap.parse_args()
since = datetime.fromisoformat(a.since.replace('Z', '+00:00'))


def fee(p):  # Kalshi taker fee, one contract, probability units: 0.07 P(1-P) ceiled to $0.0001 (kalshiFee.ts)
    return math.ceil(round(0.07 * p * (1 - p) * 10000, 6)) / 10000


opens, closes = [], {}
for line in open(a.file, encoding='utf-8', errors='replace'):
    try:
        r = json.loads(line)
    except Exception:
        continue
    if datetime.fromisoformat(r['ts'].replace('Z', '+00:00')) < since:
        continue
    if r['ev'] == 'open':
        opens.append(r)
    elif r['ev'] == 'close':
        closes.setdefault((r['t'], r['side']), []).append(r)
if not opens:
    sys.exit('no gaps recorded since %s in %s' % (a.since, a.file))

# pair each open with the next close on the same ticker and side
for o in opens:
    q = closes.get((o['t'], o['side']), [])
    o['durMs'] = None
    for i, c in enumerate(q):
        if c['ts'] >= o['ts']:
            o['durMs'] = c['durMs']
            o['peak'] = c.get('peak')
            q.pop(i)
            break

if a.results:
    RES = json.load(open(a.results))
else:
    RES = {}
    for coin in sorted({o['c'] for o in opens}):
        cur = ''
        while True:
            u = 'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KX%s15M&status=settled&limit=1000&min_close_ts=%d%s' % (
                coin, int(since.timestamp()), ('&cursor=' + cur) if cur else '')
            d = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'oracle-trader-readonly'}), timeout=25))
            RES.update({m['ticker']: m.get('result') for m in d.get('markets', [])})
            cur = d.get('cursor') or ''
            time.sleep(0.5)
            if not cur or not d.get('markets'):
                break

t0 = min(datetime.fromisoformat(o['ts'].replace('Z', '+00:00')) for o in opens)
t1 = max(datetime.fromisoformat(o['ts'].replace('Z', '+00:00')) for o in opens)
hours = max((t1 - t0).total_seconds() / 3600, 1 / 60)
print('gaps recorded: %d over %.1f h (%s .. %s)' % (len(opens), hours, t0.strftime('%m-%d %H:%MZ'), t1.strftime('%m-%d %H:%MZ')))


def band(rows):
    days = collections.defaultdict(list)
    for x in rows:
        days[x[0]].append(x[1])
    n = len(rows)
    m = sum(x[1] for x in rows) / n
    g = len(days)
    if g < 2:
        return '%+.2fc (n=%d, %d day)' % (m, n, g)
    se = math.sqrt(g / (g - 1) * sum((sum(v) - len(v) * m) ** 2 for v in days.values())) / n
    return '%+.2fc  80%% [%+.2f, %+.2f]  n=%d  days=%d' % (m, m - 1.28 * se, m + 1.28 * se, n, g)


for thr in (2, 4, 6):
    xs = [o for o in opens if o['net'] >= thr]
    if not xs:
        continue
    dur = sorted(o['durMs'] for o in xs if o.get('durMs') is not None)
    first, seen = [], set()
    for o in sorted(xs, key=lambda o: o['ts']):
        res = RES.get(o['t'])
        if res not in ('yes', 'no') or (o['t'], o['side']) in seen:
            continue
        seen.add((o['t'], o['side']))
        won = (res == 'yes') == (o['side'] == 'YES')
        first.append((o['ts'][:10], 100 * ((1 if won else 0) - o['px'] - fee(o['px']))))
    print('\nnet >= %dc: %d gaps (%.1f per hour)' % (thr, len(xs), len(xs) / hours))
    if dur:
        print('   lasted: median %.1f s, p75 %.1f s, p90 %.1f s; share under 1 s %.0f%%, under 5 s %.0f%%' % (
            dur[len(dur) // 2] / 1000, dur[int(.75 * len(dur))] / 1000, dur[int(.9 * len(dur))] / 1000,
            100 * sum(d < 1000 for d in dur) / len(dur), 100 * sum(d < 5000 for d in dur) / len(dur)))
    print('   buying at the price when it opened, first gap per market and side, held to settlement: %s'
          % (band(first) if first else 'no settled markets yet'))
