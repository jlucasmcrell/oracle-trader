"""Backlog 132: re-baseline lead-lag on quotes that were real. GET-only; places nothing.

Every dislocation row before 2026-09-17T09:40Z priced Kalshi from /markets?series_ticker=,
which the venue serves from a cache: measured side by side, it held a quote for 18 s while the
book moved 76c -> 82c. Gaps computed against a stale ask were partly fiction, so the +6-11c
"graded signal" those rows produced is void (REVIEW-CHANGES 111). Only rows carrying
kalshiSource == 'orderbook' were priced off the live book.

Grades each such row the way the engine traded it - buy one contract at the quoted Kalshi price
plus the taker fee, hold to Kalshi's published result - and puts that next to what the account's
own fills actually earned over the same window, so signal and execution are separated.
"""
import json, math, os, sys, time, urllib.parse, urllib.request
from collections import defaultdict

A = os.path.join(os.environ['APPDATA'], 'oracle-trader')
K = 'https://api.elections.kalshi.com/trade-api/v2'
SINCE = '2026-09-17T09:40'
COINS = ('BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'ZEC')
fee_c = lambda p: math.ceil(7 * p * (1 - p) - 1e-9)


def get(u):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'oracle-trader-research/1.0'}), timeout=25) as r:
                return json.load(r)
        except Exception:
            time.sleep(1.2 * (i + 1))
    return None


results = {}
for coin in COINS:
    cursor = None
    while True:
        q = {'series_ticker': f'KX{coin}15M', 'status': 'settled', 'limit': 200}
        if cursor:
            q['cursor'] = cursor
        d = get(f'{K}/markets?{urllib.parse.urlencode(q)}')
        if not d:
            break
        ms = d.get('markets') or []
        stop = False
        for m in ms:
            if m['close_time'][:16] < SINCE:
                stop = True
                break
            if m.get('result') in ('yes', 'no'):
                results[m['ticker']] = m['result']
        cursor = d.get('cursor')
        if stop or not cursor or not ms:
            break
print(f'settled results fetched: {len(results)}')

rows, seen, skip = [], set(), defaultdict(int)
for line in open(os.path.join(A, 'leadlag-dislocations.jsonl'), encoding='utf-8', errors='replace'):
    if '"orderbook"' not in line:
        continue
    r = json.loads(line)
    if r.get('kalshiSource') != 'orderbook' or r['ts'][:16] < SINCE:
        continue
    if not r.get('clearsFees'):
        skip['below fee'] += 1
        continue
    side = 'YES' if r['suggestedAction'] == 'BUY_KALSHI_YES' else 'NO'
    # One observation per ticker/side/minute. A swept gap is written twice (the recorded dislocation and
    # the executed row that carries the fill), so keep the executed copy - dropping it would leave the
    # executed cohort empty and make execution look untested.
    key = (r['kalshiTicker'], side, r['ts'][:16])
    if key in seen:
        if not r.get('executed'):
            skip['same minute'] += 1
            continue
        rows[:] = [x for x in rows if (x['t'], x['side'], x['ts'][:16]) != key]
        skip['same minute (kept executed)'] += 1
    seen.add(key)
    res = results.get(r['kalshiTicker'])
    if res is None:
        skip['unsettled'] += 1
        continue
    kp = r['kalshiPrice']
    cost = kp if side == 'YES' else 1 - kp
    fee = r.get('feeCents') if r.get('feeCents') is not None else fee_c(cost)
    won = (res == 'yes') == (side == 'YES')
    rows.append({'ts': r['ts'], 'day': r['ts'][:10], 'coin': r['underlying'], 't': r['kalshiTicker'], 'side': side,
                 'net': (100 * (1 - cost) if won else -100 * cost) - fee, 'won': won,
                 'executed': bool(r.get('executed')), 'lat': r.get('latencyMs')})
print('filtered:', dict(skip))


def band(rs):
    """Mean per-contract net with a day-clustered 80% band: same-window rows are not independent."""
    if not rs:
        return None
    xs = [r['net'] for r in rs]
    m = sum(xs) / len(xs)
    g = defaultdict(float)
    for r in rs:
        g[r['day']] += r['net'] - m
    se = math.sqrt(sum(v * v for v in g.values())) / len(xs)
    return m, m - 1.28 * se, m + 1.28 * se, len(g)


def show(label, rs):
    b = band(rs)
    if not b:
        print(f'  {label:34s} n=0')
        return
    m, lo, hi, d = b
    print(f'  {label:34s} n={len(rs):4d} win={100 * sum(r["won"] for r in rs) / len(rs):3.0f}%  '
          f'{m:+6.2f}c/contract  80% [{lo:+6.2f}, {hi:+6.2f}] over {d} day(s)')


print('\n== graded signal, orderbook-priced rows only (one per ticker/side/minute) ==')
show('all', rows)
for d in sorted({r['day'] for r in rows}):
    show(d, [r for r in rows if r['day'] == d])
print('\n== by coin ==')
for c in COINS:
    show(c, [r for r in rows if r['coin'] == c])
print('\n== rows the engine actually swept (executed) vs the ones it passed on ==')
show('executed', [r for r in rows if r['executed']])
show('not executed', [r for r in rows if not r['executed']])
lat = sorted(r['lat'] for r in rows if r['executed'] and isinstance(r.get('lat'), (int, float)))
if lat:
    print(f'  sweep latency n={len(lat)} median {lat[len(lat) // 2]:.0f}ms p90 {lat[int(0.9 * len(lat))]:.0f}ms max {lat[-1]:.0f}ms')

# --- what the account actually earned on those markets over the same window ---
dump = sys.argv[1] if len(sys.argv) > 1 else None
if dump:
    d = json.load(open(dump, encoding='utf-8'))
    fl = lambda x: float(x or 0)
    print(f'\n== actual fills since {SINCE}Z (venue dump {os.path.basename(dump)}) ==')
    tot_c = tot_n = 0.0
    for coin in COINS:
        c = n = 0.0
        for x in d['fills']:
            t = x.get('market_ticker', '')
            if not t.startswith(f'KX{coin}15M') or t not in results or x['created_time'][:16] < SINCE:
                continue
            q = fl(x['count_fp'])
            price = fl(x['yes_price_dollars'] if x['side'] == 'yes' else x['no_price_dollars'])
            n += q * ((1 - price) if results[t] == x['side'] else -price) - fl(x.get('fee_cost'))
            c += q
        tot_c += c
        tot_n += n
        if c:
            print(f'  {coin:8s} contracts {c:5.0f}  {100 * n / c:+6.2f}c/contract  net ${n:+.2f}')
    if tot_c:
        print(f'  {"TOTAL":8s} contracts {tot_c:5.0f}  {100 * tot_n / tot_c:+6.2f}c/contract  net ${tot_n:+.2f}')
