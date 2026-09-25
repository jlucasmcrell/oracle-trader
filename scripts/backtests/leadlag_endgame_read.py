"""Backlog 147b, the lead-lag ENDGAME exception. Read-only; grades recorded shadow rows, places nothing.

The registered read (docs/reads.json, id 147b): "grade leadlag-cadence-shadow.jsonl rows with a gap under 6c and
under 3 minutes left"; positive at 95% over >= 100 contracts-equivalent registers an exception to the 6c floor,
otherwise the floor stays alone.

Two sources, because the registered one alone cannot answer it:
  * `leadlag-cadence-shadow.jsonl` is written ONLY inside the dislocation branch and only when the gap clears the
    fee (leadLag.ts:966,1002), so it can hold a sub-6c gap only from before 2026-09-18, when the floor was 4c.
    That is the registered source and is reported first, unchanged.
  * `leadlag-quotes-shadow.jsonl` is written once per OBSERVED pair per scan (leadLag.ts:929), so it carries every
    gap including the ones the floor refused. It is the only source that can see the exception in the orderbook
    era, and it is reported second as corroboration, never in place of the registered read.

One observation per (ticker, side, UTC minute), the cadence the engine actually traded at; each graded observation
is one contract-equivalent. P&L is the Kalshi taker price plus the one-contract fee, held to the venue's result.
"""
import json, math, os, sys
from collections import defaultdict
from bands import cluster_se

# Student t, upper 0.975 quantile (two-sided 95%), by degrees of freedom. bands.cluster_band draws the house's
# 80% screening band; 147b is written at 95%, the same table leadlag_gap_floor_read.py uses.
_T975 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
         12: 2.179, 15: 2.131, 20: 2.086, 30: 2.042, 60: 2.000}


def t975(df):
    if df < 1:
        return float('inf')
    for k in sorted(_T975):
        if df <= k:
            return _T975[k]
    return 1.960

A = os.path.join(os.environ.get('APPDATA', ''), 'oracle-trader')
CADENCE = os.path.join(A, 'leadlag-cadence-shadow.jsonl')
QUOTES = os.path.join(A, 'leadlag-quotes-shadow.jsonl')
FLOOR_C = 6.0
ENDGAME_S = 180.0
MIN_N = 100


def rows(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def iso_s(ts):
    from datetime import datetime
    return datetime.fromisoformat(str(ts).replace('Z', '+00:00')).timestamp()


def window_end_s(t):
    """The 15-minute window a row was recorded in ends at the next quarter-hour (leadLag.ts:808)."""
    return (math.floor(t / 900.0) + 1) * 900.0


def kalshi_fee_c(p):
    return math.ceil(7 * p * (1 - p) - 1e-9)


def grade(results, ticker, yes, price, fee_c):
    r = results.get(ticker)
    if r not in ('yes', 'no'):
        return None
    cost = price if yes else 1 - price
    return (1.0 if r == ('yes' if yes else 'no') else 0.0) - cost - fee_c / 100.0


def report(name, graded):
    """graded: list of (utc_day, pnl_dollars). Day-clustered 95% band, in cents per contract."""
    if not graded:
        print(f'  {name}: no graded observations')
        return None
    n = len(graded)
    mean = sum(p for _, p in graded) / n
    by_day = defaultdict(float)
    for day, p in graded:
        by_day[day] += p - mean
    se = cluster_se(list(by_day.values()), n)
    if se is None:
        print(f'  {name}: n={n} over {len(by_day)} day-cluster, {mean * 100:+.2f}c/contract, no band below two clusters')
        return n, mean, None, None
    k = t975(len(by_day) - 1)
    lo, hi = mean - k * se, mean + k * se
    print(f'  {name}: n={n} contracts-equivalent over {len(by_day)} day-clusters, '
          f'{mean * 100:+.2f}c/contract, 95% [{lo * 100:+.2f}, {hi * 100:+.2f}]')
    return n, mean, lo, hi


def main(argv):
    dump = argv[0] if argv else None
    if not dump:
        print('usage: leadlag_endgame_read.py <kalshi dump.json>')
        return 2
    d = json.load(open(dump, encoding='utf-8'))
    results = {s['ticker']: s.get('market_result') for s in d.get('settlements', [])}
    print(f'Kalshi dump {os.path.basename(dump)}: {len(results)} settled tickers')

    # ---- the registered source ----
    seen = set()
    buckets = defaultdict(list)
    kept = 0
    for r in rows(CADENCE):
        try:
            t = iso_s(r['ts'])
            ticker = r['kalshiTicker']
            yes = str(r['suggestedAction']).endswith('_YES')
            fee = float(r.get('feeCents') or 0)
            gap = float(r['netCents']) + fee
        except (KeyError, TypeError, ValueError):
            continue
        if gap >= FLOOR_C:
            continue
        key = (ticker, yes, int(t // 60))
        if key in seen:
            continue
        seen.add(key)
        g = grade(results, ticker, yes, float(r['kalshiPrice']), fee)
        if g is None:
            continue
        kept += 1
        left = window_end_s(t) - t
        buckets['endgame (< 3 min left)' if left < ENDGAME_S else 'rest (>= 3 min left)'].append(
            (r['ts'][:10], g))
    print(f'\nREGISTERED SOURCE leadlag-cadence-shadow.jsonl - sub-{FLOOR_C:.0f}c gaps, {kept} graded '
          f'(only the pre-2026-09-18 4c-floor era can contain them)')
    endgame = report('endgame (< 3 min left)', buckets['endgame (< 3 min left)'])
    report('rest (>= 3 min left)', buckets['rest (>= 3 min left)'])

    # ---- corroboration: every observed pair, including gaps the floor refused ----
    seen2 = set()
    b2 = defaultdict(list)
    for r in rows(QUOTES):
        try:
            t = iso_s(r['ts'])
            ticker = r['t']
            pm, bb, ba = float(r['pm']), float(r['bb']), float(r['ba'])
            end_s = float(r['end']) / 1000.0
        except (KeyError, TypeError, ValueError):
            continue
        for yes, gap_c, price in ((True, (pm - ba) * 100, ba), (False, (bb - pm) * 100, 1 - bb)):
            if gap_c <= 0 or gap_c >= FLOOR_C:
                continue
            key = (ticker, yes, int(t // 60))
            if key in seen2:
                continue
            seen2.add(key)
            fee = kalshi_fee_c(price)
            if gap_c - fee <= 0:
                continue
            g = grade(results, ticker, yes, price, fee)
            if g is None:
                continue
            left = end_s - t
            b2['endgame (< 3 min left)' if left < ENDGAME_S else 'rest (>= 3 min left)'].append(
                (r['ts'][:10], g))
    print(f'\nCORROBORATION leadlag-quotes-shadow.jsonl - every observed sub-{FLOOR_C:.0f}c gap that clears its fee')
    endgame2 = report('endgame (< 3 min left)', b2['endgame (< 3 min left)'])
    report('rest (>= 3 min left)', b2['rest (>= 3 min left)'])

    print('\nRULE (backlog 147b): the exception is registered only if the endgame bucket is positive at 95% over '
          f'>= {MIN_N} contracts-equivalent.')
    best = endgame or endgame2
    if not best or best[0] < MIN_N:
        have = best[0] if best else 0
        print(f'RESULT: NOT YET - {have} contracts-equivalent in the endgame bucket, under the {MIN_N} bar. '
              'The 6c floor stays alone.')
    elif best[2] is not None and best[2] > 0:
        print('RESULT: PASS - register the endgame exception (registration only; no config is changed here).')
    else:
        print('RESULT: FAIL - the endgame bucket is not positive at 95%. The 6c floor stays alone.')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
