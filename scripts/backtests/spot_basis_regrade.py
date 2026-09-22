"""Was spot-first's FAIL a finding or a model error? Measure the Coinbase-vs-settlement-index basis and re-grade.

    python scripts/backtests/spot_basis_regrade.py [--dir data/spot-shadow] [--thr 3]

Kalshi's KX<COIN>15M markets settle on CF Benchmarks' index (the 60 s average before close), and the strike is the same
index's 60 s average before the open. The spot-first shadow (scripts/spot-shadow.mjs) prices the window from COINBASE
spot. Any steady Coinbase-minus-index gap shifts log(S/K) by a constant that the lognormal treats as signal, and it
dominates near expiry, where sigma*sqrt(tau) is smallest - exactly where a model is judged hardest. Its verdict on
2026-09-22 was FAIL at -2.49c/contract, and its fair value scored a Brier of 0.26 against Kalshi's mid at 0.157 - worse
than always guessing 50% (0.25), which is the signature of a biased model rather than an efficient market.

What this does, offline, from the recorder's own rows:
  1. basis at every boundary: Coinbase's 60 s average mid before the boundary minus the index value the venue printed
     for it (a settle row's `exp`; the next window's K is the same number);
  2. a basis-corrected fair value that uses ONLY what was known at the poll: S - (basis measured at this window's open);
  3. Brier of the recorded fair value, the corrected one and Kalshi's mid, by coin and by time left;
  4. the pre-registered decision rule (first qualifying poll per coin, window and side; spot <= 3 s old; >= 90 s left;
     edge net of the 1-contract taker fee >= threshold) graded with each fair value, with day-clustered bands.
Read-only, no network.
"""
import argparse, collections, glob, json, math, os, statistics as st
from datetime import datetime

ap = argparse.ArgumentParser()
ap.add_argument('--dir', default='G:/PROJECTS/oracle-trader/data/spot-shadow')
ap.add_argument('--thr', type=float, default=3.0)
a = ap.parse_args()

MS_PER_YEAR = 365 * 24 * 3600 * 1000


def erf(x):
    s = -1 if x < 0 else 1
    x = abs(x)
    t = 1 / (1 + 0.3275911 * x)
    y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * math.exp(-x * x)
    return s * y


def fair(spot, strike, close_ms, now_ms, sigma):   # the recorder's own formula (scripts/spot-shadow.mjs:56)
    if not (spot > 0 and strike > 0 and sigma > 0):
        return None
    tau_ms = close_ms - 30e3 - now_ms
    if tau_ms < 1000:
        return None
    tau = tau_ms / MS_PER_YEAR
    d2 = (math.log(spot / strike) - 0.5 * sigma * sigma * tau) / (sigma * math.sqrt(tau))
    return 0.5 * (1 + erf(d2 / math.sqrt(2)))


def fee_c(p):          # Kalshi taker fee for one contract, cents, rounded up
    return math.ceil(round(7 * p * (1 - p), 6))


def ts_ms(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000


bad = 0


def load(line):
    global bad
    try:
        return json.loads(line)
    except Exception:
        bad += 1        # torn or zero-filled lines (the 2026-09-21 power loss) are skipped and counted
        return None


cb = collections.defaultdict(lambda: [0.0, 0])      # (coin, boundary_s) -> Coinbase mid sum/count over the 60 s before
index = {}                                           # (coin, boundary_s) -> index value the venue printed
result = {}
polls = []
for f in sorted(glob.glob(os.path.join(a.dir, '2026-*.jsonl'))):
    with open(f, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            if '"v":"spot"' in line:
                r = load(line)
                if r is None:
                    continue
                t = ts_ms(r['ts']) / 1000
                if t % 900 >= 840:
                    b = (int(t // 900) + 1) * 900
                    mid = (r['bb'] + r['ba']) / 2 if r.get('bb') and r.get('ba') else r.get('p')
                    if mid:
                        c = cb[(r['coin'], b)]
                        c[0] += mid; c[1] += 1
            elif '"v":"k"' in line:
                r = load(line)
                if r is None:
                    continue
                if r.get('K') and r.get('spot') and r.get('sigma') and r.get('bid') is not None and r.get('ask') is not None:
                    polls.append(r)
            elif '"v":"settle"' in line:
                r = load(line)
                if r is None:
                    continue
                result[r['t']] = r.get('result')
                close_s = int(r['win']) + 900
                if r.get('exp'):
                    index[(r['coin'], close_s)] = r['exp']
                if r.get('K'):
                    index.setdefault((r['coin'], int(r['win'])), r['K'])

basis = {}
for key, v in index.items():
    c = cb.get(key)
    if c and c[1] >= 20:
        basis[key] = c[0] / c[1] - v
by_coin = collections.defaultdict(list)
for (coin, b), x in basis.items():
    by_coin[coin].append(x)

print('unreadable lines skipped: %d' % bad)
print('1. COINBASE MINUS THE SETTLEMENT INDEX, 60 s averages at each 15-minute boundary')
last_px = {}
for r in polls:
    last_px[r['coin']] = r['spot']
for coin in sorted(by_coin):
    xs = by_coin[coin]
    px = last_px.get(coin, 1)
    print('   %-5s boundaries %4d   median %+10.5f  (%+.2f bp)   p10..p90 %+.2f..%+.2f bp   share same sign as median %.0f%%'
          % (coin, len(xs), st.median(xs), 1e4 * st.median(xs) / px, 1e4 * sorted(xs)[len(xs) // 10] / px,
             1e4 * sorted(xs)[9 * len(xs) // 10] / px, 100 * sum(1 for x in xs if (x > 0) == (st.median(xs) > 0)) / len(xs)))

# ---- 3 & 4: corrected fair value, Brier, and the pre-registered rule ----
brier = collections.defaultdict(lambda: [0.0, 0.0, 0.0, 0])      # key -> fv, fv_adj, mid, n
first = {}
for r in polls:
    res = result.get(r['t'])
    if res not in ('yes', 'no'):
        continue
    now = ts_ms(r['ts'])
    close_ms = now + r['tauS'] * 1000
    open_s = int(round((close_ms / 1000 - 900) / 900)) * 900
    bo = basis.get((r['coin'], open_s))
    fv_adj = fair(r['spot'] - bo, r['K'], close_ms, now, r['sigma']) if bo is not None else None
    fv = r.get('fv')
    if fv is None or fv_adj is None:
        continue
    y = 1.0 if res == 'yes' else 0.0
    mid = (r['bid'] + r['ask']) / 2
    tb = '>10 min' if r['tauS'] > 600 else '5-10 min' if r['tauS'] > 300 else '2-5 min' if r['tauS'] > 120 else '<2 min'
    for key in (('coin', r['coin']), ('left', tb), ('all', 'all')):
        B = brier[key]
        B[0] += (fv - y) ** 2; B[1] += (fv_adj - y) ** 2; B[2] += (mid - y) ** 2; B[3] += 1
    if r.get('spotAge', 0) > 3000 or r['tauS'] < 90:
        continue
    day = r['ts'][:10]
    askc, bidc = 100 * r['ask'], 100 * r['bid']
    for name, v in (('recorded', fv), ('corrected', fv_adj)):
        for side in ('YES', 'NO'):
            k = (name, r['coin'], r['t'], side)
            if k in first:
                continue
            if side == 'YES' and r.get('askSz', 1) and 100 * v - askc - fee_c(r['ask']) >= a.thr:
                first[k] = (day, (100 - askc if res == 'yes' else -askc) - fee_c(r['ask']))
            if side == 'NO' and r.get('bidSz', 1) and bidc - 100 * v - fee_c(1 - r['bid']) >= a.thr:
                paid = 100 - bidc
                first[k] = (day, (100 - paid if res == 'no' else -paid) - fee_c(1 - r['bid']))

print('\n2. BRIER SCORE (lower is better; always guessing 50%% scores 0.250)')
print('   %-14s %8s %10s %11s %10s' % ('slice', 'samples', 'recorded', 'corrected', 'Kalshi mid'))
for key in sorted(brier, key=lambda k: (k[0] != 'all', k[0], k[1])):
    B = brier[key]
    print('   %-14s %8d %10.4f %11.4f %10.4f' % (key[1], B[3], B[0] / B[3], B[1] / B[3], B[2] / B[3]))


def band(rows):
    days = collections.defaultdict(list)
    for d, x in rows:
        days[d].append(x)
    n = len(rows)
    m = sum(x for _, x in rows) / n
    g = len(days)
    if g < 2:
        return '%+.2fc (n=%d, 1 day)' % (m, n)
    se = math.sqrt(g / (g - 1) * sum((sum(v) - len(v) * m) ** 2 for v in days.values())) / n
    return '%+.2fc  80%% [%+.2f, %+.2f]  95%% [%+.2f, %+.2f]  n=%d days=%d' % (m, m - 1.28 * se, m + 1.28 * se, m - 1.96 * se, m + 1.96 * se, n, g)


print('\n3. THE PRE-REGISTERED RULE AT %.0fc, graded with each fair value (day-clustered)' % a.thr)
for name in ('recorded', 'corrected'):
    rows = [v for k, v in first.items() if k[0] == name]
    print('   %-10s %s' % (name, band(rows) if rows else 'no decisions'))
    for coin in sorted({k[1] for k in first if k[0] == name}):
        cr = [v for k, v in first.items() if k[0] == name and k[1] == coin]
        print('      %-5s %s' % (coin, band(cr)))
