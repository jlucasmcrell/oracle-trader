"""Does the pre-trade critic's shadow verdict carry information? (no network, no writes)

    python scripts/critic-skill.py <kalshi_dump.json>

Joins intelligence/decisions.jsonl (one row per reviewed candidate: market id,
direction, executable price, the model's verdict) to the venue's settlements in a
read-only Kalshi dump, and reports the hypothetical per-contract net of the
candidates by verdict. If VETOed candidates are not worse than the rest, the
verdict has no skill and veto mode must stay off.

2026-09-07 (45 settled): VETO n=24 mean +2.9c, ABSTAIN n=21 mean +10.0c,
ERROR (no verdict) n=32 mean -11.4c. No skill shown; shadow moved to the free
local models.
"""
import collections
import json
import os
import sys


def main(dump_path):
    result = {}
    for s in json.load(open(dump_path, encoding='utf-8')).get('settlements', []):
        result[s['ticker']] = s.get('market_result')
    log = os.path.join(os.environ.get('APPDATA', ''), 'oracle-trader', 'intelligence', 'decisions.jsonl')
    rows = [json.loads(l) for l in open(log, encoding='utf-8') if l.strip()]
    groups = collections.defaultdict(list)
    pending = collections.Counter()
    for r in rows:
        pk = r.get('packet') or {}
        m = pk.get('market') or {}
        o = pk.get('order') or {}
        tid, d, px = m.get('id'), o.get('direction'), o.get('executablePrice')
        fee = (o.get('feeCents') or 0) / 100.0
        act = (r.get('verdict') or {}).get('action') or 'ERROR'
        if act.startswith('ABSTAIN'):
            act = 'ABSTAIN'
        if not tid or d not in ('YES', 'NO') or not isinstance(px, (int, float)):
            continue
        rr = result.get(tid)
        if rr not in ('yes', 'no'):
            pending[act] += 1
            continue
        won = (d == 'YES' and rr == 'yes') or (d == 'NO' and rr == 'no')
        net = (1.0 if won else 0.0) - px - fee
        groups[(act, 'ALL')].append(net)
        groups[(act, pk.get('strategy') or '?')].append(net)
    print('decisions %d; not yet settled by verdict: %s' % (len(rows), dict(pending)))
    for k in sorted(groups):
        v = groups[k]
        wins = sum(1 for x in v if x > 0)
        print('  %-8s %-14s n=%-3d win %3d%%  mean net %+.3f/contract  sum %+.2f' % (k[0], k[1], len(v), round(100 * wins / len(v)), sum(v) / len(v), sum(v)))
    veto = groups.get(('VETO', 'ALL'), [])
    rest = groups.get(('ABSTAIN', 'ALL'), [])
    if len(veto) >= 50 and len(rest) >= 50:
        mv, mr = sum(veto) / len(veto), sum(rest) / len(rest)
        print('verdict: vetoes %s the rest (%.3f vs %.3f); %s' % ('below' if mv < mr else 'not below', mv, mr, 'consider veto mode' if mv < mr - 0.02 else 'keep veto mode off'))
    else:
        print('verdict: fewer than 50 settled per group; keep measuring')


if __name__ == '__main__':
    main(sys.argv[1])
