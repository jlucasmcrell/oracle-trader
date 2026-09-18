"""Does our HRRR daily-max forecast beat the Kalshi market's ask on KXHIGHT brackets? GET-only.

Answer (2026-09-18, 2,045 bracket-hour snapshots, 136 station-days, 09-06..09-17): NO.
  - Buying YES at the ask whenever HRRR-implied probability exceeded the ask by >= 5c: -1.5c/contract
    (95% [-5.1, +2.0]); by >= 20c: -4.3c [-8.5, -0.2]; tails alone at >= 15c: -7.5c [-8.9, -6.0].
  - HRRR-implied probability is overconfident on these brackets: the 0.3-0.5 bucket resolved YES 8%.
  - The market is calibrated: mean ask 7-8c, realized 7%.
  - Caveat: the book log only holds brackets the scan universe looked at (cheap tails and low-probability
    brackets, mean ask 7c). The modal bracket is not in the sample, so "HRRR beats the market at the mode"
    is untested here. Testing it needs full-event book snapshots, which nothing records today.

A first version of this analysis inferred tail direction from a fixed 85F rule and read T89 as ">= 89";
it produced +23c to +72c per contract. Both were labelling errors (T89 is "90 or above"; a cool station's
high tail sits below 85F). Every number above uses Kalshi's own strike_type/floor/cap and the market result.

Inputs: data/hrrr-shadow/forecasts.jsonl (hrrrMaxDay by station/localDate/localHour), episodes book rows
for KXHIGHT tickers (%APPDATA%/oracle-trader/episodes/kalshi-*.jsonl), and /markets/{ticker} for semantics
and results (cached in tmp/hight-markets.json).
"""
import json, os, glob, re, math, time, datetime as dt, urllib.request
from collections import defaultdict
from statistics import NormalDist

A = os.path.join(os.environ['APPDATA'], 'oracle-trader')
MON = {m: i + 1 for i, m in enumerate(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'])}
# HRRR daily-max MAE (F) by local hour of the forecast, measured 2026-09-06..17 against grades.jsonl.
MAE = {0: 1.84, 1: 1.8, 2: 2.06, 3: 1.98, 4: 1.94, 5: 1.97, 6: 2.01, 7: 1.94, 8: 1.92, 9: 1.96, 10: 1.95, 11: 1.87,
       12: 1.82, 13: 1.76, 14: 1.62, 15: 1.52, 16: 1.45, 17: 1.38, 18: 1.25, 19: 1.23, 20: 1.22, 21: 1.23, 22: 1.24, 23: 1.23}
fee = lambda p: math.ceil(7 * p * (1 - p) - 1e-9)

graded = {(r['station'], r['localDate']) for r in (json.loads(l) for l in open('data/hrrr-shadow/grades.jsonl', encoding='utf-8') if l.strip())}
F = defaultdict(dict); off = defaultdict(list)
for r in (json.loads(l) for l in open('data/hrrr-shadow/forecasts.jsonl', encoding='utf-8') if l.strip()):
    if isinstance(r.get('hrrrMaxDay'), (int, float)) and r.get('localHour') is not None:
        F[(r['station'], r['localDate'])][r['localHour']] = r['hrrrMaxDay']
        try:
            off[r['station']].append((r['localHour'] - dt.datetime.fromisoformat(r['at'].replace('Z', '+00:00')).hour) % 24)
        except Exception:
            pass
tz = {s: max(set(v), key=v.count) for s, v in off.items()}

snap = {}
for f in sorted(glob.glob(os.path.join(A, 'episodes', 'kalshi-*.jsonl'))):
    for l in open(f, encoding='utf-8', errors='replace'):
        if '"book"' not in l[:40] or 'KXHIGHT' not in l[:140]:
            continue
        try:
            r = json.loads(l)
        except Exception:
            continue
        t = r.get('marketId') or ''
        m = re.match(r'KXHIGHT([A-Z]+)-(\d\d)([A-Z]{3})(\d\d)-[BT][\d.]+$', t)
        if not m:
            continue
        st, yy, mon, dd = m.groups(); date = f'20{yy}-{MON[mon]:02d}-{dd}'
        if (st, date) not in graded or (st, date) not in F:
            continue
        ts = r.get('ts'); ts = int(ts) if isinstance(ts, str) and ts.isdigit() else ts
        if not isinstance(ts, (int, float)):
            continue
        lh = (dt.datetime.fromtimestamp(ts / 1000, dt.timezone.utc).hour + tz.get(st, 0)) % 24
        if (t, lh) in snap:
            continue
        asks = r.get('asks') or []; bids = r.get('bids') or []
        if not asks or not bids:
            continue
        ask = float(asks[0][0]); bid = float(bids[0][0])
        if not (0.02 <= ask <= 0.98) or ask - bid > 0.10:
            continue
        hr = F[(st, date)].get(lh)
        if hr is None:
            continue
        snap[(t, lh)] = dict(t=t, st=st, date=date, lh=lh, ask=ask, hr=hr)

cp = 'tmp/hight-markets.json'
M = json.load(open(cp)) if os.path.exists(cp) else {}
todo = [t for t in sorted({k[0] for k in snap}) if t not in M]
for i, t in enumerate(todo):
    try:
        with urllib.request.urlopen(urllib.request.Request(f'https://api.elections.kalshi.com/trade-api/v2/markets/{t}', headers={'User-Agent': 'oracle-trader-research/1.0'}), timeout=20) as r:
            m = json.load(r).get('market') or {}
        M[t] = {k: m.get(k) for k in ('strike_type', 'floor_strike', 'cap_strike', 'result', 'status')}
    except Exception as e:
        M[t] = {'err': str(e)[:40]}
    if i % 25 == 0:
        time.sleep(0.5)
json.dump(M, open(cp, 'w'))


def p_in(mu, sig, m):
    """Probability the daily max lands in the bracket, under N(mu, sig). Kalshi: 'between' floor..cap inclusive,
    'less' cap 82 means '81 or below', 'greater' floor 89 means '90 or above'."""
    N = NormalDist(mu, sig); k = m.get('strike_type'); fl = m.get('floor_strike'); cap = m.get('cap_strike')
    if k == 'between': return N.cdf(cap + 0.5) - N.cdf(fl - 0.5)
    if k == 'less': return N.cdf(cap - 0.5)
    if k == 'greater': return 1 - N.cdf(fl + 0.5)
    return None


rows = []
for (t, lh), s in snap.items():
    m = M.get(t) or {}
    if m.get('result') not in ('yes', 'no'):
        continue
    ph = p_in(s['hr'], 1.25 * MAE[lh], m)
    if ph is None:
        continue
    rows.append(dict(**s, ph=ph, won=m['result'] == 'yes', tail=m['strike_type'] != 'between'))
print(f'snapshots {len(rows)}, station-days {len({(r["st"], r["date"]) for r in rows})}')


def cell(g):
    n = len(g)
    if n < 15:
        return f'n={n:4d}  -'
    net = [((1 - r['ask']) if r['won'] else -r['ask']) * 100 - fee(r['ask']) for r in g]
    mu = sum(net) / n; d = defaultdict(float)
    for r, x in zip(g, net):
        d[(r['st'], r['date'])] += x - mu
    se = math.sqrt(sum(v * v for v in d.values())) / n
    return (f'n={n:4d} buy@ask {mu:+6.2f}c 95%[{mu - 1.96 * se:+6.2f},{mu + 1.96 * se:+6.2f}] '
            f'hit {100 * sum(r["won"] for r in g) / n:3.0f}% ask-implied {100 * sum(r["ask"] for r in g) / n:3.0f}%')


early = [r for r in rows if 6 <= r['lh'] <= 13]
print('hours 6-13 local, buy YES at the ask when HRRR-implied p - ask >= edge:')
for e in (0.05, 0.10, 0.15, 0.20, 0.30):
    print(f'  edge>={e:.2f}: {cell([r for r in early if r["ph"] - r["ask"] >= e])}')
print('  control edge<0: ' + cell([r for r in early if r['ph'] - r['ask'] < 0]))
print('  everything:     ' + cell(early))
print('calibration of HRRR-implied p, hours 6-13:')
for lo, hi in ((0, .1), (.1, .3), (.3, .5), (.5, .7), (.7, 1.01)):
    g = [r for r in early if lo <= r['ph'] < hi]
    if g:
        print(f'  ph {lo:.1f}-{hi:.1f}: n={len(g):4d} realized {100 * sum(r["won"] for r in g) / len(g):3.0f}%  mean ask {100 * sum(r["ask"] for r in g) / len(g):3.0f}c')
