"""Kalshi <-> ForecastEx same-event divergence on economic prints (backlog 150). GET-only, offline.

Pairs every ForecastEx threshold contract the IBKR lab quotes (ibkr-quotes/*.jsonl, appended each scan) with the
Kalshi market that settles on the same published number (data/weather-books/*.jsonl, which captures the econ
series every 30 min), and prints the divergence and the cost of the two cross-venue baskets:
  A = buy ForecastEx YES at its ask + buy Kalshi NO at (1 - Kalshi YES bid)   pays $1 if both settle YES/NO alike
  B = buy ForecastEx NO at its ask + buy Kalshi YES at its ask
A basket under $1 is a Dutch book ONLY if the two contracts settle on the identical figure. That is why
temperature is excluded (§119: 7 of 22 station-days disagree) and why the mapping below is explicit per product.

Mapping (ForecastEx "exceed X" is strictly greater; Kalshi "Above X" / T-greater is strictly greater):
  CPIY  MMDDYY_X  -> KXCPIYOY-<release month's data month>-T<X>      same one-decimal YoY figure
  UNR   MMDDYY_X  -> KXU3-<data month>-T<X>                          same one-decimal rate
  PREMP MMDDYY_X  -> KXPAYROLLS-<data month>-T<X>                    same headline change
  IJC   MMDDYY_X  -> KXJOBLESSCLAIMS-<release date>-<X>              Kalshi is "at least" (>=); a print exactly at X differs
  FF    MMDDYY_X  -> KXFED-<meeting month>-T<X + 0.125>              ForecastEx strikes are range midpoints, Kalshi's are
                                                                     upper bounds; "mid > X" <=> "upper > X + 0.125"
  RGDP  is NOT paired: ForecastEx settles on a later estimate than Kalshi's advance-print market (a basis gap).
Usage: python scripts/backtests/crossvenue_econ.py [--days N]
"""
import glob, json, os, re, sys, datetime as dt
from collections import defaultdict

A = os.path.join(os.environ['APPDATA'], 'oracle-trader')
DAYS = int(sys.argv[sys.argv.index('--days') + 1]) if '--days' in sys.argv else 7
MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']


def data_month(mmddyy):
    """Release date -> the data month it reports (CPI/UNR/payrolls report the previous month)."""
    d = dt.date(2000 + int(mmddyy[4:6]), int(mmddyy[:2]), int(mmddyy[2:4]))
    prev = (d.replace(day=1) - dt.timedelta(days=1))
    return f'{prev.year % 100:02d}{MON[prev.month - 1]}'


def kalshi_ticker(product, mmddyy, strike):
    if product == 'CPIY': return f'KXCPIYOY-{data_month(mmddyy)}-T{strike:g}'
    if product == 'UNR': return f'KXU3-{data_month(mmddyy)}-T{strike:g}'
    if product == 'PREMP': return f'KXPAYROLLS-{data_month(mmddyy)}-T{int(strike)}'
    if product == 'IJC': return f'KXJOBLESSCLAIMS-{mmddyy[4:6]}{MON[int(mmddyy[:2]) - 1]}{mmddyy[2:4]}-{int(strike)}'
    if product == 'FF': return f'KXFED-{mmddyy[4:6]}{MON[int(mmddyy[:2]) - 1]}-T{strike + 0.125:.3f}'.replace('.000', '.00').replace('.500', '.50').replace('.250', '.25').replace('.750', '.75')
    return None


lab = json.load(open(os.path.join(A, 'ibkr-lab.json'), encoding='utf-8'))
con = {}
for m in lab.get('markets', []):
    mm = re.match(r'(FF|CPIY|UNR|PREMP|IJC)_(\d{6})_(-?[\d.]+)$', m['id'])
    if not mm: continue
    kt = kalshi_ticker(mm.group(1), mm.group(2), float(mm.group(3)))
    con[str(m['yes']['conId'])] = ('YES', m['id'], kt); con[str(m['no']['conId'])] = ('NO', m['id'], kt)

since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=DAYS)).isoformat()
fx = defaultdict(list)   # fx market id -> [(at, yes_ask, yes_bid, no_ask)]
tmp = defaultdict(dict)
for f in sorted(glob.glob(os.path.join(A, 'ibkr-quotes', '*.jsonl'))):
    for l in open(f, encoding='utf-8', errors='replace'):
        try: q = json.loads(l)
        except Exception: continue
        c = con.get(str(q.get('conId')))
        if not c or q['at'] < since: continue
        tmp[(c[1], q['at'][:16])][c[0]] = q
for (mid, minute), sides in tmp.items():
    y, n = sides.get('YES'), sides.get('NO')
    if y and n and y.get('ask') is not None and n.get('ask') is not None:
        fx[mid].append((minute, y['ask'], (1 - n['ask']), n['ask'], y.get('askSize'), n.get('askSize')))

kal = defaultdict(list)  # kalshi ticker -> [(ts, bid, ask, bidsz, asksz)]
for f in sorted(glob.glob('data/weather-books/*.jsonl')):
    for l in open(f, encoding='utf-8', errors='replace'):
        try: r = json.loads(l)
        except Exception: continue
        if not r['ticker'].startswith(('KXFED-', 'KXCPIYOY-', 'KXU3-', 'KXPAYROLLS-', 'KXJOBLESSCLAIMS-')) or r['ts'] < since: continue
        bid = r['bids'][0][0] if r['bids'] else None; ask = r['asks'][0][0] if r['asks'] else None
        kal[r['ticker']].append((r['ts'][:16], bid, ask, r['bids'][0][1] if r['bids'] else 0, r['asks'][0][1] if r['asks'] else 0))

pairs = sorted({(mid, kt) for cid, (side, mid, kt) in con.items() if kt and mid in fx and kt in kal})
print(f'ForecastEx contracts quoted: {len(fx)} | Kalshi econ markets captured: {len(kal)} | matched pairs: {len(pairs)}')
print(f'{"ForecastEx":22s} {"Kalshi":30s} {"FX bid/ask":11s} {"K bid/ask":11s} {"gap(mid)":8s} {"basket A":8s} {"basket B":8s} {"depth":>10s}')
rows = []
for mid, kt in pairs:
    minute, ya, yb, na, ysz, nsz = fx[mid][-1]
    # nearest Kalshi capture at or before the ForecastEx quote minute (captures are 30 min apart)
    ks = [k for k in kal[kt] if k[0] <= minute] or kal[kt]
    ts, kb, ka, kbs, kas = ks[-1]
    if kb is None or ka is None: continue
    fxmid, kmid = (ya + yb) / 2, (kb + ka) / 2
    basket_a = ya + (1 - kb)        # FX YES at ask + Kalshi NO at (1 - yes bid)
    basket_b = na + ka              # FX NO at ask + Kalshi YES at ask
    rows.append((mid, kt, ya, yb, kb, ka, kmid - fxmid, basket_a, basket_b, min(ysz or 0, kbs), min(nsz or 0, kas)))
for r in sorted(rows, key=lambda r: min(r[7], r[8])):
    flag = ' <-- <$0.97' if min(r[7], r[8]) < 0.97 else ''
    print(f'{r[0]:22s} {r[1]:30s} {r[3]:.2f}/{r[2]:.2f}   {r[4]:.2f}/{r[5]:.2f}   {r[6]:+.2f}    {r[7]:.2f}     {r[8]:.2f}   {r[9]:5.0f}/{r[10]:<5.0f}{flag}')
print('\nBasket under $1 = a Dutch book only if both settle on the same figure (see mapping notes). RGDP deliberately unpaired.')
