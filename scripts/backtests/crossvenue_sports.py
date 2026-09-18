"""Kalshi <-> Polymarket US same-game moneylines (backlog 151). Offline, GET-only inputs.

Inputs: tmp/polyus-sports-72h.json (catalog walk; `aec-<sport>-<a>-<b>-<date>` moneylines with outcomes and
prices) and tmp/kalshi-games.json (every open KX*GAME/MATCH market: "<Team> wins" with bid/ask).
Match: same sport, event date within a day, and the Kalshi "X wins" title's team tokens appear in the
Polymarket question ("Who will win ... <Home Team> vs <Away Team> ..."). Prints the overlap and, per matched
team, both venues' YES quotes and the two cross-venue baskets at the ask:
  A = Polymarket YES at ask + Kalshi NO at (1 - Kalshi YES bid)     B = Polymarket NO at (1 - PM YES bid) + Kalshi YES ask
Fees: Polymarket US taker 0.0695 x p(1-p); Kalshi taker 0.07 x p(1-p). Settlement on a game result is identical
across venues by construction (the score), which is what makes this family different from temperature (§119).
"""
import json, re, sys, datetime as dt
from collections import defaultdict

SPORT = {'nfl': 'KXNFLGAME', 'cfb': 'KXNCAAFGAME', 'mlb': 'KXMLBGAME', 'mls': 'KXMLSGAME', 'nba': 'KXNBAGAME', 'nhl': 'KXNHLGAME',
         'epl': 'KXEPLGAME', 'laliga': 'KXLALIGAGAME', 'seriea': 'KXSERIEAGAME', 'bundesliga': 'KXBUNDESLIGAGAME', 'ligue1': 'KXLIGUE1GAME',
         'ucl': 'KXUCLGAME', 'wnba': 'KXWNBAGAME', 'ncaab': 'KXNCAAMBGAME'}
MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
fee = lambda p, c: c * p * (1 - p)
STOP = {'wins', 'the', 'of', 'at', 'vs', 'and', 'st', 'state', 'fc', 'united', 'city'}
tok = lambda s: {t for t in re.findall(r'[a-z]+', s.lower()) if len(t) >= 3 and t not in STOP}

pm = json.load(open('tmp/polyus-sports-72h.json'))['rows']
ka = json.load(open('tmp/kalshi-games.json'))
kevents = defaultdict(list)
for m in ka:
    ser, rest = m['ticker'].split('-', 1)
    d = re.match(r'(\d\d)([A-Z]{3})(\d\d)', rest)
    if not d: continue
    date = dt.date(2000 + int(d.group(1)), MON.index(d.group(2)) + 1, int(d.group(3)))
    kevents[(ser, date)].append(m)

matched = []; seen_pm = 0
for r in pm:
    s = re.match(r'aec-([a-z0-9]+)-', r['slug'])
    if not s or SPORT.get(s.group(1)) is None: continue
    seen_pm += 1
    ser = SPORT[s.group(1)]
    try: gd = dt.datetime.fromisoformat(r['gameStartTime'].replace('Z', '+00:00')).date()
    except Exception: continue
    ql = (r.get('question') or '').lower()
    # Team phrases: "... event <Team A> vs <Team B> scheduled ..." - the venue's outcomes/outcomePrices arrays are NOT
    # aligned with each other; the priced side is marketSides[long=true] (description + price), the other side is 1 - it.
    J = lambda v: json.loads(v) if isinstance(v, str) else (v or [])
    sides = [x for x in J(r.get('marketSides')) if isinstance(x, dict)]
    long = next((x for x in sides if x.get('long') is True and x.get('price') not in (None, '')), None)
    if long is None: continue
    long_name = str(long.get('description') or '').lower(); long_px = float(long['price'])
    mph = re.search(r'event (.+?) vs\.? (.+?)(?: scheduled| on |\?|$)', ql)
    if not mph: continue
    phrases = [mph.group(1).strip(), mph.group(2).strip()]
    for date in (gd, gd - dt.timedelta(days=1), gd + dt.timedelta(days=1)):
        # Event-level match: the Kalshi event's two team titles must map ONE-TO-ONE onto the two Polymarket phrases.
        # A single-team match let "North Dakota" claim the "North Dakota State" phrase of a different game.
        byev = defaultdict(list)
        for m in kevents.get((ser, date), []):
            if m['title'].startswith('Tie'): continue
            byev[m['event_ticker']].append(m)
        for ev, ms in byev.items():
            if len(ms) != 2: continue
            fit = []
            for m in ms:
                kt = tok(m['title'])
                idx = [i for i, p in enumerate(phrases) if kt and kt <= tok(p)]
                # exact-length preference: "north dakota" fits "north dakota state" only if nothing fits better
                if len(idx) == 2: idx = [i for i in idx if kt == tok(phrases[i])] or idx
                fit.append(idx)
            if len(fit[0]) != 1 or len(fit[1]) != 1 or fit[0] == fit[1]: continue
            for m, idx in zip(ms, fit):
                kt = tok(m['title']); ph = phrases[idx[0]]
                side_tok = lambda x: tok(str(x.get('description') or '')) | tok(json.dumps(x.get('team') or {}))
                other = next((x for x in sides if x is not long), None)
                score_long = len(kt & side_tok(long)) + len(tok(ph) & side_tok(long))
                score_other = len(kt & side_tok(other)) + len(tok(ph) & side_tok(other)) if other else 0
                if score_long == score_other: continue
                long_in = score_long > score_other
                pmp = long_px if long_in else 1 - long_px
                team = long.get('description') if long_in else (other or {}).get('description', '?')
                kb, kk = float(m['yes_bid_dollars'] or 0), float(m['yes_ask_dollars'] or 0)
                if not (0.02 <= pmp <= 0.98 and 0.01 <= kk <= 0.99): continue
                bA = pmp + fee(pmp, .0695) + (1 - kb) + fee(1 - kb, .07)
                bB = (1 - pmp) + fee(1 - pmp, .0695) + kk + fee(kk, .07)
                matched.append((r['slug'], str(team), m['ticker'], pmp, kb, kk, (kb + kk) / 2 - pmp, bA, bB))
        if matched and matched[-1][0] == r['slug']: break

print(f'Polymarket US moneylines in mapped sports: {seen_pm} | Kalshi game markets: {len(ka)} | matched team-sides: {len(matched)} across {len({m[0] for m in matched})} games')
by = defaultdict(list)
for m in matched: by[m[2].split("-")[0]].append(m)
for ser, ms in sorted(by.items(), key=lambda kv: -len(kv[1])):
    gaps = [abs(x[6]) for x in ms]
    print(f'  {ser:16s} sides {len(ms):4d}  mean |Kalshi mid - PM price| {100 * sum(gaps) / len(gaps):5.2f}c  baskets < $1: {sum(1 for x in ms if min(x[7], x[8]) < 1.0)}')
print('\nlargest divergences (Kalshi mid - Polymarket price):')
for m in sorted(matched, key=lambda x: -abs(x[6]))[:14]:
    flag = ' <-- basket <$1' if min(m[7], m[8]) < 1.0 else ''
    print(f'  {m[0][:38]:38s} {m[1][:14]:14s} {m[2][:34]:34s} PM {m[3]:.3f}  K {m[4]:.2f}/{m[5]:.2f}  gap {m[6]:+.2f}  A {m[7]:.3f} B {m[8]:.3f}{flag}')
