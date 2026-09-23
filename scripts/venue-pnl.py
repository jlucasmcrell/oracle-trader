"""Venue-true P&L from the read-only dumps (no network, no writes).

    python scripts/venue-pnl.py <kalshi_dump.json> [<polyus_dump.json>] [--since 2026-09-06T21:00:00]
                                [--by-arm [--journal <order-journal.jsonl>]]

Kalshi: a settlement record lists every contract ever bought on each side of
the market. Contracts that were closed before settlement (a YES bought back
via NO, or the reverse) do not appear in `revenue`: the exchange paid $1 per
netted pair at the time of netting. So per market:

    net = revenue/100 + min(yes_count, no_count) - yes_cost - no_cost - fees

Reading `revenue - costs` alone (the obvious formula) reported -$31.56 for a
night that was actually +$0.72 (2026-09-07).

Polymarket US: realized deltas of POSITION_RESOLUTION activities (the venue's
own realized figure before and after each resolution).

--by-arm (backlog 102b) splits each venue's figure by the arm that traded it.
Every venue fill is matched by order id to the app's order journal
(%APPDATA%\\oracle-trader\\order-journal.jsonl, read-only) and named by its ref:
auto:<strategy>:... -> auto:<strategy>, mini:<strategy>:... -> mini:<strategy>,
leadlag / quoter / convergence as they are. Kalshi: each fill is marked to its
market's settlement, which sums exactly to the per-market formula above; what
the dump's fills do not explain, and fills with no journal row (the journal
began 2026-09-15), are "unattributed". Polymarket US: a resolution delta goes
to the one arm whose fills built the position, otherwise "unattributed".
"""
import collections
import json
import os
import sys

UNATTRIBUTED = 'unattributed'


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


def kalshi_fill_pnl(x, result):
    """One fill marked to its market's settlement. Kalshi's single book reports a NO purchase as a YES-book sale with
    outcome_side 'no', so the side held is outcome_side; over a market these sum to kalshi_pnl() exactly."""
    side = x.get('outcome_side') or x.get('side') or ''
    px = x.get(side + '_price_dollars')
    px = f(px) if px not in (None, '') else f(x.get(side + '_price')) / 100.0
    return f(x.get('count_fp') or x.get('count')) * ((1.0 if result == side else 0.0) - px) - f(x.get('fee_cost'))


def kalshi_by_arm(d, since, arms):
    fills = collections.defaultdict(list)
    for x in d.get('fills', []):
        fills[x.get('ticker') or x.get('market_ticker')].append(x)
    by = collections.defaultdict(lambda: [0, 0.0])
    for s in d.get('settlements', []):
        if (s.get('settled_time') or '') < since:
            continue
        rest = kalshi_pnl(s)
        took = set()
        if s.get('market_result') in ('yes', 'no'):
            for x in fills.get(s['ticker'], []):
                arm = arms.get(('kalshi', x.get('order_id')), UNATTRIBUTED)
                pnl = kalshi_fill_pnl(x, s['market_result'])
                by[arm][1] += pnl
                rest -= pnl
                took.add(arm)
        # Fills missing from the dump (older than its history) or a result that is not yes/no.
        if abs(rest) >= 0.005:
            by[UNATTRIBUTED][1] += rest
            took.add(UNATTRIBUTED)
        for arm in took:
            by[arm][0] += 1
    print_arms('each fill marked to its settlement', by)


def resolution_delta(p):
    return f((p.get('afterPosition') or {}).get('realized', {}).get('value')) - f((p.get('beforePosition') or {}).get('realized', {}).get('value'))


def polyus_report(path, since):
    d = json.load(open(path, encoding='utf-8'))
    acts = (d.get('activities_all') or {}).get('activities', [])
    tot = 0.0
    n = 0
    for a in acts:
        p = a.get('positionResolution')
        if not p or (p.get('updateTime') or '') < since:
            continue
        tot += resolution_delta(p)
        n += 1
    bal = ((d.get('balances') or {}).get('balances') or [{}])[0]
    print('Polymarket US since %s: %d resolutions, resolution-only P&L $%.2f; balance $%.2f (buying power $%.2f)' % (
        since, n, tot, f(bal.get('currentBalance')), f(bal.get('buyingPower'))))
    print('  Resolution deltas exclude sale P&L and do not reconcile total account profit after fees.')
    return tot


def polyus_by_arm(d, since, arms):
    acts = (d.get('activities_all') or {}).get('activities', [])
    owners = collections.defaultdict(set)
    for a in acts:
        t = a.get('trade')
        if not t:
            continue
        # isAggressor says which execution is ours; the other one is the counterparty's order.
        ours = t.get('aggressorExecution') if t.get('isAggressor') else t.get('passiveExecution')
        owners[t.get('marketSlug')].add(arms.get(('polymarket-us', ((ours or {}).get('order') or {}).get('id')), UNATTRIBUTED))
    by = collections.defaultdict(lambda: [0, 0.0])
    for a in acts:
        p = a.get('positionResolution')
        if not p or (p.get('updateTime') or '') < since:
            continue
        arm = next(iter(owners[p.get('marketSlug')])) if len(owners[p.get('marketSlug')]) == 1 else UNATTRIBUTED
        by[arm][0] += 1
        by[arm][1] += resolution_delta(p)
    print_arms('resolution deltas, credited when one arm built the position', by)


def arm_of(ref):
    if not ref:
        return UNATTRIBUTED
    parts = ref.split(':')
    return ':'.join(parts[:2]) if parts[0] in ('auto', 'mini') and len(parts) > 1 else parts[0]


def journal_arms(path):
    """{(venue, venue order id): arm}. A missing journal raises: an attribution must never read as all-unattributed."""
    arms = {}
    with open(path, encoding='utf-8') as stream:
        for line in stream:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get('orderId'):
                arms[(r.get('venue'), r['orderId'])] = arm_of(r.get('ref'))
    return arms


def print_arms(how, by):
    print('  by arm (order-journal refs; %s):%s' % (how, '' if by else ' none'))
    for k, v in sorted(by.items(), key=lambda kv: kv[1][1]):
        print('    %-24s n=%-3d $%.2f' % (k, v[0], v[1]))


def main(argv):
    since = '1970-01-01T00:00:00'
    files = []
    arms = None
    journal = os.path.join(os.environ.get('APPDATA', ''), 'oracle-trader', 'order-journal.jsonl')
    i = 0
    while i < len(argv):
        if argv[i] == '--since':
            since = argv[i + 1]
            i += 2
        elif argv[i] == '--by-arm':
            arms = {}
            i += 1
        elif argv[i] == '--journal':
            journal = argv[i + 1]
            i += 2
        else:
            files.append(argv[i])
            i += 1
    if arms is not None:
        arms = journal_arms(journal)
    for p in files:
        # Dump names are arbitrary (daily exports use p-YYYY-MM-DD.json).
        # Choose the venue from its response shape, never the filename.
        with open(p, encoding='utf-8') as stream:
            data = json.load(stream)
        if data.get('error'):
            raise ValueError('Account export failed: ' + p)
        if 'activities_all' in data and 'balances' in data:
            polyus_report(p, since)
            if arms is not None:
                polyus_by_arm(data, since, arms)
        elif 'settlements' in data and 'balance' in data:
            kalshi_report(p, since)
            if arms is not None:
                kalshi_by_arm(data, since, arms)
        else:
            raise ValueError('Unrecognized account export: ' + p)


if __name__ == '__main__':
    main(sys.argv[1:])
