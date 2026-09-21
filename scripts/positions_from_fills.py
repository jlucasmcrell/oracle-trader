"""Rebuild the position reconstruction on NET EXPOSURE instead of a price filter.

Why the old one was wrong, with the case that proved it (KXSOLD-26SEP0817-T106.9999):
    09-08 02:36Z  buy YES  27.27 @ 0.11     <- the opening, $3.00
    09-08 05:03Z  "sell NO" 27.27 @ 0.96    <- the SAME position being closed (sell YES at 4c)
`outcome` has always been the exposure side and has always been right; the pre-2026-09-20 `side` was derived from
book_side and read 'sell' on every row (audit B-23). So a filter of "NO exposure at 85-99c" catches the CLOSING
leg of any cheap YES position and books it as a fresh 27-contract longshot fade worth $26 - in a $63 account.

The method that works in both eras: walk each market's fills in time order in YES-equivalent units (YES exposure
+shares, NO exposure -shares). A market that ends flat was round-tripped and has no settlement to grade. What
survives is the held position, and its cost is the fills that built the surviving side.
"""
import json, os, collections


def rebuild(fills_path, keep, max_plausible_cost=25.0):
    """keep(marketId) -> truthy to include. Returns (positions, diagnostics)."""
    by = collections.defaultdict(list)
    for line in open(fills_path, encoding='utf-8', errors='replace'):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if not keep(r['marketId']):
            continue
        by[r['marketId']].append(r)
    pos, flat, implausible = {}, [], {}
    for mid, rows in by.items():
        rows.sort(key=lambda r: r['timestamp'])
        net = 0.0                      # YES-equivalent exposure
        for r in rows:
            net += (r['shares'] if r['outcome'] == 'YES' else -r['shares'])
        if abs(net) <= 0.005:
            flat.append(mid)
            continue
        side = 'YES' if net > 0 else 'NO'
        # Cost of the surviving exposure: the fills on the surviving side, oldest first, up to |net|.
        want, shares, cost, fee, first = abs(net), 0.0, 0.0, 0.0, rows[0]['timestamp']
        for r in rows:
            if r['outcome'] != side or shares >= want - 1e-9:
                continue
            take = min(r['shares'], want - shares)
            shares += take
            cost += take * r['price']
            fee += (r.get('fee') or 0.0) * (take / r['shares'] if r['shares'] else 0)
            first = min(first, r['timestamp'])
        p = {'side': side, 'shares': shares, 'cost': cost, 'fee': fee, 'at': first, 'fills': len(rows)}
        if cost > max_plausible_cost:
            implausible[mid] = p
        else:
            pos[mid] = p
    return pos, {'flat': flat, 'implausible': implausible}
