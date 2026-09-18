"""Would lead-lag's pre-Sep-12 configuration still be profitable? GET-only (public Kalshi results); no orders.

Every Polymarket-vs-Kalshi gap the engine saw is in leadlag-dislocations.jsonl, including while it traded a different
configuration or was paused. Grade those gaps the way the old configuration traded them:
  - BTC and ETH only (HYPE reported separately), gap clears the Kalshi taker fee, Polymarket mid 5-95c,
    live CLOB book with spread <= 5c when those fields exist;
  - one observation per (ticker, side, UTC minute): the old engine scanned once a minute (the 10 s era recorded at most
    one row a minute per ticker and side, so every period is thinned to the same cadence);
  - buy one contract at the quoted Kalshi price (YES at the ask, NO at 1 - bid) plus the taker fee, hold to Kalshi's
    result. Size scales dollars, not the per-contract sign.
Calibrated against the fills we actually got in the same periods (venue dump), so the gap between "the recorded gap"
and "what the IOC actually filled" is visible rather than assumed away.
"""
import json, math, os, sys, time, urllib.parse, urllib.request
from collections import defaultdict
from datetime import datetime, timezone

A = os.path.join(os.environ['APPDATA'], 'oracle-trader')
K = 'https://api.elections.kalshi.com/trade-api/v2'
SINCE = datetime(2026, 9, 7, tzinfo=timezone.utc)
PERIODS = [('A winning setup (<=4 ct, 60 s, BTC/ETH)', '2026-09-07T00:00', '2026-09-12T12:46'),
           ('B cap reads on, 8 ct, 60 s', '2026-09-12T12:46', '2026-09-13T10:05'),
           ('C 10 s, seven coins, window caps', '2026-09-13T10:05', '2026-09-16T07:35'),
           ('D restored setup (live 1 h, then paused)', '2026-09-16T07:35', '2026-09-18T00:00')]
fee_c = lambda p: math.ceil(7 * p * (1 - p) - 1e-9)


def get(u):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'oracle-trader-research/1.0'}), timeout=25) as r:
                return json.load(r)
        except Exception:
            time.sleep(1.5 * (i + 1))
    return None


results = {}
for series in ('KXBTC15M', 'KXETH15M', 'KXSOL15M', 'KXXRP15M', 'KXDOGE15M', 'KXBNB15M', 'KXHYPE15M'):
    cursor = None
    while True:
        q = {'series_ticker': series, 'status': 'settled', 'limit': 200}
        if cursor: q['cursor'] = cursor
        d = get(f'{K}/markets?{urllib.parse.urlencode(q)}')
        if not d: break
        ms = d.get('markets') or []
        stop = False
        for m in ms:
            if datetime.fromisoformat(m['close_time'].replace('Z', '+00:00')) < SINCE:
                stop = True; break
            if m.get('result') in ('yes', 'no'): results[m['ticker']] = m['result']
        cursor = d.get('cursor')
        if stop or not cursor or not ms: break
        time.sleep(0.2)
print(f'settled 15M results fetched: {len(results)}')

rows, seen, skipped = [], set(), defaultdict(int)
for line in open(os.path.join(A, 'leadlag-dislocations.jsonl'), encoding='utf-8', errors='replace'):
    try: r = json.loads(line)
    except Exception: continue
    ts = r.get('ts', '')
    if ts < '2026-09-07': continue
    coin = r.get('underlying')
    if not r.get('clearsFees'): skipped['not clearing'] += 1; continue
    pp = r.get('polyPrice')
    if pp is None or not (0.05 < pp < 0.95): skipped['poly extreme'] += 1; continue
    if r.get('polySource') not in (None, 'clob-book'): skipped['not clob book'] += 1; continue
    if r.get('polyBid') is not None and r.get('polyAsk') is not None and (r['polyAsk'] - r['polyBid']) * 100 > 5 + 1e-9:
        skipped['wide poly'] += 1; continue
    side = 'YES' if r['suggestedAction'] == 'BUY_KALSHI_YES' else 'NO'
    key = (r['kalshiTicker'], side, ts[:16])
    if key in seen: skipped['same minute'] += 1; continue
    seen.add(key)
    res = results.get(r['kalshiTicker'])
    if res is None: skipped['unsettled'] += 1; continue
    kp = r['kalshiPrice']
    cost = kp if side == 'YES' else 1 - kp
    fee = r.get('feeCents') if r.get('feeCents') is not None else fee_c(cost)
    won = (res == 'yes') == (side == 'YES')
    rows.append({'ts': ts, 'day': ts[:10], 'coin': coin, 't': r['kalshiTicker'], 'side': side, 'cost': cost,
                 'net': (100 * (1 - cost) if won else -100 * cost) - fee, 'won': won})
print('filtered:', dict(skipped))


def band(xs, days):
    n = len(xs)
    if n == 0: return None
    m = sum(xs) / n
    g = defaultdict(float)
    for x, dd in zip(xs, days): g[dd] += x - m
    se = math.sqrt(sum(v * v for v in g.values())) / n
    return m, m - 1.28 * se, m + 1.28 * se, len(g)


def show(label, rs):
    b = band([r['net'] for r in rs], [r['day'] for r in rs])
    if not b: print(f'  {label:44s} n=0'); return
    m, lo, hi, D = b
    print(f"  {label:44s} n={len(rs):5d} markets={len({r['t'] for r in rs}):4d} win={100*sum(r['won'] for r in rs)/len(rs):3.0f}%  "
          f"{m:+6.2f}c/contract  80% band [{lo:+6.2f}, {hi:+6.2f}] over {D} day(s)")


print('\n== hypothetical, old rules, 1 contract per observation-minute, BTC+ETH ==')
for name, a, b in PERIODS:
    show(name, [r for r in rows if a <= r['ts'] < b and r['coin'] in ('BTC', 'ETH')])
print('\n== same, first observation per ticker and side per window only (no repeats) ==')
for name, a, b in PERIODS:
    first = {}
    for r in sorted((r for r in rows if a <= r['ts'] < b and r['coin'] in ('BTC', 'ETH')), key=lambda r: r['ts']):
        first.setdefault((r['t'], r['side']), r)
    show(name, list(first.values()))
print('\n== hypothetical by UTC day, BTC+ETH ==')
for d in sorted({r['day'] for r in rows}):
    show(d, [r for r in rows if r['day'] == d and r['coin'] in ('BTC', 'ETH')])
print('\n== HYPE (added 09-16), hypothetical by period ==')
for name, a, b in PERIODS:
    show(name, [r for r in rows if a <= r['ts'] < b and r['coin'] == 'HYPE'])

# ---- calibration: actual BTC/ETH fills in the same periods ----
dump = max((os.path.join('G:/PROJECTS/oracle-trader/tmp', f) for f in os.listdir('G:/PROJECTS/oracle-trader/tmp') if f.startswith('k-') and f.endswith('.json')), key=os.path.getmtime)
d = json.load(open(dump, encoding='utf-8'))
fl = lambda x: float(x or 0)
print(f'\n== actual BTC+ETH fills (venue dump {os.path.basename(dump)}), net per contract at the fill price ==')
for name, a, b in PERIODS:
    c = n = 0.0
    for x in d['fills']:
        t = x.get('market_ticker', '')
        if not (t.startswith('KXBTC15M') or t.startswith('KXETH15M')) or t not in results: continue
        if not (a <= x['created_time'][:16] < b): continue
        q = fl(x['count_fp']); side = x['side']; price = fl(x['yes_price_dollars'] if side == 'yes' else x['no_price_dollars'])
        won = results[t] == side
        n += q * ((1 - price) if won else -price) - fl(x.get('fee_cost')); c += q
    print(f'  {name:44s} contracts {c:6.0f}  ' + (f'{100*n/c:+6.2f}c/contract  net ${n:+.2f}' if c else 'no fills'))

print('\n== by coin since the seven-coin expansion (2026-09-13 10:05Z): graded signal vs actual fills ==')
for coin in ('BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'):
    show(f'{coin} graded signal', [r for r in rows if r['ts'] >= '2026-09-13T10:05' and r['coin'] == coin])
    c = n = 0.0
    for x in d['fills']:
        t = x.get('market_ticker', '')
        if not t.startswith(f'KX{coin}15M') or t not in results or x['created_time'][:16] < '2026-09-13T10:05': continue
        q = fl(x['count_fp']); side = x['side']; price = fl(x['yes_price_dollars'] if side == 'yes' else x['no_price_dollars'])
        n += q * ((1 - price) if results[t] == side else -price) - fl(x.get('fee_cost')); c += q
    print(f'  {coin + " actual fills":44s} contracts {c:6.0f}  ' + (f'{100*n/c:+6.2f}c/contract  net ${n:+.2f}' if c else 'no fills'))

