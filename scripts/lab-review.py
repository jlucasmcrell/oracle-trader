"""Read-only review of both paper labs: every arm, contract-weighted, day-clustered, against the benchmark control.

    python scripts/lab-review.py

Written for docs/reports/LAB-STRATEGY-REVIEW-2026-09-20.md. Counts only trades opened under each lab's current
rules (POLY_PAPER_RULES_SINCE / IBKR_RULES_SINCE) and reads nothing but the labs' own ledgers. A control with a
handful of trades cannot anchor the "vs ctrl" column - check its own n before believing that flag.
"""
import json, os, math, time, collections

A = os.path.join(os.environ['APPDATA'], 'oracle-trader')
T90 = {1: 3.078, 2: 1.886, 3: 1.638, 4: 1.533, 5: 1.476, 6: 1.440, 7: 1.415, 8: 1.397, 9: 1.383, 10: 1.372,
       12: 1.356, 15: 1.341, 20: 1.325, 30: 1.310}


def t90(df):
    if df < 1:
        return float('inf')
    for k in sorted(T90):
        if df <= k:
            return T90[k]
    return 1.282


def band(rows):
    """rows: (day, contracts, net_dollars). Contract-weighted mean in cents, day-clustered 80% band."""
    ct = sum(r[1] for r in rows)
    net = sum(r[2] for r in rows)
    if ct <= 0:
        return None
    m = 100 * net / ct
    days = collections.defaultdict(lambda: [0.0, 0.0])
    for d, c, p in rows:
        days[d][0] += c
        days[d][1] += 100 * p
    G = len(days)
    if G < 2:
        return {'n': len(rows), 'ct': ct, 'net': net, 'mean': m, 'lo': None, 'hi': None, 'G': G, 'days': days}
    se = math.sqrt(G / (G - 1)) * math.sqrt(sum((s - c * m) ** 2 for c, s in days.values())) / ct
    k = t90(G - 1)
    return {'n': len(rows), 'ct': ct, 'net': net, 'mean': m, 'lo': m - k * se, 'hi': m + k * se, 'G': G, 'days': days}


def show(title, arms, bench_id, events_of=None):
    print('\n' + '=' * 108)
    print(title)
    print('=' * 108)
    b = arms.get(bench_id)
    # A control with no band of its own cannot anchor anything, and a "beats control" flag drawn against it is an
    # artifact of ITS small sample rather than a result (external review GLM 5.3 F-07; section 143).
    anchors = bool(b and b['lo'] is not None and b['n'] >= 30)
    bm = b['mean'] if b else 0.0
    if not anchors:
        print('  control: %s - every arm below is reported against ZERO, not against it'
              % ('n=%d over %d day(s), no usable band' % (b['n'], b['G']) if b else 'no closed trades'))
    print('  %-22s %5s %7s %8s %9s %-20s %5s %7s' % ('arm', 'n', 'ct', 'net $', 'c/ct', '80% band', 'days', 'vs ctrl'))
    for k in sorted(arms, key=lambda x: -(arms[x]['mean'])):
        v = arms[k]
        bs = '[%+7.2f,%+7.2f]' % (v['lo'], v['hi']) if v['lo'] is not None else 'one day: none'
        star = ''
        if anchors and v['lo'] is not None and v['lo'] > bm:
            star = '  BEATS CONTROL'
        elif anchors and v['hi'] is not None and v['hi'] < bm:
            star = '  below control'
        elif v['lo'] is not None and v['lo'] > 0:
            star = '  band clear of zero'
        elif v['hi'] is not None and v['hi'] < 0:
            star = '  band below zero'
        print('  %-22s %5d %7.1f %8.2f %9.2f %-20s %5d %7.2f%s'
              % (k + (' (control)' if k == bench_id else ''), v['n'], v['ct'], v['net'], v['mean'], bs, v['G'], v['mean'] - bm, star))


# ---------------- Polymarket US paper lab ----------------
P = json.load(open(os.path.join(A, 'poly-paper.json'), encoding='utf-8'))
RULES = 1789896840000  # POLY_PAPER_RULES_SINCE 2026-09-20T09:34:00Z (keep in step with src/shared/polyPaper.ts)
arms = collections.defaultdict(list)
legacy = collections.Counter()
for t in P['trades']:
    if t.get('closed') is None or t.get('net') is None:
        continue
    if t['opened'] < RULES:
        legacy[t['strategy']] += 1
        continue
    arms[t['strategy']].append((time.strftime('%m-%d', time.gmtime(t['closed'] / 1000)), 1.0, t['net']))
res = {k: band(v) for k, v in arms.items() if band(v)}
show('POLYMARKET US paper lab - trades opened under the current rules (since %s)' % time.strftime('%Y-%m-%d %H:%MZ', time.gmtime(RULES / 1000)), res, 'benchmark')
print('  legacy cohort (older rules, excluded):', dict(legacy) or 'none')
print('  exit reasons:', collections.Counter(t.get('reason') for t in P['trades'] if t['opened'] >= RULES).most_common())
# The maker seat is bracketed, never a point estimate: a 'probable' fill is a vanished price level, which is what
# being consumed AND what being cancelled both look like on snapshot data (section 143).
_mk = [t for t in P['trades'] if t['opened'] >= RULES and t.get('maker')]
print('  maker fills: %d certain, %d probable' % (sum(1 for t in _mk if t.get('fill') == 'certain'), sum(1 for t in _mk if t.get('fill') == 'probable')))
# BACKLOG 198: a maker arm is judged on the BRACKET, not on the pooled number. If the certain-only and
# probable-only bands disagree in sign, the arm has no read - say so and do not conclude.
_mkc = [t for t in _mk if t.get('closed') is not None and t.get('net') is not None]
if _mkc:
    print('  maker fill bracket (certain-only vs probable-only; disagreeing signs = no conclusion):')
    for k in sorted({t['strategy'] for t in _mkc}):
        cells = []
        for lab in ('certain', 'probable'):
            v = band([(time.strftime('%m-%d', time.gmtime(t['closed'] / 1000)), 1.0, t['net'])
                      for t in _mkc if t['strategy'] == k and t.get('fill') == lab])
            cells.append('%s n=%-3d %+7.2fc %s' % (lab, v['n'], v['mean'],
                         '[%+7.2f,%+7.2f]' % (v['lo'], v['hi']) if v['lo'] is not None else 'one day: none') if v
                         else '%s n=0' % lab)
        both = [band([(time.strftime('%m-%d', time.gmtime(t['closed'] / 1000)), 1.0, t['net'])
                      for t in _mkc if t['strategy'] == k and t.get('fill') == lab]) for lab in ('certain', 'probable')]
        flag = ''
        if all(b and b['lo'] is not None for b in both):
            signs = {(1 if b['lo'] > 0 else -1 if b['hi'] < 0 else 0) for b in both}
            flag = '  NO CONCLUSION: brackets disagree' if signs == {1, -1} else '  brackets agree'
        print('   %-14s %s | %s%s' % (k, cells[0], cells[1], flag))
print('  open positions:', len(P.get('positions', [])), '| resting orders:', len(P.get('orders', [])), '| markets tracked:', len(P.get('markets', [])))

# ---------------- IBKR ForecastEx paper lab ----------------
I = json.load(open(os.path.join(A, 'ibkr-lab.json'), encoding='utf-8'))
RULES_I = 1789630303000  # IBKR_RULES_SINCE 2026-09-17T07:31:43Z
arms = collections.defaultdict(list)
events = collections.defaultdict(set)
legacy = collections.Counter()
for t in I['trades']:
    q = t.get('quantity') or 1
    if t['openedAt'] < RULES_I:
        legacy[t['strategy']] += 1
        continue
    arms[t['strategy']].append((time.strftime('%m-%d', time.gmtime(t['closedAt'] / 1000)), q, t['net']))
    events[t['strategy']].add('_'.join(t['marketId'].split('_')[:-1]))
res = {k: band(v) for k, v in arms.items() if band(v)}
show('IBKR ForecastEx paper lab - trades opened under the current rules (since %s)' % time.strftime('%Y-%m-%d %H:%MZ', time.gmtime(RULES_I / 1000)), res, 'benchmark')
print('  legacy cohort (older rules, excluded):', dict(legacy) or 'none')
print('\n  live-eligibility gate (30 closed, 10 events, 3 days, positive day-cluster lower bound):')
for k in sorted(res, key=lambda x: -res[x]['mean']):
    v = res[k]
    ok = v['n'] >= 30 and len(events[k]) >= 10 and v['G'] >= 3 and (v['lo'] or -1) > 0
    miss = []
    if v['n'] < 30: miss.append('%d/30 closed' % v['n'])
    if len(events[k]) < 10: miss.append('%d/10 events' % len(events[k]))
    if v['G'] < 3: miss.append('%d/3 days' % v['G'])
    if (v['lo'] or -1) <= 0: miss.append('lower bound %s' % ('%.2f' % v['lo'] if v['lo'] is not None else 'n/a'))
    print('   %-22s %s' % (k, 'ELIGIBLE' if ok else 'blocked: ' + ', '.join(miss)))
print('\n  open positions:', len(I.get('positions', [])), '| resting orders:', len(I.get('orders', [])), '| arms with no trade at all:',
      [s for s in ('dutch', 'implication', 'spot-first', 'convergence', 'news', 'market-conditioned', 'political-favorite') if s not in arms])
