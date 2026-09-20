"""Read-only: is fade's crypto exposure correlated enough to need a cap of its own? (REVIEW-CHANGES section 140)

`underlyingOf` returns crypto:BTC, crypto:ETH ... per COIN, so four coins settling in one window pass every cap
(maxPerUnderlying 8, and the per-event cap is keyed on eventTicker). On 2026-09-18 four such positions lost
together and produced the whole of fade's -5.21c calibration reading. This measures what a window-wide cap would
have been worth.

Rebuilt from the authoritative fill archive plus public settlement results.

The episode archive misses maker fills (fade's normal entry), so the earlier pass under-counted fade. This one
starts from every archived Kalshi fill, keeps the fade-shaped crypto ones (NO exposure at 85-99c on a non-15m
crypto series), and asks the PUBLIC Kalshi markets endpoint how each resolved. Unauthenticated GETs only.

Direction note: rows written before 2026-09-20 carry the B-23 mapping, where book_side 'ask' was labelled
'sell'. Under the corrected reading every one of these is a BUY of the NO side, which is what fade does.
"""
import json, os, sys, time, urllib.request, collections

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backtests'))
from degraded import banner, label  # noqa: E402  (docs/DEGRADED-WINDOWS.md)

A = os.path.join(os.environ['APPDATA'], 'oracle-trader')
COINS = ('BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'ZEC', 'LTC', 'ADA', 'AVAX', 'LINK')
API = 'https://api.elections.kalshi.com/trade-api/v2'


def coin_of(mid):
    s = mid.upper().split('-')[0]
    if not s.startswith('KX'):
        return None
    b = s[2:]
    if '15M' in b:
        return None  # lead-lag's series, not fade's
    for c in sorted(COINS, key=len, reverse=True):
        if b.startswith(c):
            return c
    return None


pos = {}
for line in open(os.path.join(A, 'fill-reconciler-kalshi.json.fills.jsonl'), encoding='utf-8', errors='replace'):
    try:
        r = json.loads(line)
    except Exception:
        continue
    c = coin_of(r['marketId'])
    if not c or r['outcome'] != 'NO' or not (0.85 <= r['price'] <= 0.995):
        continue
    p = pos.setdefault(r['marketId'], {'coin': c, 'shares': 0.0, 'cost': 0.0, 'fee': 0.0, 'first': r['timestamp'], 'last': r['timestamp']})
    p['shares'] += r['shares']
    p['cost'] += r['shares'] * r['price']
    p['fee'] += r.get('fee') or 0.0
    p['first'] = min(p['first'], r['timestamp'])
    p['last'] = max(p['last'], r['timestamp'])

ids = sorted(pos)
print('fade-shaped crypto positions: %d markets, %.1f contracts' % (len(ids), sum(p['shares'] for p in pos.values())))

res = {}
for i in range(0, len(ids), 40):
    chunk = ids[i:i + 40]
    url = API + '/markets?limit=200&tickers=' + ','.join(chunk)
    try:
        with urllib.request.urlopen(url, timeout=20) as fh:
            for m in (json.load(fh).get('markets') or []):
                res[m.get('ticker')] = (m.get('result') or '').lower()
    except Exception as e:
        print('  fetch failed for a chunk:', e)
    time.sleep(0.4)
print('settled results fetched:', sum(1 for t in ids if res.get(t) in ('yes', 'no')), 'of', len(ids))

trades = []
for t in ids:
    r = res.get(t)
    if r not in ('yes', 'no'):
        continue
    p = pos[t]
    won = (r == 'no')  # we hold NO
    entry = p['cost'] / p['shares']
    pnl = (p['shares'] * (1.0 if won else 0.0)) - p['cost'] - p['fee']
    trades.append({'mid': t, 'coin': p['coin'], 'at': p['first'], 'shares': p['shares'], 'entry': entry, 'pnl': pnl, 'won': won,
                   'exp': t.upper().split('-')[1] if len(t.split('-')) > 1 else ''})
trades.sort(key=lambda x: x['at'])
for t in trades:
    t['era'] = label(t['at'])
tot = sum(t['pnl'] for t in trades)
print('\n' + banner())
print('settled fade-shaped crypto: %d positions, %d losses, net $%+.2f' % (len(trades), sum(1 for t in trades if not t['won']), tot))
print('mean %+.2fc/contract over %.1f contracts' % (100 * tot / sum(t['shares'] for t in trades), sum(t['shares'] for t in trades)))
for era in sorted({t['era'] for t in trades}):
    v = [t for t in trades if t['era'] == era]
    ct = sum(t['shares'] for t in v)
    print('  %-12s n=%3d  %6.1f ct  $%+6.2f  %+5.2fc/ct' % (era, len(v), ct, sum(t['pnl'] for t in v), 100 * sum(t['pnl'] for t in v) / ct))

print('\nlosses:')
for t in [x for x in trades if not x['won']]:
    print('  %s  %-34s %-5s %.2f ct @ %.2f  $%+.2f' % (time.strftime('%m-%d %H:%MZ', time.gmtime(t['at'] / 1000)), t['mid'][:34], t['coin'], t['shares'], t['entry'], t['pnl']))

print('\nsame-expiry clusters (>=2 coins held into one settlement window):')
by = collections.defaultdict(list)
for t in trades:
    by[t['exp']].append(t)
for k, v in sorted(by.items(), key=lambda x: sum(t['pnl'] for t in x[1]))[:8]:
    if len(v) < 2:
        continue
    print('  %-12s %d positions / %d coins   $%+6.2f   %s' % (k, len(v), len({t['coin'] for t in v}), sum(t['pnl'] for t in v), ','.join(sorted({t['coin'] for t in v}))))


def simulate(cap):
    """Refuse an entry when `cap` positions are already open into the SAME settlement window."""
    kept, refused, open_by = [], [], collections.defaultdict(list)
    for t in trades:
        if len(open_by[t['exp']]) >= cap:
            refused.append(t)
        else:
            open_by[t['exp']].append(t)
            kept.append(t)
    return kept, refused


print('\ncap on positions open into one settlement window (any coin counts):')
print('  cap  refused  P&L forgone   net kept    vs actual')
for cap in (1, 2, 3, 4, 5):
    kept, ref = simulate(cap)
    k = sum(t['pnl'] for t in kept)
    print('   %d    %4d     $%+6.2f      $%+6.2f    $%+6.2f' % (cap, len(ref), sum(t['pnl'] for t in ref), k, k - tot))
