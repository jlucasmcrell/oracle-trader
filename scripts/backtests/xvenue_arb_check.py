"""Are the Kalshi vs Polymarket US sports-moneyline arbitrages real? Diagnostics on data/sports-books (both books in the
same 60 s cycle, Kalshi from the orderbook endpoint, never the cached list).

    python scripts/backtests/xvenue_arb_check.py [--max-edge 20]

A locked arbitrage on team X: buy Kalshi YES(X) at its ask and Polymarket NO(X) (= 1 - Polymarket YES(X) bid), or the
mirror. Profit per pair = 1 - both asks - both taker fees (Kalshi 0.07 P(1-P); Polymarket US 0.0695 P(1-P), both per
contract, unrounded). The questions that separate a real edge from a frozen quote:
  - how far apart the two books were fetched,
  - how many consecutive cycles an opportunity lasted (an episode),
  - pre-game or in-game,
  - how it ended: which venue's top-of-book moved,
  - whether the Polymarket top changes at all during episodes, compared with how often it changes in general.
Read-only, no network.
"""
import argparse, collections, glob, json, os, statistics as st
from datetime import datetime

ap = argparse.ArgumentParser()
ap.add_argument('--dir', default='G:/PROJECTS/oracle-trader/data/sports-books')
ap.add_argument('--max-edge', type=float, default=20.0, help='cents; larger gaps are reported separately as suspect')
a = ap.parse_args()


def ms(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000


def top(book):
    return book[0] if book else None


series = collections.defaultdict(list)
for f in sorted(glob.glob(os.path.join(a.dir, '2026-*.jsonl'))):
    for line in open(f, encoding='utf-8', errors='replace'):
        try:
            r = json.loads(line)
        except Exception:
            continue
        k, p = r.get('k') or {}, r.get('pm') or {}
        kb, ka, pb, pa = top(k.get('bids')), top(k.get('asks')), top(p.get('bids')), top(p.get('asks'))
        if not (kb and ka and pb and pa):
            continue
        if r.get('kalshiTeamIsLong'):
            py_bid, py_ask, py_bid_sz, py_ask_sz = pb[0], pa[0], pb[1], pa[1]
        else:
            py_bid, py_ask, py_bid_sz, py_ask_sz = 1 - pa[0], 1 - pb[0], pa[1], pb[1]
        t = ms(r['ts'])
        series[r['ticker']].append({
            't': t, 'gap_ms': abs(ms(k['at']) - ms(p['at'])) if k.get('at') and p.get('at') else None,
            'ingame': t >= ms(r['gameStart']) if r.get('gameStart') else None,
            'ky_bid': kb[0], 'ky_ask': ka[0], 'py_bid': py_bid, 'py_ask': py_ask,
            'depth_A': min(ka[1], py_bid_sz), 'depth_B': min(kb[1], py_ask_sz)})


def fee(p, c):
    return c * p * (1 - p)


def edges(x):
    # A: Kalshi YES + Polymarket NO ;  B: Kalshi NO + Polymarket YES
    A = x['py_bid'] - x['ky_ask'] - fee(x['ky_ask'], 0.07) - fee(1 - x['py_bid'], 0.0695)
    B = x['ky_bid'] - x['py_ask'] - fee(1 - x['ky_bid'], 0.07) - fee(x['py_ask'], 0.0695)
    return 100 * A, 100 * B


episodes, pm_changes_all, pm_changes_ep = [], [0, 0], [0, 0]
for tk, rows in series.items():
    rows.sort(key=lambda x: x['t'])
    cur = None
    for i, x in enumerate(rows):
        eA, eB = edges(x)
        side, e = ('A', eA) if eA >= eB else ('B', eB)
        prev = rows[i - 1] if i else None
        if prev and x['t'] - prev['t'] < 130_000:
            changed = (x['py_bid'], x['py_ask']) != (prev['py_bid'], prev['py_ask'])
            pm_changes_all[0] += changed; pm_changes_all[1] += 1
            if cur is not None:
                pm_changes_ep[0] += changed; pm_changes_ep[1] += 1
        contiguous = prev is not None and x['t'] - prev['t'] < 130_000
        if e > 0 and cur is not None and cur['side'] == side and contiguous:
            cur['rows'].append((x, e))
            continue
        if cur is not None:
            end = x if contiguous else None
            last = cur['rows'][-1][0]
            if end is not None:
                cur['ended_by'] = ('both' if (end['ky_bid'], end['ky_ask']) != (last['ky_bid'], last['ky_ask']) and (end['py_bid'], end['py_ask']) != (last['py_bid'], last['py_ask'])
                                   else 'kalshi moved' if (end['ky_bid'], end['ky_ask']) != (last['ky_bid'], last['ky_ask'])
                                   else 'polymarket moved' if (end['py_bid'], end['py_ask']) != (last['py_bid'], last['py_ask']) else 'neither (edge fell below fees)')
            else:
                cur['ended_by'] = 'recording gap'
            episodes.append(cur)
            cur = None
        if e > 0:
            cur = {'ticker': tk, 'side': side, 'rows': [(x, e)]}
    if cur is not None:
        cur['ended_by'] = 'end of data'
        episodes.append(cur)

ok = [ep for ep in episodes if ep['rows'][0][1] <= a.max_edge]
sus = [ep for ep in episodes if ep['rows'][0][1] > a.max_edge]
print('tickers %d, cycles %d, episodes with a positive edge after both fees: %d (%d start above %.0fc, reported apart)'
      % (len(series), sum(len(v) for v in series.values()), len(episodes), len(sus), a.max_edge))


def describe(eps, label):
    if not eps:
        print('\n%s: none' % label)
        return
    first = [ep['rows'][0][1] for ep in eps]
    dur = [len(ep['rows']) for ep in eps]
    gaps = [ep['rows'][0][0]['gap_ms'] for ep in eps if ep['rows'][0][0]['gap_ms'] is not None]
    depth = [ep['rows'][0][0]['depth_A' if ep['side'] == 'A' else 'depth_B'] for ep in eps]
    ing = sum(1 for ep in eps if ep['rows'][0][0]['ingame'])
    ended = collections.Counter(ep['ended_by'] for ep in eps)
    days = collections.Counter(datetime.utcfromtimestamp(ep['rows'][0][0]['t'] / 1000).strftime('%m-%d') for ep in eps)
    print('\n%s: %d episodes' % (label, len(eps)))
    print('   edge at first sight: median %.1fc, p90 %.1fc  |  $ at 1 contract, first sight only: $%.2f over %d days'
          % (st.median(first), sorted(first)[int(0.9 * len(first))], sum(first) / 100, len(days)))
    print('   lasted (60 s cycles): 1 cycle %d%%, 2-4 %d%%, 5+ %d%%, median %d' % (
        100 * sum(1 for d in dur if d == 1) // len(dur), 100 * sum(1 for d in dur if 2 <= d <= 4) // len(dur),
        100 * sum(1 for d in dur if d >= 5) // len(dur), st.median(dur)))
    print('   fetch gap between the two books: median %d ms, p90 %d ms' % (st.median(gaps), sorted(gaps)[int(0.9 * len(gaps))]))
    print('   depth at both tops (contracts, the smaller side): median %s' % '{:,.0f}'.format(st.median(depth)))
    print('   in-game at first sight: %d of %d (%.0f%%)' % (ing, len(eps), 100 * ing / len(eps)))
    print('   how it ended: ' + ', '.join('%s %d' % kv for kv in ended.most_common()))


describe(ok, 'EPISODES STARTING AT <= %.0fc' % a.max_edge)
describe(sus, 'SUSPECT EPISODES STARTING ABOVE %.0fc' % a.max_edge)
print('\nPolymarket US top-of-book changed between consecutive cycles: %.0f%% of all cycles, %.0f%% of cycles inside an episode'
      % (100 * pm_changes_all[0] / max(1, pm_changes_all[1]), 100 * pm_changes_ep[0] / max(1, pm_changes_ep[1])))
