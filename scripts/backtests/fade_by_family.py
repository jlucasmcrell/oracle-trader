"""Where does fade make and lose its money? Venue-settled P&L by market family and by hours left at entry.

    python scripts/backtests/fade_by_family.py [--dump tmp/kalshi-2026-09-20.json]

The favourite-longshot bias fade trades was measured on 4.8M historical politics trades (REVIEW-CHANGES item 79:
favourites at 85-94c with >= 6 h to close earned +3.6c and +8.2c after fees in the two halves). Fade itself buys
favourites at 89-98c across every category, and the sample that stopped it on 2026-09-22 sits on two days of
correlated crypto-daily losses. This splits fade's own settled record the same way the historical finding is split.

Entries: every `kind:"entry", strategy:"fade"` row in %APPDATA%/oracle-trader/episodes/kalshi-*.jsonl (the episode
file can under-record, so coverage is printed). P&L: the venue settlement dump, per market, the same formula as
scripts/venue-pnl.py. A market only counts once and only if fade entered it. Read-only, no network.
"""
import argparse, collections, glob, json, math, os, re

ap = argparse.ArgumentParser()
ap.add_argument('--dump', default='G:/PROJECTS/oracle-trader/tmp/kalshi-2026-09-20.json')
a = ap.parse_args()
A = os.path.join(os.environ.get('APPDATA', ''), 'oracle-trader')


def f(x):
    try:
        return float(x)
    except Exception:
        return 0.0


entries = {}
for p in sorted(glob.glob(os.path.join(A, 'episodes', 'kalshi-*.jsonl'))):
    for line in open(p, encoding='utf-8', errors='replace'):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get('kind') == 'entry' and r.get('strategy') == 'fade' and r.get('marketId'):
            entries.setdefault(r['marketId'], r)   # first entry per market

S = {(s.get('ticker') or s.get('market_ticker')): s for s in json.load(open(a.dump, encoding='utf-8'))['settlements']}


def family(t):
    s = t.split('-')[0]
    if re.match(r'^KX(BTC|ETH|SOL|XRP|DOGE|BNB|HYPE|ZEC)D$', s):
        return 'crypto daily'
    if re.match(r'^KX(BTC|ETH|SOL|XRP|DOGE|BNB|HYPE|ZEC)(W|MAXY|MINY|MAX|MIN)?$', s):
        return 'crypto range/other'
    if re.match(r'^KX(WTI|BRENT|NATGAS|COPPER|GOLD|SILVER|CORN|WHEAT|SOY)', s):
        return 'commodities'
    if re.match(r'^KX(EURUSD|USDJPY|GBPUSD|USDCAD|AUDUSD|DXY)', s):
        return 'fx'
    if re.match(r'^KX(INX|NASDAQ|SPX|DJI|RUT|VIX)', s):
        return 'equity index'
    if re.match(r'^KX(HIGH|LOW|RAIN|SNOW|TEMP)', s):
        return 'weather'
    if re.match(r'^KX(TRUMP|APPROVE|PRES|SENATE|HOUSE|GOV|ELECT|CABINET|POTUS|SCOTUS|FED|EO|TARIFF|GOVT|SHUTDOWN|MAYOR|POLL)', s):
        return 'politics/government'
    if re.match(r'^KX(CPI|PCE|GDP|NFP|JOBS|UNEMP|PPI|FOMC|RATE|SOFR|TNOTE|MORTGAGE|RETAIL|CLAIMS|U3)', s):
        return 'economics'
    if re.search(r'GAME|MATCH|TOTAL|SPREAD|WIN|NFL|NBA|MLB|NHL|NCAA|ATP|WTA|EPL|UCL|MLS|UFC|F1|PGA', s):
        return 'sports'
    return 'other'


rows = []
for t, e in entries.items():
    s = S.get(t)
    if not s:
        continue
    y, n = f(s.get('yes_count_fp') or s.get('yes_count')), f(s.get('no_count_fp') or s.get('no_count'))
    pnl = f(s.get('revenue')) / 100 + min(y, n) - f(s.get('yes_total_cost_dollars')) - f(s.get('no_total_cost_dollars')) - f(s.get('fee_cost'))
    ctr = abs(y - n) if abs(y - n) > 0.005 else max(y, n)
    st_iso = s.get('settled_time') or ''
    from datetime import datetime
    settled = datetime.fromisoformat(st_iso.replace('Z', '+00:00')).timestamp() * 1000 if st_iso else None
    hours = (settled - e['ts']) / 3.6e6 if settled else None
    rows.append({'t': t, 'fam': family(t), 'pnl': pnl, 'ctr': ctr, 'win': f(s.get('revenue')) > 0, 'px': e.get('entryPrice'),
                 'hours': hours, 'day': st_iso[:10]})

print('fade entries in the episode logs: %d markets; settled in the dump: %d; the ledger counts 314 fade trades lifetime'
      % (len(entries), len(rows)))


def band(xs):
    if not xs:
        return '-'
    d = collections.defaultdict(float)
    for r in xs:
        d[r['day']] += r['pnl']
    n, tot = len(xs), sum(r['pnl'] for r in xs)
    g = len(d)
    m = tot / g
    se = (math.sqrt(sum((v - m) ** 2 for v in d.values()) / (g - 1)) * math.sqrt(g)) if g > 1 else float('nan')
    ctr = sum(r['ctr'] for r in xs)
    return '$%+7.2f on %4d mkts (%5.1f ct, %+5.1fc/ct)  day-clustered 95%% [$%+.2f, $%+.2f]  win %3.0f%%  days %d' % (
        tot, n, ctr, 100 * tot / ctr if ctr else 0, tot - 1.96 * se, tot + 1.96 * se, 100 * sum(r['win'] for r in xs) / n, g)


print('\nBY MARKET FAMILY')
for fam in sorted({r['fam'] for r in rows}, key=lambda k: sum(r['pnl'] for r in rows if r['fam'] == k)):
    print('   %-20s %s' % (fam, band([r for r in rows if r['fam'] == fam])))
print('\nBY HOURS FROM ENTRY TO SETTLEMENT')
for lo, hi, lab in ((0, 6, '< 6 h'), (6, 24, '6-24 h'), (24, 72, '1-3 days'), (72, 1e9, '> 3 days')):
    print('   %-20s %s' % (lab, band([r for r in rows if r['hours'] is not None and lo <= r['hours'] < hi])))
print('\nTHE HISTORICAL FINDING\'S CELL vs EVERYTHING ELSE')
cell = [r for r in rows if r['fam'] == 'politics/government' and r['hours'] is not None and r['hours'] >= 6]
print('   politics, >= 6 h     %s' % band(cell))
print('   everything else      %s' % band([r for r in rows if r not in cell]))
print('   all fade             %s' % band(rows))
