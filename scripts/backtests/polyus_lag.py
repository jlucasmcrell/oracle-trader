"""Kalshi leads Polymarket US in play: grade the one-legged "buy Polymarket US's stale side" rule on data/sports-books.

    python scripts/backtests/polyus_lag.py [--since 2026-09-22T20:52Z] [--public-results]

Polymarket US is a slow venue (its top of book is unchanged in ~92% of 60 s cycles; 63% in play). When Kalshi's mid
for a team moves by M cents between two consecutive recorder cycles while Polymarket US's has moved less than 1c, and
Polymarket US's ask on the side Kalshi moved toward is still at least F cents below Kalshi's new mid after Polymarket
US's taker fee, the rule buys that side on Polymarket US and holds to settlement. Only the current and previous cycle
are used to decide; later cycles are used only to score the catch-up.

First measured 2026-09-22 (section 160) on 09-18..09-22: M >= 5c +14.2c/contract [+1.5, +28.4] on 93 settled
triggers over 23 games; M >= 8c +18.0c [+1.1, +33.7] on 38 over 16. That window ran under the recorder's dropout
bug (fixed 2026-09-22T20:51Z) and resolved only 20% of markets, from terminal books, which can favour blowouts.
--public-results resolves every market from Kalshi's public settled list instead (paced GETs), and --since keeps
only rows recorded after the fix. Read-only.
"""
import argparse, os, sys, time, urllib.request
import json, glob, re, random, statistics
from collections import defaultdict, Counter
from datetime import datetime

random.seed(12345)

ap = argparse.ArgumentParser()
ap.add_argument('--dir', default='G:/PROJECTS/oracle-trader/data/sports-books')
ap.add_argument('--since', default='', help='ISO instant; rows before it are ignored (the recorder fix: 2026-09-22T20:52Z)')
ap.add_argument('--settle', default='G:/PROJECTS/oracle-trader/tmp/kalshi-2026-09-22.json', help='account settlement dump (optional)')
ap.add_argument('--public-results', action='store_true', help="resolve every market from Kalshi's public settled list")
args = ap.parse_args()
DATA_FILES = sorted(glob.glob(os.path.join(args.dir, '2026-*.jsonl')))
SETTLE_FILE = args.settle

F_CENTS = 1  # minimum post-fee edge (cents) for a trigger (the 2026-09-22 measurement's choice; 0 and 2 gave 670 and 488 triggers against 596)
F = F_CENTS / 100.0
M_LIST_CENTS = [3, 5, 8]
GAP_LO, GAP_HI = 30.0, 100.0  # seconds -- tolerance band for "one ~60s cycle" (median 66.7s, p99 94.2s from exploration)

def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))

def league_of(event):
    m = re.match(r'KX([A-Z]+?)(?:GAME)?-', event)
    return m.group(1) if m else event[:12]

def fee(p):
    return round(0.0695 * p * (1 - p), 2)

# ---------- load ----------
seen = set()
rows_by_ticker = defaultdict(list)
n_raw = 0
for fp in DATA_FILES:
    with open(fp, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            n_raw += 1
            if args.since and d['ts'] < args.since:
                continue
            key = (d['ticker'], d['ts'])
            if key in seen:
                continue
            seen.add(key)
            rows_by_ticker[d['ticker']].append(d)

print(f"raw rows read: {n_raw}, unique (ticker,ts) rows: {sum(len(v) for v in rows_by_ticker.values())}, unique tickers: {len(rows_by_ticker)}")

# ---------- settlement dump ----------
dump_map = {}
if SETTLE_FILE and os.path.exists(SETTLE_FILE):
    with open(SETTLE_FILE, encoding='utf-8') as f:
        for row in json.load(f)['settlements']:
            dump_map[row['ticker']] = row['market_result']  # 'yes' or 'no'
public = {}
if args.public_results:
    first_ts = min((r['ts'] for rows in rows_by_ticker.values() for r in rows), default='2026-09-01T00:00:00Z')
    lo = int(datetime.fromisoformat(first_ts.replace('Z', '+00:00')).timestamp())
    for ser in sorted({t.split('-')[0] for t in rows_by_ticker}):
        cur = ''
        while True:
            u = 'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=%s&status=settled&limit=1000&min_close_ts=%d%s' % (ser, lo, ('&cursor=' + cur) if cur else '')
            d = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'oracle-trader-readonly'}), timeout=25))
            public.update({m['ticker']: m.get('result') for m in d.get('markets', []) if m.get('result') in ('yes', 'no')})
            cur = d.get('cursor') or ''
            time.sleep(1.0)
            if not cur or not d.get('markets'):
                break
    print(f"public results: {len(public)} settled markets across the recorded series")

# ---------- build per-ticker series with derived fields ----------
series = {}  # ticker -> list of dict (sorted by ts)
for t, rows in rows_by_ticker.items():
    rows.sort(key=lambda d: d['ts'])
    long_flag = rows[0]['kalshiTeamIsLong']
    out = []
    for d in rows:
        kb = d['k']['bids']; ka = d['k']['asks']
        if not kb or not ka:
            continue
        k_bid, k_bid_sz = kb[0]
        k_ask, k_ask_sz = ka[0]
        pb = d['pm']['bids']; pa = d['pm']['asks']
        if not pb or not pa:
            continue
        if long_flag:
            yb, ya = pb, pa
        else:
            yb = [(1 - p, s) for p, s in pa]
            ya = [(1 - p, s) for p, s in pb]
        pm_yes_bid, pm_yes_bid_sz = yb[0]
        pm_yes_ask, pm_yes_ask_sz = ya[0]
        out.append(dict(
            ts=d['ts'], ts_dt=parse_ts(d['ts']), gameStart_dt=parse_ts(d['gameStart']),
            event=d['event'], team=d['team'], slug=d['slug'],
            k_bid=k_bid, k_ask=k_ask, k_mid=(k_bid + k_ask) / 2,
            pm_yes_bid=pm_yes_bid, pm_yes_ask=pm_yes_ask, pm_yes_mid=(pm_yes_bid + pm_yes_ask) / 2,
            pm_yes_bid_sz=pm_yes_bid_sz, pm_yes_ask_sz=pm_yes_ask_sz,
        ))
    series[t] = out

# ---------- settlement resolution ----------
resolution = {}  # ticker -> ('won'/'lost', source)
for t, rows in series.items():
    if not rows:
        continue
    last = rows[-1]
    term = None
    if last['k_ask'] <= 0.02:
        term = 'lost'
    elif last['k_bid'] >= 0.98:
        term = 'won'
    dump = None
    if t in dump_map:
        dump = 'won' if dump_map[t] == 'yes' else 'lost'
    if t in public:
        resolution[t] = ('won' if public[t] == 'yes' else 'lost', 'public')
    elif term is not None:
        resolution[t] = (term, 'terminal')
    elif dump is not None:
        resolution[t] = (dump, 'dump')
    # else: unresolved, dropped

n_term = sum(1 for v in resolution.values() if v[1] == 'terminal')
n_dump = sum(1 for v in resolution.values() if v[1] == 'dump')
print(f"resolved tickers: {len(resolution)} / {len(series)}  (terminal={n_term}, dump-only={n_dump})")

# cross-validation: tickers with BOTH terminal and dump available
both = 0; agree = 0
for t, rows in series.items():
    if not rows:
        continue
    last = rows[-1]
    term = 'lost' if last['k_ask'] <= 0.02 else ('won' if last['k_bid'] >= 0.98 else None)
    if term is not None and t in dump_map:
        both += 1
        dump = 'won' if dump_map[t] == 'yes' else 'lost'
        if dump == term:
            agree += 1
print(f"cross-check (terminal vs settlement-dump, where both exist): {agree}/{both} agree")

if False:
    json.dump({"n_resolved": len(resolution), "n_series": len(series), "n_terminal": n_term,
               "n_dump": n_dump, "crosscheck_both": both, "crosscheck_agree": agree}, f, indent=2)

# ---------- trigger detection ----------
def forward_walk(rows, i, max_k=5):
    res = {}
    j = i
    for k in range(1, max_k + 1):
        if j + 1 >= len(rows):
            break
        dt = (rows[j + 1]['ts_dt'] - rows[j]['ts_dt']).total_seconds()
        if not (GAP_LO <= dt <= GAP_HI):
            break
        j += 1
        res[k] = j
    return res

triggers = []
excluded_gap = 0
excluded_pm_moved = 0
n_pairs_considered = 0
for t, rows in series.items():
    if len(rows) < 2:
        continue
    settle, settle_src = resolution.get(t, (None, None))
    league = league_of(rows[0]['event'])
    for i in range(1, len(rows)):
        dt = (rows[i]['ts_dt'] - rows[i - 1]['ts_dt']).total_seconds()
        if not (GAP_LO <= dt <= GAP_HI):
            excluded_gap += 1
            continue
        n_pairs_considered += 1
        delta_k = rows[i]['k_mid'] - rows[i - 1]['k_mid']
        delta_pm = rows[i]['pm_yes_mid'] - rows[i - 1]['pm_yes_mid']
        if abs(delta_pm) >= 0.01:
            excluded_pm_moved += 1
            continue
        abs_delta_k_cents = abs(delta_k) * 100
        if abs_delta_k_cents < M_LIST_CENTS[0]:
            continue
        side = 'yes' if delta_k > 0 else 'no'
        if side == 'yes':
            ask_price = rows[i]['pm_yes_ask']; ask_size = rows[i]['pm_yes_ask_sz']
            kalshi_target = rows[i]['k_mid']
        else:
            ask_price = 1 - rows[i]['pm_yes_bid']; ask_size = rows[i]['pm_yes_bid_sz']
            kalshi_target = 1 - rows[i]['k_mid']
        if ask_price <= 0.0 or ask_price >= 1.0:
            continue
        fe = fee(ask_price)
        eff_cost = ask_price + fe
        gap_cents = (kalshi_target - eff_cost) * 100
        if gap_cents < F_CENTS:
            continue

        if settle is None:
            pnl = None
        else:
            won_side = (settle == 'won') if side == 'yes' else (settle == 'lost')
            pnl = (1.0 if won_side else 0.0) - eff_cost

        fw = forward_walk(rows, i, max_k=5)
        side_mid_i = rows[i]['pm_yes_mid'] if side == 'yes' else (1 - rows[i]['pm_yes_mid'])
        gap0 = kalshi_target - side_mid_i
        catch_frac = {}
        caught_bool = {}
        for k in (1, 2, 5):
            if k in fw:
                j = fw[k]
                smid = rows[j]['pm_yes_mid'] if side == 'yes' else (1 - rows[j]['pm_yes_mid'])
                gapk = kalshi_target - smid
                caught_bool[k] = gapk < gap0 - 1e-9
                catch_frac[k] = (1 - gapk / gap0) if abs(gap0) > 1e-9 else None

        full_reversal_5 = None
        if 5 in fw:
            j = fw[5]
            k_mid_j = rows[j]['k_mid']
            if side == 'yes':
                full_reversal_5 = k_mid_j <= rows[i - 1]['k_mid']
            else:
                full_reversal_5 = k_mid_j >= rows[i - 1]['k_mid']

        pregame = rows[i]['ts_dt'] < rows[i]['gameStart_dt']
        triggers.append(dict(
            ticker=t, event=rows[i]['event'], league=league, pregame=pregame,
            abs_delta_k_cents=abs_delta_k_cents, side=side,
            ask_price=ask_price, ask_size=ask_size, fee=fe, eff_cost=eff_cost,
            gap_cents=gap_cents, kalshi_target=kalshi_target, side_mid_i=side_mid_i,
            caught_bool=caught_bool, catch_frac=catch_frac, full_reversal_5=full_reversal_5,
            settle=settle, settle_src=settle_src, pnl=pnl, ts=rows[i]['ts'],
        ))

print(f"\nconsecutive pairs in-cadence: {n_pairs_considered}  (excluded for gap: {excluded_gap})")
print(f"excluded for PM already moved (>=1c): {excluded_pm_moved}")
print(f"total base triggers (>=3c, PM stale, gap>=F after fee): {len(triggers)}")
print(f"  of which settled (won/lost known): {sum(1 for x in triggers if x['pnl'] is not None)}")
print(f"  unique tickers triggering: {len(set(x['ticker'] for x in triggers))}")
print(f"  unique events triggering: {len(set(x['event'] for x in triggers))}")
print(f"  min ask_size observed at trigger: {min((x['ask_size'] for x in triggers), default=None)}")


# ---------- depth sanity ----------
sizes = [x['ask_size'] for x in triggers]
sizes_sorted = sorted(sizes)
n_lt1 = sum(1 for s in sizes if s < 1.0)
print(f"\ndepth at triggered ask: min={sizes_sorted[0]}, p5={sizes_sorted[int(0.05*len(sizes))]}, median={sizes_sorted[len(sizes)//2]}")
print(f"triggers with ask depth < 1 contract: {n_lt1} / {len(sizes)} ({100*n_lt1/len(sizes):.1f}%)")

# ---------- aggregation ----------
N_DAYS = max(1, len({r['ts'][:10] for rows in rows_by_ticker.values() for r in rows}))  # UTC days with rows

def cluster_bootstrap_ci(items, B=3000):
    by_event = defaultdict(list)
    for x in items:
        by_event[x['event']].append(x['pnl'])
    events = list(by_event.keys())
    n_events = len(events)
    if n_events == 0:
        return None
    means = []
    for _ in range(B):
        vals = []
        for _ in range(n_events):
            e = random.choice(events)
            vals.extend(by_event[e])
        if vals:
            means.append(sum(vals) / len(vals))
    means.sort()
    if not means:
        return None
    lo = means[int(0.025 * len(means))]
    hi = means[int(0.975 * len(means))]
    return lo, hi, n_events

def summarize(items, label):
    settled = [x for x in items if x['pnl'] is not None]
    n = len(items)
    n_s = len(settled)
    out = {"label": label, "n_triggers": n, "n_settled": n_s}
    if n_s > 0:
        pnls = [x['pnl'] for x in settled]
        out["mean_pnl"] = statistics.mean(pnls)
        ci = cluster_bootstrap_ci(settled)
        if ci:
            out["ci95_lo"], out["ci95_hi"], out["n_clusters"] = ci
        out["worst_loss"] = min(pnls)
        out["win_rate"] = sum(1 for p in pnls if p > 0) / n_s
        out["dollars_per_day_settled_sample"] = sum(pnls) / N_DAYS
        n_events_settled = len(set(x['event'] for x in settled))
        out["n_events_settled"] = n_events_settled
    # catch-up / reversal computed over ALL base triggers in this slice (doesn't need settlement)
    c1 = [x['caught_bool'].get(1) for x in items if 1 in x['caught_bool']]
    if c1:
        out["share_caught_up_by_next_cycle"] = sum(c1) / len(c1)
        out["n_with_k1_data"] = len(c1)
    for k in (1, 2, 5):
        fracs = [x['catch_frac'][k] for x in items if k in x['catch_frac'] and x['catch_frac'][k] is not None]
        if fracs:
            out[f"mean_catchfrac_{k}"] = statistics.mean(fracs)
    revs = [x['full_reversal_5'] for x in items if x['full_reversal_5'] is not None]
    if revs:
        out["kalshi_full_reversal_rate_5cyc"] = sum(revs) / len(revs)
    return out

results = {}
for M in M_LIST_CENTS:
    subset = [x for x in triggers if x['abs_delta_k_cents'] >= M]
    results[f"M={M}_overall"] = summarize(subset, f"M={M} overall")
    for pg, name in [(True, "pregame"), (False, "ingame")]:
        sub2 = [x for x in subset if x['pregame'] == pg]
        results[f"M={M}_{name}"] = summarize(sub2, f"M={M} {name}")
    if M == 3:
        for lg in sorted(set(x['league'] for x in subset)):
            sub3 = [x for x in subset if x['league'] == lg]
            results[f"M=3_league_{lg}"] = summarize(sub3, f"M=3 league={lg}")

for k, v in results.items():
    print("\n---", k, "---")
    for kk, vv in v.items():
        if isinstance(vv, float):
            print(f"  {kk}: {vv:.4f}")
        else:
            print(f"  {kk}: {vv}")
