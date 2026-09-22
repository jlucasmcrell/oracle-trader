"""Does the sports anchor's signal survive costs, and where? From %APPDATA%/oracle-trader/anchor-grades.jsonl.

    python scripts/backtests/anchor_pregame.py [--half-spread-pre 1] [--half-spread-live 2]

Each grade row is one anchor observation: the Kalshi mid at the time, the sharp-book fair probability, the side the
rule would buy (`ruleSide`) and its P&L at the MID held to settlement (`rulePnl`). The ask is not recorded, so the
cost of crossing is charged as an assumed half-spread (1c before the game, 2c in play - Kalshi sports tops are
typically 1-2c wide before the game and wider in play) plus Kalshi's taker fee 0.07 P(1-P). One row per market (the
first observation), so a market seen many times counts once. Bands are clustered by event, because every market of
one game settles on the same scoreline. Read-only.
"""
import argparse, collections, json, math, os

ap = argparse.ArgumentParser()
ap.add_argument('--half-spread-pre', type=float, default=1.0)
ap.add_argument('--half-spread-live', type=float, default=2.0)
ap.add_argument('--min-gap', type=float, default=0.0, help='only rows whose |gap| is at least this, cents')
a = ap.parse_args()
A = os.path.join(os.environ.get('APPDATA', ''), 'oracle-trader')

first = {}
for line in open(os.path.join(A, 'anchor-grades.jsonl'), encoding='utf-8', errors='replace'):
    try:
        r = json.loads(line)
    except Exception:
        continue
    if r.get('rulePnl') is None or r.get('ruleSide') not in ('YES', 'NO'):
        continue
    k = r['kalshiId']
    if k not in first or r['ts'] < first[k]['ts']:
        first[k] = r

rows = []
for r in first.values():
    if abs(r.get('gapCents') or 0) < a.min_gap:
        continue
    live = r['ts'] >= r['eventStartsAt']
    px = r['kalshiMid'] if r['ruleSide'] == 'YES' else 1 - r['kalshiMid']
    cost = (a.half_spread_live if live else a.half_spread_pre) + 100 * 0.07 * px * (1 - px)
    won = r['yesWon'] == (r['ruleSide'] == 'YES')
    rows.append({'ev': r['eventId'], 'live': live, 'mkt': r.get('market'), 'sport': r.get('sportKey', '?'),
                 'mid_pnl': 100 * r['rulePnl'], 'net': 100 * r['rulePnl'] - cost, 'won': won, 'px': px,
                 'fair': r['fairProb'] if r['ruleSide'] == 'YES' else 1 - r['fairProb'], 'gap': abs(r.get('gapCents') or 0)})


def band(xs, key='net'):
    if len(xs) < 2:
        return '-'
    ev = collections.defaultdict(list)
    for x in xs:
        ev[x['ev']].append(x[key])
    n = len(xs)
    m = sum(x[key] for x in xs) / n
    g = len(ev)
    se = math.sqrt(g / max(1, g - 1) * sum((sum(v) - len(v) * m) ** 2 for v in ev.values())) / n
    return '%+6.2fc [%+.2f, %+.2f] n=%4d events=%3d' % (m, m - 1.96 * se, m + 1.96 * se, n, g)


def line(label, xs):
    if not xs:
        return
    w = sum(x['won'] for x in xs)
    print('   %-26s at mid %s | after costs %s | won %d, Kalshi implied %.0f, anchor implied %.0f'
          % (label, band(xs, 'mid_pnl'), band(xs, 'net'), w, sum(x['px'] for x in xs), sum(x['fair'] for x in xs)))


print('markets graded (first observation each): %d' % len(rows))
print('\nPRE-GAME vs IN-PLAY (cents per contract; 95% band clustered by game)')
line('pre-game', [x for x in rows if not x['live']])
line('in-play', [x for x in rows if x['live']])
print('\nPRE-GAME BY MARKET TYPE')
for m in sorted({x['mkt'] for x in rows}):
    line(str(m), [x for x in rows if not x['live'] and x['mkt'] == m])
print('\nPRE-GAME BY SPORT')
for s in sorted({x['sport'] for x in rows}):
    xs = [x for x in rows if not x['live'] and x['sport'] == s]
    if len(xs) >= 15:
        line(s, xs)
print('\nPRE-GAME BY GAP SIZE')
for lo, hi in ((0, 3), (3, 5), (5, 8), (8, 100)):
    line('gap %d-%dc' % (lo, hi), [x for x in rows if not x['live'] and lo <= x['gap'] < hi])
