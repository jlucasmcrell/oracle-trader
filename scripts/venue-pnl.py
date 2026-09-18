"""Venue-true P&L from the read-only dumps (no network, no writes).

    python scripts/venue-pnl.py <kalshi_dump.json> [<polyus_dump.json>] [--since 2026-09-06T21:00:00]

Kalshi: a settlement record lists every contract ever bought on each side of
the market. Contracts that were closed before settlement (a YES bought back
via NO, or the reverse) do not appear in `revenue`: the exchange paid $1 per
netted pair at the time of netting. So per market:

    net = revenue/100 + min(yes_count, no_count) - yes_cost - no_cost - fees

Reading `revenue - costs` alone (the obvious formula) reported -$31.56 for a
night that was actually +$0.72 (2026-09-07).

Polymarket US: realized deltas of POSITION_RESOLUTION activities (the venue's
own realized figure before and after each resolution).
"""
import collections
import json
import sys


def f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def kalshi_pnl(s):
    y = f(s.get('yes_count_fp') or s.get('yes_count'))
    n = f(s.get('no_count_fp') or s.get('no_count'))
    return f(s.get('revenue')) / 100.0 + min(y, n) - f(s.get('yes_total_cost_dollars')) - f(s.get('no_total_cost_dollars')) - f(s.get('fee_cost'))


def kalshi_report(path, since):
    d = json.load(open(path, encoding='utf-8'))
    sel = [s for s in d.get('settlements', []) if (s.get('settled_time') or '') >= since]
    tot = sum(kalshi_pnl(s) for s in sel)
    fees = sum(f(s.get('fee_cost')) for s in sel)
    print('Kalshi since %s: %d settlements, net $%.2f after $%.2f fees' % (since, len(sel), tot, fees))
    by = collections.defaultdict(lambda: [0, 0.0])
    for s in sel:
        k = s['ticker'].split('-')[0]
        by[k][0] += 1
        by[k][1] += kalshi_pnl(s)
    for k, v in sorted(by.items(), key=lambda kv: kv[1][1]):
        print('  %-16s n=%-3d $%.2f' % (k, v[0], v[1]))
    bal = d.get('balance') or {}
    if bal:
        exposure = sum(f(p.get('market_exposure_dollars')) for p in d.get('positions', []))
        print('  cash $%.2f + open positions at cost $%.2f = $%.2f (at market $%.2f)' % (
            f(bal.get('balance_dollars')), exposure, f(bal.get('balance_dollars')) + exposure, f(bal.get('balance_dollars')) + f(bal.get('portfolio_value')) / 100.0))
    return tot


def polyus_report(path, since):
    d = json.load(open(path, encoding='utf-8'))
    acts = (d.get('activities_all') or {}).get('activities', [])
    tot = 0.0
    n = 0
    for a in acts:
        p = a.get('positionResolution')
        if not p or (p.get('updateTime') or '') < since:
            continue
        tot += f((p.get('afterPosition') or {}).get('realized', {}).get('value')) - f((p.get('beforePosition') or {}).get('realized', {}).get('value'))
        n += 1
    bal = ((d.get('balances') or {}).get('balances') or [{}])[0]
    print('Polymarket US since %s: %d resolutions, resolution-only P&L $%.2f; balance $%.2f (buying power $%.2f)' % (
        since, n, tot, f(bal.get('currentBalance')), f(bal.get('buyingPower'))))
    print('  Resolution deltas exclude sale P&L and do not reconcile total account profit after fees.')
    return tot


def main(argv):
    since = '1970-01-01T00:00:00'
    files = []
    i = 0
    while i < len(argv):
        if argv[i] == '--since':
            since = argv[i + 1]
            i += 2
        else:
            files.append(argv[i])
            i += 1
    for p in files:
        # Dump names are arbitrary (daily exports use p-YYYY-MM-DD.json).
        # Choose the venue from its response shape, never the filename.
        with open(p, encoding='utf-8') as stream:
            data = json.load(stream)
        if data.get('error'):
            raise ValueError('Account export failed: ' + p)
        if 'activities_all' in data and 'balances' in data:
            polyus_report(p, since)
        elif 'settlements' in data and 'balance' in data:
            kalshi_report(p, since)
        else:
            raise ValueError('Unrecognized account export: ' + p)


if __name__ == '__main__':
    main(sys.argv[1:])
