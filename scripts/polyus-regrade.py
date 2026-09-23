"""Backlog 237: re-grade the Polymarket US history from the venue record, so no arm is judged on a close
that was booked at a provisional price.

    python scripts/polyus-regrade.py <polyus_dump.json> [--write]
    python scripts/polyus-regrade.py selftest

Why (REVIEW-CHANGES section 160): until 2026-09-22 `fetchSettlementPrice` took the book's `settlementPx` as soon
as the book said EXPIRED, and for a few minutes the venue shows the previous close there before it writes the real
0/1. 47 of 177 live closes and 4 of 40 paper-lab settlements were booked that way. The venue's own resolution
records are the ledger of record; the app's `pnl` is secondary.

Read-only: it opens the read-only dump and the two ledgers, places nothing, and never writes to either ledger.
With `--write` it emits `data/polyus-regrade/regraded.json` - the corrections and the per-arm totals - which is the
file the reports read. The live ledgers keep their own numbers; a correction belongs next to them, not inside them.

Three outcomes per matched close, and the third one is the point:

  agrees       the app's pnl and the venue's resolution delta are within half a cent.
  regraded     they differ, the position was held to the resolution, and the venue's realized figure moved:
               the venue's number replaces the app's.
  unjudgeable  the venue's resolution record cannot price the row, so nothing is claimed about it. A resolution
               delta EXCLUDES sale P&L, so a position that was partly or wholly sold before it resolved is not
               comparable (on this venue an exit shows up as a MATCHED pair, not as a sale - buying NO is
               recorded as selling YES); and the venue leaves `realized` unchanged on some resolved rows that cost
               real money,
               which is a hole in the record, not a zero. Two arms closing the same market is the same problem.

An unjudgeable row is not a corrected row and not a confirmed one. It is named and excluded, which is the only
honest treatment of a number the record of account does not carry.
"""
import collections
import json
import os
import sys

EPS = 0.005


def f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def resolution_delta(p):
    """The venue's own realized figure before and after the resolution (same formula as scripts/venue-pnl.py)."""
    return f((p.get('afterPosition') or {}).get('realized', {}).get('value')) - f((p.get('beforePosition') or {}).get('realized', {}).get('value'))


def venue_resolutions(dump):
    """{slug: {'delta', 'rows', 'held', 'paired', 'cost', 'moved'}} from the read-only dump's activity feed."""
    out = {}
    for a in (dump.get('activities_all') or {}).get('activities', []):
        p = a.get('positionResolution')
        if not p:
            continue
        b = p.get('beforePosition') or {}
        r = out.setdefault(p['marketSlug'], {'delta': 0.0, 'rows': 0, 'held': 0.0, 'paired': 0.0, 'cost': 0.0, 'moved': False})
        d = resolution_delta(p)
        r['delta'] += d
        r['rows'] += 1
        r['held'] += abs(f(b.get('netPosition')))
        # Polymarket US has ONE book per market, so buying NO is recorded as selling YES: `qtySold` alone says
        # nothing about an exit. What an exit leaves behind is a MATCHED pair, and the venue pays those out at
        # netting time, outside the resolution delta - so the pair count is min(bought, sold), not either one.
        r['paired'] += min(f(b.get('qtyBought')), f(b.get('qtySold')))
        r['cost'] += f(b.get('cost', {}).get('value'))
        r['moved'] = r['moved'] or abs(d) >= EPS
    return out


def judge(app_pnl, res, arms):
    """(outcome, venue_pnl_or_None, why). `res` is one venue_resolutions() value; `arms` the arms that closed it."""
    if res is None:
        return 'unmatched', None, 'no resolution for this market in the venue record'
    if len(arms) > 1:
        return 'unjudgeable', None, 'closed by %d arms (%s); one delta cannot be split' % (len(arms), ', '.join(sorted(set(arms))))
    if res['held'] <= 0:
        return 'unjudgeable', None, 'nothing was held at the resolution: the app closed it out, and a resolution delta excludes that P&L'
    if res['paired'] > 0:
        return 'unjudgeable', None, 'matched %g pair(s) before it resolved: the venue paid those at netting, outside the delta' % res['paired']
    if not res['moved'] and res['cost'] >= EPS:
        return 'unjudgeable', None, 'the venue left realized unchanged on a position that cost $%.4f: a hole in the record, not a zero' % res['cost']
    if abs(app_pnl - res['delta']) < EPS:
        return 'agrees', res['delta'], ''
    return 'regraded', res['delta'], 'app $%.4f, venue $%.4f' % (app_pnl, res['delta'])


def live_closes(path):
    rows = []
    with open(path, encoding='utf-8') as stream:
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get('type') == 'closed':
                rows.append(r)
    return rows


def regrade_live(closes, res):
    by_slug = collections.defaultdict(list)
    for r in closes:
        by_slug[r.get('marketId')].append(r)
    out = []
    for slug, group in sorted(by_slug.items()):
        arms = [r.get('strategy') for r in group]
        app = sum(f(r.get('pnl')) for r in group)
        outcome, venue, why = judge(app, res.get(slug), arms)
        out.append({'market': slug, 'arms': arms, 'appPnl': round(app, 4),
                    'venuePnl': None if venue is None else round(venue, 4),
                    'outcome': outcome, 'why': why, 'closes': len(group)})
    return out


def regrade_lab(trades, res):
    """The paper lab has no money at the venue, so only its settlement PRICE can be wrong. A settlement priced at
    something other than 0 or 1 is the provisional book price the section-160 bug wrote."""
    out = []
    for t in trades:
        if t.get('reason') != 'venue settlement' or t.get('exit') is None:
            continue
        if f(t['exit']) in (0.0, 1.0):
            continue
        slug = (t.get('market') or {}).get('id')
        out.append({'id': t.get('id'), 'arm': t.get('strategy'), 'market': slug, 'side': t.get('side'),
                    'exit': f(t['exit']), 'net': f(t.get('net')), 'opened': t.get('opened'),
                    'outcome': 'unjudgeable',
                    'why': 'settled at a provisional price and the market is %s the venue record, so its true 0/1 is not recoverable offline'
                           % ('in' if slug in res else 'not in')})
    return out


def per_arm(live, lab):
    arms = collections.defaultdict(lambda: {'appPnl': 0.0, 'venuePnl': 0.0, 'judged': 0, 'regraded': 0, 'unjudgeable': 0, 'labExcluded': 0})
    for r in live:
        if len(set(r['arms'])) != 1:
            continue
        a = arms[r['arms'][0]]
        if r['outcome'] in ('agrees', 'regraded'):
            a['appPnl'] += r['appPnl']
            a['venuePnl'] += r['venuePnl']
            a['judged'] += r['closes']
            if r['outcome'] == 'regraded':
                a['regraded'] += r['closes']
        elif r['outcome'] == 'unjudgeable':
            a['unjudgeable'] += r['closes']
    for r in lab:
        arms['lab:' + str(r['arm'])]['labExcluded'] += 1
    return {k: {x: (round(v, 4) if isinstance(v, float) else v) for x, v in val.items()} for k, val in sorted(arms.items())}


def selftest():
    ok = 0

    def eq(name, got, want):
        nonlocal ok
        assert got == want, '%s: got %r want %r' % (name, got, want)
        ok += 1

    r = {'delta': -0.42, 'rows': 1, 'held': 1.0, 'paired': 0.0, 'cost': 0.42, 'moved': True}
    eq('held and moved and equal -> agrees', judge(-0.42, r, ['fade'])[0], 'agrees')
    eq('held and moved and different -> regraded', judge(0.0, r, ['fade'])[:2], ('regraded', -0.42))
    eq('within half a cent -> agrees', judge(-0.4245, r, ['fade'])[0], 'agrees')
    eq('two arms -> unjudgeable', judge(-0.42, r, ['fade', 'lag'])[0], 'unjudgeable')
    eq('no resolution -> unmatched', judge(-0.42, None, ['fade'])[:2], ('unmatched', None))
    eq('closed out before resolution -> unjudgeable',
       judge(-0.36, {'delta': 0.0, 'rows': 1, 'held': 0.0, 'paired': 2.0, 'cost': 0.36, 'moved': False}, ['micro-maker'])[0], 'unjudgeable')
    eq('partly netted -> unjudgeable',
       judge(-0.01, {'delta': -0.54, 'rows': 1, 'held': 1.0, 'paired': 1.0, 'cost': 0.54, 'moved': True}, ['micro-maker'])[0], 'unjudgeable')
    # A NO position is a YES sale on this venue's single book. qtySold > 0 with no matching buy is not an exit,
    # and reading it as one made every one of fade's 67 held-to-settlement markets unjudgeable (2026-09-23).
    eq('a NO position (sold, never bought) is held, not exited',
       judge(0.0, {'delta': 0.08, 'rows': 1, 'held': 1.0, 'paired': 0.0, 'cost': 0.92, 'moved': True}, ['fade'])[:2], ('regraded', 0.08))
    eq('realized unchanged on a paid-for position -> unjudgeable, NOT a zero',
       judge(-0.36, {'delta': 0.0, 'rows': 1, 'held': 1.0, 'paired': 0.0, 'cost': 0.36, 'moved': False}, ['micro-maker'])[:2], ('unjudgeable', None))
    eq('a genuinely free position that resolved at zero is still judgeable',
       judge(0.0, {'delta': 0.0, 'rows': 1, 'held': 1.0, 'paired': 0.0, 'cost': 0.0, 'moved': False}, ['fade'])[0], 'agrees')

    dump = {'activities_all': {'activities': [
        {'positionResolution': {'marketSlug': 'm1',
                                'beforePosition': {'netPosition': '-2', 'qtyBought': '0', 'qtySold': '2', 'cost': {'value': '1.00'}, 'realized': {'value': '0.0000'}},
                                'afterPosition': {'realized': {'value': '1.0000'}}}},
        {'trade': {'marketSlug': 'm1'}},
    ]}}
    res = venue_resolutions(dump)
    eq('venue_resolutions reads one resolution', (len(res), round(res['m1']['delta'], 4), res['m1']['moved']), (1, 1.0, True))
    eq('trade rows are not resolutions', 'trade' in res, False)

    live = regrade_live([{'type': 'closed', 'marketId': 'm1', 'strategy': 'fade', 'pnl': 0.5}], res)
    eq('a live close is re-graded to the venue figure', (live[0]['outcome'], live[0]['venuePnl']), ('regraded', 1.0))
    eq('per-arm totals use the venue figure, not the app one', per_arm(live, [])['fade']['venuePnl'], 1.0)

    lab = regrade_lab([
        {'id': 'a', 'strategy': 'favorite', 'reason': 'venue settlement', 'exit': 0.96, 'net': 0.0, 'opened': 1, 'market': {'id': 'x'}},
        {'id': 'b', 'strategy': 'favorite', 'reason': 'venue settlement', 'exit': 1.0, 'net': 0.1, 'opened': 1, 'market': {'id': 'm1'}},
        {'id': 'c', 'strategy': 'favorite', 'reason': '15-minute exit', 'exit': 0.5, 'net': 0.1, 'opened': 1, 'market': {'id': 'm1'}},
    ], res)
    eq('only a provisional settlement price is flagged in the lab', [r['id'] for r in lab], ['a'])
    eq('a flagged lab row is excluded, never re-priced', lab[0]['outcome'], 'unjudgeable')
    print('selftest OK (%d assertions)' % ok)
    return 0


def main(argv):
    if argv and argv[0] == 'selftest':
        return selftest()
    write = '--write' in argv
    paths = [a for a in argv if not a.startswith('--')]
    if not paths:
        print(__doc__.strip().splitlines()[2].strip())
        return 2
    A = os.path.join(os.environ.get('APPDATA', ''), 'oracle-trader')
    res = venue_resolutions(json.load(open(paths[0], encoding='utf-8')))
    live = regrade_live(live_closes(os.path.join(A, 'mini-auto-polymarket-us.json-research.jsonl')), res)
    lab = regrade_lab(json.load(open(os.path.join(A, 'poly-paper.json'), encoding='utf-8')).get('trades', []), res)
    arms = per_arm(live, lab)

    counts = collections.Counter(r['outcome'] for r in live)
    print('Polymarket US re-grade from the venue record (%d resolved markets in the dump)' % len(res))
    print('  live closes by market: %s' % dict(counts))
    app = sum(r['appPnl'] for r in live if r['outcome'] in ('agrees', 'regraded'))
    ven = sum(r['venuePnl'] for r in live if r['outcome'] in ('agrees', 'regraded'))
    print('  judgeable markets: app $%.2f -> venue $%.2f (%+.2f)' % (app, ven, ven - app))
    print('  paper-lab settlements booked at a provisional price: %d (excluded, not re-priced)' % len(lab))
    print('  by arm (judgeable closes only):')
    for k, v in arms.items():
        if v['judged'] or v['unjudgeable']:
            print('    %-22s judged %-4d app $%-8.2f venue $%-8.2f  regraded %-3d unjudgeable %d'
                  % (k, v['judged'], v['appPnl'], v['venuePnl'], v['regraded'], v['unjudgeable']))
        else:
            print('    %-22s lab rows excluded: %d' % (k, v['labExcluded']))
    for r in live:
        if r['outcome'] == 'regraded':
            print('    regraded %-46s %-14s %s' % (r['market'], '/'.join(sorted(set(r['arms']))), r['why']))

    if write:
        out = os.path.join('data', 'polyus-regrade')
        os.makedirs(out, exist_ok=True)
        p = os.path.join(out, 'regraded.json')
        with open(p, 'w', encoding='utf-8') as stream:
            json.dump({'at': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'dump': paths[0],
                       'resolvedMarkets': len(res), 'live': live, 'lab': lab, 'byArm': arms}, stream, indent=1)
        print('  wrote %s' % p)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
