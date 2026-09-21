"""Where did lead-lag's money go, by time-to-close and distance from the strike at the fill?
Inputs (all local, no network): our 15M fills (tmp/k-2026-09-14.json), the 3-day settlement comparison
(settlement_basis.json: per window Kalshi result, Polymarket result, strike, expiration value), and the
btc-collector's per-minute spot for the five Coinbase coins (data/btc-collector/*.jsonl `ladder` rows)."""
import glob, json, math, os
from collections import defaultdict
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sb = json.load(open('G:/PROJECTS/oracle-trader/data/leadlag-basis/settlement_basis.json'))
win = {r['ticker']: r for r in sb['rows']}
# See leadlag_settlement_basis.py: `tmp/k-*.json` alone misses `tmp/kalshi-<date>.json`, so this read was
# joining our fills from a stale dump. An explicit path as argv[1] pins it.
import sys
_dumps = glob.glob('G:/PROJECTS/oracle-trader/tmp/k-*.json') + glob.glob('G:/PROJECTS/oracle-trader/tmp/kalshi-*.json')
DUMP = sys.argv[1] if len(sys.argv) > 1 else max(_dumps, key=os.path.getmtime)
print(f'venue dump: {DUMP}')
dump = json.load(open(DUMP, encoding='utf-8'))
fills = [f for f in dump['fills'] if f.get('market_ticker') in win]
print(f'fills on matched windows: {len(fills)} (of {sum(1 for f in dump["fills"] if "15M-" in f.get("market_ticker", ""))} 15M fills in the dump)')

# per-minute spot per coin from the collector: coin -> sorted [(ts_ms, spot)]
spot = defaultdict(list)
for f in sorted(glob.glob('G:/PROJECTS/oracle-trader/data/btc-collector/2026-*.jsonl')[-10:]):
    for line in open(f, encoding='utf-8', errors='replace'):
        if '"ladder"' not in line[:70] or '15M' not in line[:140]:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        cb = (r.get('spot') or {}).get('cb')
        if cb:
            spot[r['coin']].append((datetime.fromisoformat(r['ts'].replace('Z', '+00:00')).timestamp() * 1000, cb))
for c in spot:
    spot[c].sort()
print('spot minutes per coin:', {c: len(v) for c, v in spot.items()})


def spot_at(coin, ts_ms):
    arr = spot.get(coin)
    if not arr:
        return None
    lo, hi = 0, len(arr) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if arr[mid][0] < ts_ms:
            lo = mid + 1
        else:
            hi = mid
    best = min((arr[i] for i in (lo - 1, lo) if 0 <= i < len(arr)), key=lambda x: abs(x[0] - ts_ms))
    return best[1] if abs(best[0] - ts_ms) <= 90e3 else None


rows = []
for f in fills:
    w = win[f['market_ticker']]
    coin = w['coin']
    ts = datetime.fromisoformat(f['created_time'].replace('Z', '+00:00')).timestamp() * 1000
    close_ms = datetime.fromisoformat(w['close'].replace('Z', '+00:00')).timestamp() * 1000
    mtc = (close_ms - ts) / 60e3
    side = f['side']
    price = float(f['yes_price_dollars'] if side == 'yes' else f['no_price_dollars'])
    n = float(f['count_fp'])
    won = (w['kalshi'] == side)
    pnl = n * ((1 - price) if won else -price) - float(f.get('fee_cost') or 0)
    s = spot_at(coin, ts)
    K = float(w['floor']) if w['floor'] else None
    dist = abs(s - K) / K * 1e4 if (s and K) else None
    poly = (w['poly'] or {}).get('result')
    rows.append({'t': f['market_ticker'], 'coin': coin, 'mtc': mtc, 'side': side, 'price': price, 'n': n, 'won': won, 'pnl': pnl,
                 'dist': dist, 'disagree': bool(w.get('DISAGREE')), 'poly_side': poly == side,
                 'day': f['created_time'][:10]})

print(f'rows with spot distance: {sum(1 for r in rows if r["dist"] is not None)} / {len(rows)}')
tot = sum(r['pnl'] for r in rows)
print(f'net on matched windows: ${tot:+.2f} over {len(rows)} fills, {sum(r["n"] for r in rows):.0f} contracts')
dis = [r for r in rows if r['disagree']]
print(f'in venue-disagreeing windows: {len(dis)} fills, ${sum(r["pnl"] for r in dis):+.2f}; the rest ${tot - sum(r["pnl"] for r in dis):+.2f}')


def bucket_m(m):
    return '<2m' if m < 2 else '2-5m' if m < 5 else '5-10m' if m < 10 else '>=10m'


def bucket_d(d):
    if d is None:
        return 'n/a'
    return '<2bp' if d < 2 else '2-5bp' if d < 5 else '5-10bp' if d < 10 else '>=10bp'


print('\n== net $ by minutes-to-close x |spot-strike| at the fill (fills, contracts, win%, $) ==')
grid = defaultdict(lambda: [0, 0.0, 0, 0.0])
for r in rows:
    g = grid[(bucket_m(r['mtc']), bucket_d(r['dist']))]
    g[0] += 1; g[1] += r['n']; g[2] += r['won']; g[3] += r['pnl']
for m in ['>=10m', '5-10m', '2-5m', '<2m']:
    line = f'{m:6s}'
    for d in ['>=10bp', '5-10bp', '2-5bp', '<2bp', 'n/a']:
        g = grid.get((m, d))
        line += f" | {d:6s} " + (f"{g[0]:3d}f {g[1]:5.0f}c {100 * g[2] / g[0]:3.0f}% ${g[3]:+7.2f}" if g else ' ' * 26)
    print(line)
print('\n== by minutes-to-close only ==')
for m in ['>=10m', '5-10m', '2-5m', '<2m']:
    rr = [r for r in rows if bucket_m(r['mtc']) == m]
    if rr:
        print(f"  {m:6s} fills {len(rr):4d} contracts {sum(r['n'] for r in rr):5.0f} win {100 * sum(r['won'] for r in rr) / len(rr):3.0f}% net ${sum(r['pnl'] for r in rr):+.2f}  disagree-window share of loss ${sum(r['pnl'] for r in rr if r['disagree']):+.2f}")
print('\n== by distance only ==')
for d in ['>=10bp', '5-10bp', '2-5bp', '<2bp', 'n/a']:
    rr = [r for r in rows if bucket_d(r['dist']) == d]
    if rr:
        print(f"  {d:6s} fills {len(rr):4d} contracts {sum(r['n'] for r in rr):5.0f} win {100 * sum(r['won'] for r in rr) / len(rr):3.0f}% net ${sum(r['pnl'] for r in rr):+.2f}")
print('\n== candidate gate: skip when mtc < 3 AND |spot-strike| < 5 bp ==')
gated = [r for r in rows if r['mtc'] < 3 and r['dist'] is not None and r['dist'] < 5]
kept = [r for r in rows if r not in gated]
print(f"  gated: {len(gated)} fills ${sum(r['pnl'] for r in gated):+.2f}; kept: {len(kept)} fills ${sum(r['pnl'] for r in kept):+.2f}")
for thr_m, thr_d in [(2, 5), (3, 3), (3, 10), (5, 5), (5, 10)]:
    g = [r for r in rows if r['mtc'] < thr_m and r['dist'] is not None and r['dist'] < thr_d]
    print(f"  mtc<{thr_m} & dist<{thr_d}bp: gated {len(g):3d} fills ${sum(r['pnl'] for r in g):+7.2f}; kept ${tot - sum(r['pnl'] for r in g):+7.2f}")
# Backlog 86's rule is stated on a BAND, not a total: "build a gate ONLY if that cell's day-clustered upper
# band is below zero over >= 7 days". A cell can be negative in dollars and still be one bad day, so the
# total alone cannot answer it. Days are the cluster because the fills inside a day share a regime.
def day_band(sel, label):
    byday = defaultdict(lambda: [0.0, 0.0])
    for r in sel:
        byday[r['day']][0] += r['pnl'] * 100.0
        byday[r['day']][1] += r['n']
    per = [c / n for c, n in byday.values() if n > 0]
    d = len(per)
    if d == 0:
        print('  %s: no fills' % label)
        return
    mean = sum(per) / d
    if d < 2:
        print('  %s: %d day, mean %+.2fc/contract, no band' % (label, d, mean))
        return
    var = sum((x - mean) ** 2 for x in per) / (d - 1)
    se = (var / d) ** 0.5
    lo, hi = mean - 1.96 * se, mean + 1.96 * se
    if hi < 0 and d >= 7:
        verdict = 'GATE (upper band below zero over %d days)' % d
    elif hi >= 0:
        verdict = 'no gate: upper band >= 0'
    else:
        verdict = 'no gate: only %d days' % d
    print('  %s: %d days, %d fills, mean %+.2fc/contract, day-clustered CI95 [%+.2f, %+.2f] -> %s'
          % (label, d, len(sel), mean, lo, hi, verdict))


print('\n== the registered cell, day-clustered (backlog 86) ==')
day_band(gated, 'mtc<3 & dist<5bp')
day_band([r for r in rows if r['mtc'] < 2 and r['dist'] is not None and r['dist'] < 5], 'mtc<2 & dist<5bp')
day_band(rows, 'all matched fills')

print('\n== by day ==')
byday = defaultdict(float)
for r in rows:
    byday[r['t']] += 0
print('(per-window list of the worst 8)')
byw = defaultdict(lambda: [0.0, 0, None, None, None])
for r in rows:
    b = byw[r['t']]; b[0] += r['pnl']; b[1] += 1; b[2] = r['disagree']; b[3] = min(b[3], r['mtc']) if b[3] is not None else r['mtc']; b[4] = r['dist']
for t, b in sorted(byw.items(), key=lambda x: x[1][0])[:8]:
    print(f"  {t:28s} ${b[0]:+7.2f} fills {b[1]:3d} disagree={b[2]} earliest-mtc {b[3]:.1f} dist {b[4] if b[4] is None else round(b[4], 1)}bp")

print('\n== by UTC day x minutes-to-close (fills, $) ==')
bd = defaultdict(lambda: [0, 0.0])
for r in rows:
    day = win[r['t']]['close'][:10]
    g = bd[(day, bucket_m(r['mtc']))]; g[0] += 1; g[1] += r['pnl']
for day in sorted({k[0] for k in bd}):
    print('  ' + day + '  ' + '  '.join(f"{m}: {bd[(day, m)][0]:3d}f ${bd[(day, m)][1]:+7.2f}" for m in ['>=10m', '5-10m', '2-5m', '<2m']))
print('\n== by UTC day x distance (fills, $) ==')
bd2 = defaultdict(lambda: [0, 0.0])
for r in rows:
    day = win[r['t']]['close'][:10]
    g = bd2[(day, bucket_d(r['dist']))]; g[0] += 1; g[1] += r['pnl']
for day in sorted({k[0] for k in bd2}):
    print('  ' + day + '  ' + '  '.join(f"{d}: {bd2[(day, d)][0]:3d}f ${bd2[(day, d)][1]:+7.2f}" for d in ['>=10bp', '5-10bp', '2-5bp', '<2bp', 'n/a']))
