"""Build-queue 83 / 86 (weekly reading; first run 2026-09-14 from the scratchpad): settlement basis under lead-lag. GET-only, no orders, no keys.

Kalshi KX<COIN>15M settles on the 60 s average of the CF Benchmarks index; Polymarket's
<coin>-updown-15m-<epoch> on Chainlink's 60 s TWAP stream. Same window, different index.
Question: how often do matched windows resolve differently, and did any of OUR windows?

Output: data/leadlag-basis/settlement_basis.json (+ stdout summary). Usage: python scripts/backtests/leadlag_settlement_basis.py [days]
"""
import json, os, sys, time, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta

COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE']
DAYS = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0
K = 'https://api.elections.kalshi.com/trade-api/v2'
G = 'https://gamma-api.polymarket.com'
OUT = 'G:/PROJECTS/oracle-trader/data/leadlag-basis'
os.makedirs(OUT, exist_ok=True)
import glob
# The newest read-only venue dump. The glob was `tmp/k-*.json` until 2026-09-21, which does not match
# `tmp/kalshi-<date>.json` - the name the maintenance session's own fresh dump has been written under since
# 09-19 - so the weekly read silently graded OUR fills against a dump three days stale and lost 172 of them.
# Pass a path explicitly to pin it: `... leadlag_settlement_basis.py 7 tmp/kalshi-2026-09-21.json`.
def newest_dump():
    if len(sys.argv) > 2:
        return sys.argv[2]
    found = glob.glob('G:/PROJECTS/oracle-trader/tmp/k-*.json') + glob.glob('G:/PROJECTS/oracle-trader/tmp/kalshi-*.json')
    if not found:
        raise SystemExit('no venue dump in tmp/; run scripts/readonly-kalshi-dump.cjs first')
    return max(found, key=os.path.getmtime)


DUMP = newest_dump()
print(f'venue dump: {DUMP}', file=sys.stderr)
SINCE = datetime.now(timezone.utc) - timedelta(days=DAYS)


def get(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'oracle-trader-research/1.0'})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:  # noqa
            if i == tries - 1:
                print('GET failed', url, e, file=sys.stderr)
                return None
            time.sleep(1.5 * (i + 1))


def kalshi_settled(coin):
    out, cursor = [], None
    while True:
        q = {'series_ticker': f'KX{coin}15M', 'status': 'settled', 'limit': 200}
        if cursor:
            q['cursor'] = cursor
        d = get(f'{K}/markets?{urllib.parse.urlencode(q)}')
        if not d:
            break
        ms = d.get('markets') or []
        stop = False
        for m in ms:
            ct = datetime.fromisoformat(m['close_time'].replace('Z', '+00:00'))
            if ct < SINCE:
                stop = True
                break
            out.append({
                'ticker': m['ticker'], 'open': m['open_time'], 'close': m['close_time'],
                'result': m.get('result'), 'floor': m.get('floor_strike'), 'exp': m.get('expiration_value'),
            })
        cursor = d.get('cursor')
        if stop or not cursor or not ms:
            break
        time.sleep(0.2)
    return out


def poly_result(coin, epoch):
    d = get(f'{G}/markets?slug={coin.lower()}-updown-15m-{epoch}&closed=true')
    if not d or not isinstance(d, list) or not d:
        return {'status': 'no-market'}
    m = d[0]
    try:
        prices = json.loads(m.get('outcomePrices') or '[]')
        outcomes = json.loads(m.get('outcomes') or '[]')
    except Exception:
        return {'status': 'bad-json'}
    if len(prices) != 2 or outcomes[:1] != ['Up']:
        return {'status': 'odd-shape', 'outcomes': outcomes, 'prices': prices}
    up, down = float(prices[0]), float(prices[1])
    firm = bool(m.get('closed')) or (m.get('umaResolutionStatus') == 'resolved')
    if up >= 0.999 and down <= 0.001:
        res = 'yes'
    elif down >= 0.999 and up <= 0.001:
        res = 'no'
    else:
        return {'status': 'unresolved', 'up': up, 'closed': m.get('closed'), 'uma': m.get('umaResolutionStatus')}
    return {'status': 'firm' if firm else 'priced', 'result': res, 'up': up, 'closed': m.get('closed'),
            'uma': m.get('umaResolutionStatus')}


def main():
    dump = json.load(open(DUMP, encoding='utf-8'))
    ours = {}
    for s in dump.get('settlements', []):
        t = s.get('ticker', '')
        if '15M-' in t:
            ours[t] = s
    print(f'our settled 15M tickers in dump: {len(ours)}')

    rows, agree, disagree, unresolved, nomarket = [], 0, 0, 0, 0
    per_coin = {}
    for coin in COINS:
        ks = kalshi_settled(coin)
        print(f'{coin}: {len(ks)} settled Kalshi windows in the last {DAYS:g} days', flush=True)
        c = per_coin.setdefault(coin, {'n': 0, 'agree': 0, 'disagree': 0, 'unresolved': 0, 'nomarket': 0})
        for m in ks:
            if m['result'] not in ('yes', 'no'):
                continue
            epoch = int(datetime.fromisoformat(m['open'].replace('Z', '+00:00')).timestamp())
            p = poly_result(coin, epoch)
            time.sleep(0.12)
            row = {'coin': coin, 'ticker': m['ticker'], 'epoch': epoch, 'close': m['close'], 'kalshi': m['result'],
                   'floor': m['floor'], 'exp': m['exp'], 'poly': p, 'ours': m['ticker'] in ours}
            if m['ticker'] in ours:
                o = ours[m['ticker']]
                row['our_settlement'] = {k: o.get(k) for k in ('yes_count_fp', 'no_count_fp', 'yes_total_cost_dollars',
                                                                'no_total_cost_dollars', 'revenue', 'fee_cost', 'market_result')}
            rows.append(row)
            c['n'] += 1
            if p.get('status') in ('firm', 'priced'):
                if p['result'] == m['result']:
                    agree += 1
                    c['agree'] += 1
                else:
                    disagree += 1
                    c['disagree'] += 1
                    row['DISAGREE'] = True
                    print(f"  DISAGREE {coin} {m['ticker']} kalshi={m['result']} poly={p['result']} ({p['status']}) floor={m['floor']} exp={m['exp']}", flush=True)
            elif p.get('status') == 'no-market':
                nomarket += 1
                c['nomarket'] += 1
            else:
                unresolved += 1
                c['unresolved'] += 1
    json.dump({'at': datetime.now(timezone.utc).isoformat(), 'days': DAYS, 'per_coin': per_coin, 'rows': rows},
              open(os.path.join(OUT, 'settlement_basis.json'), 'w'), indent=1)
    n = agree + disagree
    print('\n== SUMMARY ==')
    print(f'matched windows with both results: {n}; agree {agree}; DISAGREE {disagree} ({(disagree / n * 100) if n else 0:.2f}%); '
          f'poly unresolved {unresolved}; poly no-market {nomarket}')
    for coin, c in per_coin.items():
        print(f"  {coin:5s} n={c['n']:4d} agree={c['agree']:4d} disagree={c['disagree']:3d} unresolved={c['unresolved']:3d} nomarket={c['nomarket']:3d}")
    ours_rows = [r for r in rows if r['ours']]
    ours_dis = [r for r in ours_rows if r.get('DISAGREE')]
    print(f'our windows in the sample: {len(ours_rows)}; of which disagreeing: {len(ours_dis)}')
    for r in ours_dis:
        print('  OURS-DISAGREE', r['ticker'], r['kalshi'], r['poly'].get('result'), r.get('our_settlement'))
    # near-boundary population: how close did the index land to the strike?
    near = []
    for r in rows:
        try:
            f, e = float(r['floor']), float(r['exp'])
            if f > 0:
                near.append((abs(e - f) / f * 1e4, r))
        except Exception:
            pass
    near.sort(key=lambda x: x[0])
    print(f'settlement distance from strike (bps), matched windows: n={len(near)}; '
          f'<=1bp: {sum(1 for d, _ in near if d <= 1)}; <=2bp: {sum(1 for d, _ in near if d <= 2)}; <=5bp: {sum(1 for d, _ in near if d <= 5)}')
    dis_bps = [d for d, r in near if r.get('DISAGREE')]
    if dis_bps:
        print('  disagreeing windows landed within (bps):', ', '.join(f'{d:.1f}' for d in sorted(dis_bps)))


if __name__ == '__main__':
    main()
