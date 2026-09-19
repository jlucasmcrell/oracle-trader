"""Read-only: would a stop-loss or a take-profit have beaten holding to settlement on the hold-to-settlement arms?
Source: the per-minute book archive in episodes/kalshi-*.jsonl joined to the entry/exit rows in the same files.
Exit prices are the archived best bid of OUR side at the first snapshot that crosses the level (gap-aware), less
the Kalshi taker fee. Nothing here touches the venue or the app state."""
import json, os, glob, collections, statistics, sys

D = os.path.join(os.environ['APPDATA'], 'oracle-trader', 'episodes')
files = sorted(f for f in glob.glob(os.path.join(D, 'kalshi-2026-*.jsonl')) if f.endswith('.jsonl'))
HOLD = {'fade', 'consensus', 'momentum', 'mean-reversion', 'weather-morning', 'settlement'}

# ---- pass 1: trades
segs = collections.defaultdict(list)   # (market, outcome, strat) -> [segment]
for f in files:
    with open(f, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            if '"kind":"entry"' not in line and '"kind":"exit"' not in line: continue
            try: r = json.loads(line)
            except Exception: continue
            strat = str(r.get('strategy', '')).split(':')[0]
            key = (r.get('marketId'), r.get('outcome'), strat)
            L = segs[key]
            if r['kind'] == 'entry':
                if not L or L[-1]['exits']:
                    L.append({'t0': r['ts'], 'cost': 0.0, 'shares': 0.0, 'exits': [], 'cohort': r.get('strategy')})
                s = L[-1]; sh = float(r.get('shares') or 0); s['shares'] += sh; s['cost'] += sh * float(r.get('entryPrice') or 0)
            else:
                if not L: continue
                L[-1]['exits'].append((r['ts'], float(r.get('pnl') or 0))); L[-1]['cohort_exit'] = r.get('strategy')

trades = []
for (m, o, st), L in segs.items():
    for s in L:
        if not s['exits'] or s['shares'] <= 0: continue
        entry = s['cost'] / s['shares']
        pnl_c = sum(p for _, p in s['exits']) / s['shares'] * 100
        trades.append({'m': m, 'o': o, 'st': st, 't0': s['t0'], 't1': s['exits'][-1][0], 'entry': entry, 'shares': s['shares'],
                       'hold_c': pnl_c, 'cohort': s.get('cohort_exit') or st, 'path': []})
by_market = collections.defaultdict(list)
for t in trades: by_market[t['m']].append(t)
print('trades paired:', len(trades), 'markets:', len(by_market), 'files:', len(files), file=sys.stderr)

# ---- pass 2: book paths inside each trade's window
for f in files:
    with open(f, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            if '"kind":"book"' not in line: continue
            i = line.find('"marketId":"')
            if i < 0: continue
            j = line.find('"', i + 12)
            m = line[i + 12:j]
            if m not in by_market: continue
            try: r = json.loads(line)
            except Exception: continue
            ts = r['ts']; bids = r.get('bids') or []; asks = r.get('asks') or []
            for t in by_market[m]:
                if ts < t['t0'] or ts > t['t1']: continue
                if t['o'] == 'YES':
                    if not bids: continue
                    bid = bids[0][0]
                else:
                    if not asks: continue
                    bid = 1 - asks[0][0]
                t['path'].append((ts, bid))

def fee_c(p):  # Kalshi taker fee, cents per contract
    return 7.0 * p * (1 - p)

STOPS = [3, 5, 8, 10, 15, 20, 30]
TAKES = [2, 3, 5, 8]
out = []
def W(s=''): out.append(s); print(s)

for st in sorted({t['st'] for t in trades}):
    T = [t for t in trades if t['st'] == st and t['cohort'] == st]   # the live cohort only; detached/pre- cohorts reported apart
    if st not in HOLD or len(T) < 8: continue
    cov = [t for t in T if len(t['path']) >= 5]
    W(f'\n=== {st}: {len(T)} settled trades, {len(cov)} with a book path (>=5 one-minute snapshots)')
    if len(cov) < 8: continue
    n_c = sum(t['shares'] for t in cov)
    hold_w = sum(t['hold_c'] * t['shares'] for t in cov) / n_c
    losers = [t for t in cov if t['hold_c'] < 0]; winners = [t for t in cov if t['hold_c'] >= 0]
    W(f'hold to settlement: {hold_w:+.2f}c/contract over {n_c:.1f} contracts; {len(winners)} winners, {len(losers)} losers; mean entry {statistics.mean(t["entry"] for t in cov)*100:.0f}c')
    mfe_l = [max(b for _, b in t['path']) - t['entry'] for t in losers]
    W(f'losers that were EVER up >=3c at the bid before losing: {sum(1 for x in mfe_l if x >= 0.03)} of {len(losers)}; >=5c: {sum(1 for x in mfe_l if x >= 0.05)}')
    mae_w = [min(b for _, b in t['path']) - t['entry'] for t in winners]
    for s in (5, 10, 20):
        W(f'winners that were EVER down >={s}c at the bid before winning: {sum(1 for x in mae_w if x <= -s/100)} of {len(winners)}')
    W('rule          triggered  of-which-would-have-won  mean slip past level  result c/contract  vs hold')
    for kind, levels in (('stop', STOPS), ('take', TAKES)):
        for lv in levels:
            tot = 0.0; trig = 0; trig_win = 0; slips = []
            for t in cov:
                hit = None
                for ts, b in t['path']:
                    if (kind == 'stop' and b <= t['entry'] - lv / 100) or (kind == 'take' and b >= t['entry'] + lv / 100):
                        hit = b; break
                if hit is None or hit <= 0.005:
                    tot += t['hold_c'] * t['shares']; continue
                trig += 1; trig_win += 1 if t['hold_c'] >= 0 else 0
                win = 1 if t['hold_c'] >= 0 else 0
                entry_fee = (win - t['entry']) * 100 - t['hold_c']           # what the ledger charged at entry, cents
                res = (hit - t['entry']) * 100 - max(0.0, entry_fee) - fee_c(hit)
                slips.append((hit - (t['entry'] + (lv if kind == 'take' else -lv) / 100)) * 100)
                tot += res * t['shares']
            r = tot / n_c
            W(f'{kind} {lv:>2}c      {trig:>4}        {trig_win:>4}                     {statistics.mean(slips) if slips else 0:+6.1f}c            {r:+7.2f}          {r - hold_w:+6.2f}')

