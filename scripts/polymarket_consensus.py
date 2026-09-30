#!/usr/bin/env python
"""Polymarket smart-money consensus shadow (build-queue item 13). Read-only, public data, no orders.

Polymarket wallets are public with timestamps. The top-50 all-time and top-50 30-day profit
wallets are polled hourly; when >= 3 distinct top wallets buy the same outcome of the same
market within 48 hours (and same-side buyers outnumber opposite-side buyers), a signal is logged
with the Polymarket price at that moment and the matching Kalshi / Polymarket US market price
where a match exists. Signals are graded on Polymarket's own resolution: Brier versus the price,
and the counterfactual P&L of buying the consensus side at the Polymarket price and, when
matched, at the Kalshi ask net of the Kalshi taker fee. Trigger to go live (docs/BACKLOG.md
item 13): >= 100 graded signals, net positive after fees at the price we could have acted on.

  python scripts/polymarket_consensus.py           # one hourly pass
  python scripts/polymarket_consensus.py report    # results to date
  python scripts/polymarket_consensus.py grade     # grade settled signals only (no wallet poll)
  python scripts/polymarket_consensus.py repair    # de-duplicate the journals, rebuild state.json
  python scripts/polymarket_consensus.py selftest  # pure assertions, no network
Data: data/polymarket-consensus/{wallets.json,trades.jsonl,signals.jsonl,grades.jsonl,state.json,run.log}
"""
import collections
import datetime as dt
import json
import math
import os
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backtests'))
import bands  # noqa: E402  the one band helper every research script uses

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data', 'polymarket-consensus')
WALLETS = os.path.join(DATA, 'wallets.json')
TRADES = os.path.join(DATA, 'trades.jsonl')
SIGNALS = os.path.join(DATA, 'signals.jsonl')
GRADES = os.path.join(DATA, 'grades.jsonl')
STATE = os.path.join(DATA, 'state.json')
KCACHE = os.path.join(DATA, 'kalshi-catalog.json')
UCACHE = os.path.join(DATA, 'polyus-catalog.json')
LOG = os.path.join(DATA, 'run.log')
LB = 'https://lb-api.polymarket.com/profit?window={w}&limit=50'
TRADES_API = 'https://data-api.polymarket.com/trades?user={w}&limit=100'
# Gamma's /markets defaults to open markets only: ?slug=<closed market> returns []. The grader wants
# exactly the closed ones, so it must ask for them (2026-09-12: this is why 0 of 3,381 signals graded).
GAMMA = 'https://gamma-api.polymarket.com/markets?slug={slug}&closed=true'
KALSHI = 'https://api.elections.kalshi.com/trade-api/v2'
POLYUS = 'https://gateway.polymarket.us/v1/markets'
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'}
NOW = dt.datetime.now(dt.timezone.utc)
NOW_TS = NOW.timestamp()
WINDOW_H = 48
MIN_WALLETS = 3
MIN_NOTIONAL = 500.0
# The Windows task is killed at 45 minutes; the wallet poll and the two catalogues take about 4 of them.
# Grading stops here so the pass always reaches save_state, which is what makes the cursor advance.
GRADE_BUDGET_S = 20 * 60
STOP = set('the a an of to in on at for and or vs v by with will be is are was were do does did who what which than over under before after this that these those from into its it their his her not no yes win wins won game match'.split())
os.makedirs(DATA, exist_ok=True)


def log(msg):
    line = f'[{dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}] {msg}'
    print(line)
    with open(LOG, 'a', encoding='utf-8') as fh:
        fh.write(line + '\n')


def get_json(url, timeout=60, retries=3):
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return json.loads(r.read().decode('utf-8', 'replace'))
        except Exception:  # noqa: BLE001
            if attempt == retries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))
    return None


def load_json(path, dflt):
    try:
        return json.load(open(path, encoding='utf-8'))
    except Exception:  # noqa: BLE001
        return dflt


def save_state(state):
    """Atomic: a killed pass must never leave a half-written state.json behind.

    2026-09-21 it did. `open(STATE, 'w')` truncates a 180 MB file before json.dump refills it, the task's
    45-minute ExecutionTimeLimit landed inside that write, and the result parsed as
    'Invalid control character at char 105906176'. load_json then swallowed the error and returned {} on
    every later pass, so `recent`, `signaled` and `graded` all restarted empty every hour and the three
    journals took a duplicate copy of themselves an hour for nine days (BACKLOG 248/250).
    """
    tmp = STATE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(state, fh)
    os.replace(tmp, STATE)


def rebuild_state():
    """The journals are the record; state.json is only a cursor over them. Rebuild it from the files.

    Called when state.json is missing or unreadable, so a lost cursor costs one slow pass instead of a
    duplicate copy of every journal. Each index is keyed exactly as the writer that consumes it keys it:
    `signaled` and `graded` on '<conditionId>:<outcome>', `recent` on the trade key inside the 72 h window.
    """
    state = {}
    sig_cid = {}
    signaled = {}
    for s in read_jsonl(SIGNALS):
        cid, outcome = s.get('conditionId'), s.get('outcome')
        if not cid or outcome is None:
            continue
        key = f'{cid}:{outcome}'
        try:
            ts = dt.datetime.fromisoformat(s['ts']).timestamp()
        except Exception:  # noqa: BLE001
            continue
        if NOW_TS - ts <= 30 * 86400:          # detect() prunes at 30 days; the rebuild must not undo that
            signaled[key] = max(signaled.get(key, 0), ts)
        sig_cid[(s['ts'], s.get('title'), outcome)] = cid
    graded = {}
    for g in read_jsonl(GRADES):
        cid = g.get('conditionId') or sig_cid.get((g.get('ts'), g.get('title'), g.get('outcome')))
        if cid and g.get('outcome') is not None:
            graded[f'{cid}:{g["outcome"]}'] = g.get('winner')
    recent, keys = [], set()
    for t in stream_jsonl(TRADES):
        if not t.get('key') or NOW_TS - t.get('ts', 0) >= 72 * 3600 or t['key'] in keys:
            continue
        keys.add(t['key'])
        recent.append(t)
    state['signaled'] = signaled
    state['graded'] = graded
    state['recent'] = recent
    log(f'state.json unreadable or absent; rebuilt from the journals: {len(signaled)} signalled, {len(graded)} graded, {len(recent)} trades in the 72 h window')
    return state


def load_state():
    if os.path.exists(STATE):
        try:
            return json.load(open(STATE, encoding='utf-8'))
        except Exception as e:  # noqa: BLE001
            log(f'state.json will not parse ({str(e)[:80]}); rebuilding')
    return rebuild_state()


def append(path, row):
    with open(path, 'a', encoding='utf-8') as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + '\n')


def stream_jsonl(path):
    """Line at a time: trades.jsonl reached 2.5 GB under the duplication and must not be held in memory."""
    if not os.path.exists(path):
        return
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:  # noqa: BLE001
                pass


def read_jsonl(path):
    return list(stream_jsonl(path))


# ------------------------------------------------------------------ wallets and trades
LB2 = 'https://data-api.polymarket.com/v1/leaderboard?category={c}&timePeriod={p}&orderBy=PNL&limit=50'
LB_CATEGORIES = ('OVERALL', 'SPORTS', 'POLITICS', 'CRYPTO', 'WEATHER', 'ECONOMICS', 'FINANCE')
LB_PERIODS = ('MONTH', 'ALL')


def refresh_wallets(state):
    """Top-50 wallets by profit per category and period (data-api /v1/leaderboard, found via pmxt's
    examples 2026-09-08): a politics whale who never touches sports is invisible on the overall board.
    Keeps the trader's X handle when the venue exposes one. Falls back to lb-api if the data API fails."""
    w = load_json(WALLETS, {})
    if w.get('at') and NOW_TS - w['at'] < 20 * 3600 and w.get('wallets'):
        return w['wallets']
    wallets = {}
    for cat in LB_CATEGORIES:
        for period in LB_PERIODS:
            try:
                rows = get_json(LB2.format(c=cat, p=period))
                rows = rows if isinstance(rows, list) else rows.get('data', [])
                for r in rows:
                    addr = r.get('proxyWallet')
                    if not addr:
                        continue
                    rec = wallets.setdefault(addr, {'name': r.get('userName') or addr[:10], 'x': r.get('xUsername') or None, 'windows': {}})
                    rec['windows'][f'{cat}:{period}'] = {'rank': int(r.get('rank') or 0), 'profit': round(float(r.get('pnl') or 0))}
                time.sleep(0.2)
            except Exception as e:  # noqa: BLE001
                log(f'leaderboard {cat}/{period} failed: {str(e)[:80]}')
    if len(wallets) < 20:
        for window in ('all', '30d'):
            try:
                for rank, r in enumerate(get_json(LB.format(w=window)), 1):
                    rec = wallets.setdefault(r['proxyWallet'], {'name': r.get('name') or r.get('pseudonym') or r['proxyWallet'][:10], 'x': None, 'windows': {}})
                    rec['windows'][window] = {'rank': rank, 'profit': round(r.get('amount', 0))}
            except Exception as e:  # noqa: BLE001
                log(f'leaderboard {window} failed: {e}')
    if wallets:
        json.dump({'at': NOW_TS, 'wallets': wallets}, open(WALLETS, 'w', encoding='utf-8'), indent=1)
        log(f'wallet set refreshed: {len(wallets)} wallets')
        return wallets
    return w.get('wallets', {})


def poll_trades(wallets, state):
    seen = state.setdefault('seen', {})
    recent = [t for t in state.get('recent', []) if NOW_TS - t['ts'] < 72 * 3600]
    keyset = {t['key'] for t in recent}
    new = 0
    for addr, rec in wallets.items():
        try:
            rows = get_json(TRADES_API.format(w=addr))
        except Exception as e:  # noqa: BLE001
            log(f'trades {rec["name"]} failed: {str(e)[:80]}')
            continue
        for r in rows:
            ts = r.get('timestamp', 0)
            if NOW_TS - ts > 72 * 3600:
                continue
            key = f"{r.get('transactionHash', '')}:{r.get('asset', '')}:{addr}"
            if key in keyset:
                continue
            t = {
                'key': key, 'ts': ts, 'wallet': addr, 'name': rec['name'], 'side': r.get('side'), 'outcome': r.get('outcome'),
                'outcomeIndex': r.get('outcomeIndex'), 'conditionId': r.get('conditionId'), 'title': r.get('title'), 'slug': r.get('slug'),
                'eventSlug': r.get('eventSlug'), 'price': r.get('price'), 'size': r.get('size')
            }
            recent.append(t)
            keyset.add(key)
            append(TRADES, t)
            new += 1
        time.sleep(0.2)
    state['recent'] = recent
    log(f'polled {len(wallets)} wallets: {new} new trades, {len(recent)} in the 72 h window')
    return recent


# ------------------------------------------------------------------ matching
def tokens(s):
    return {w for w in re.findall(r'[a-z0-9]+', (s or '').lower()) if len(w) >= 3 and w not in STOP}


def kalshi_catalog():
    c = load_json(KCACHE, {})
    if c.get('at') and NOW_TS - c['at'] < 6 * 3600 and c.get('events'):
        return c['events']
    evs, cur = [], ''
    try:
        for _ in range(80):
            d = get_json(f'{KALSHI}/events?status=open&limit=200&with_nested_markets=true' + (f'&cursor={cur}' if cur else ''))
            for e in d.get('events', []):
                evs.append({
                    'ticker': e.get('event_ticker'), 'title': e.get('title'), 'category': e.get('category'),
                    'markets': [{'ticker': m.get('ticker'), 'sub': m.get('yes_sub_title') or m.get('title'), 'yes_bid': fdollar(m, 'yes_bid'), 'yes_ask': fdollar(m, 'yes_ask'), 'close': m.get('close_time')} for m in (e.get('markets') or [])]
                })
            cur = d.get('cursor') or ''
            if not cur or not d.get('events'):
                break
            time.sleep(0.15)
        json.dump({'at': NOW_TS, 'events': evs}, open(KCACHE, 'w', encoding='utf-8'))
        log(f'kalshi catalog refreshed: {len(evs)} open events')
    except Exception as e:  # noqa: BLE001
        log(f'kalshi catalog failed: {e}')
        evs = c.get('events', [])
    return evs


def fdollar(m, key):
    v = m.get(key + '_dollars')
    try:
        if v not in (None, ''):
            return float(v)
        v = m.get(key)
        if v in (None, ''):
            return None
        f = float(v)
        return f / 100 if f > 1 else f
    except ValueError:
        return None


def polyus_catalog():
    c = load_json(UCACHE, {})
    if c.get('at') and NOW_TS - c['at'] < 6 * 3600 and c.get('markets'):
        return c['markets']
    out = []
    try:
        for offset in range(0, 1000, 100):
            q = urllib.parse.urlencode({'limit': 100, 'offset': offset, 'closed': 'false', 'orderBy': 'volume', 'orderDirection': 'desc', 'endDateMin': NOW.strftime('%Y-%m-%dT%H:%M:%SZ')})
            ms = get_json(f'{POLYUS}?{q}').get('markets') or []
            for m in ms:
                sides = m.get('marketSides') or []
                long_side = next((s for s in sides if s and s.get('long')), None)
                out.append({'slug': m.get('slug'), 'question': m.get('question'), 'title': m.get('title'), 'type': m.get('marketType'), 'price': float(long_side['price']) if long_side and long_side.get('price') not in (None, '') else None, 'endDate': m.get('endDate'), 'gameStartTime': m.get('gameStartTime')})
            if len(ms) < 100:
                break
            time.sleep(0.2)
        json.dump({'at': NOW_TS, 'markets': out}, open(UCACHE, 'w', encoding='utf-8'))
        log(f'polymarket us catalog refreshed: {len(out)} markets')
    except Exception as e:  # noqa: BLE001
        log(f'polymarket us catalog failed: {e}')
        out = c.get('markets', [])
    return out


class Matcher:
    def __init__(self, docs):
        """docs: [(id, text, payload)]; IDF over the catalog, accept score >= 0.6 with >= 2 shared rare tokens."""
        self.docs = [(i, tokens(t), p) for i, t, p in docs]
        df = collections.Counter()
        for _, tk, _ in self.docs:
            df.update(tk)
        n = max(1, len(self.docs))
        self.idf = {w: math.log((n + 1) / (c + 1)) + 1 for w, c in df.items()}

    def best(self, text):
        q = tokens(text)
        qw = sum(self.idf.get(w, 3.0) for w in q) or 1.0
        best = None
        for i, tk, p in self.docs:
            shared = [w for w in q if w in tk and self.idf.get(w, 0) > 1.0]
            if len(shared) < 2:
                continue
            score = sum(self.idf[w] for w in shared) / qw
            if score >= 0.6 and (best is None or score > best[0]):
                best = (score, i, p, shared)
        return best


MONTHS = {m: i for i, m in enumerate(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], 1)}
DERIVATIVE = re.compile(r'TOTAL|SPREAD|MAPS|HANDICAP|CONF|LEAVE|CHAMP|MVP|SERIES|SEASON|WINS\d|OVER|UNDER|PROP|BTTS|RFI|1H|2H|CORNER|CARD', re.I)
# Kalshi winner-type events for fixtures: KXNFLGAME, KXUCLGAME, KXATPMATCH, ... (never BTTS, RFI, TOTAL, SPREAD).
WINNER_EVENT = re.compile(r'GAME|MATCH', re.I)
NO_TWIN_OUTCOMES = {'over', 'under', 'up', 'down'}


def poly_date(sig_slug):
    m = re.search(r'(20\d\d)-(\d\d)-(\d\d)', sig_slug or '')
    return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def kalshi_date(ticker):
    m = re.search(r'-(\d\d)([A-Z]{3})(\d\d)', ticker or '')
    if not m or m.group(2) not in MONTHS:
        return None
    return dt.date(2000 + int(m.group(1)), MONTHS[m.group(2)], int(m.group(3)))


def dates_agree(a, b):
    return a is None or b is None or abs((a - b).days) <= 1


def is_derivative_title(title):
    return bool(re.search(r'spread|total|o/u|over/under|handicap|maps', title or '', re.I))


def match_kalshi(matcher, title, outcome, slug):
    """Best Kalshi event that names the same fixture on the same date, with the winner-type market for the outcome."""
    oc = (outcome or '').strip().lower()
    # Totals and 15-minute direction signals have no match-level Kalshi twin; matching them by fixture name
    # produced "both teams to score" and first-inning markets (2026-09-19, external review).
    if oc in NO_TWIN_OUTCOMES:
        return None
    q = tokens(f'{title} {outcome}')
    qw = sum(matcher.idf.get(w, 3.0) for w in q) or 1.0
    pdate = poly_date(slug)
    derivative_ok = is_derivative_title(title)
    is_game = ' vs' in (title or '').lower() or bool(re.search(r'\bwin on \d{4}-\d{2}-\d{2}', title or '', re.I)) or bool(re.search(r'end in a (draw|tie)', title or '', re.I))
    yes_no = oc in ('yes', 'no')
    # Every discriminating token of a non-game question must be in the Kalshi event: "Will Harry Kane win the
    # Ballon d'Or?" shared "harry kane 2026" with "Will Harry Kane be knighted?" and matched it.
    need = set() if is_game else {w for w in tokens(title) if matcher.idf.get(w, 0) > 1.0 and w not in ('win', 'wins', 'winner')}
    # A per-map / per-set / per-half market has no Kalshi twin at the match level.
    if re.search(r'\b(game|map|set|half|quarter|period)\s*\d', title or '', re.I) or re.search(r'\b1st\b|\b2nd\b', title or ''):
        return None
    cands = []
    for ticker, tk, ev in matcher.docs:
        shared = [w for w in q if w in tk and matcher.idf.get(w, 0) > 1.0]
        if len(shared) < 2:
            continue
        score = sum(matcher.idf[w] for w in shared) / qw
        if score < 0.6:
            continue
        if not derivative_ok and DERIVATIVE.search(ticker):
            continue
        kdate = kalshi_date(ticker)
        # A game lives in a dated Kalshi event; an undated ticker is a season/tournament market
        # that merely lists the same teams (2026-09-08: SMU vs Florida State matched the ACC winner).
        if is_game and kdate is None:
            continue
        if not dates_agree(pdate, kdate):
            continue
        # A game signal only ever maps to a winner event (Kalshi's GAME/MATCH series); a fixture name also
        # matches its BTTS, totals, spread and first-inning events, which are not the same bet.
        if is_game and not WINNER_EVENT.search(ticker):
            continue
        if need and not need <= tk:
            continue
        # A game signal needs BOTH fixture names in the Kalshi event, not one team plus a stray word
        # (2026-09-08: Diamondbacks vs Royals matched an NWSL event through "Kansas City").
        if ' vs' in (title or '').lower():
            a, _, b = re.sub(r'^[^:]*:\s*', '', title).lower().partition(' vs')
            ta = {w for w in tokens(a) if matcher.idf.get(w, 0) > 1.0}
            tb = {w for w in tokens(b) if matcher.idf.get(w, 0) > 1.0}
            if (ta and not ta & tk) or (tb and not tb & tk):
                continue
        cands.append((score, ticker, ev, shared))
    if not cands:
        return None
    # Which market inside the event, and which side of it. A Yes/No answer to "Will <team> win ...?" names the
    # team in the TITLE, not the outcome; a draw question names the Tie market; otherwise the outcome is the
    # team. 'No' is NO on that market. There is no single-market fallback any more: it is what matched
    # knighthood and both-teams-to-score markets (2026-09-19).
    if yes_no:
        if re.search(r'end in a (draw|tie)', title or '', re.I):
            want = {'tie', 'draw'}
        else:
            subject = re.sub(r'^\s*will\s+', '', title or '', flags=re.I)
            subject = re.split(r'\s+win\b|\s+vs\.?\s|\?', subject, 1)[0]
            want = {w for w in tokens(subject) if matcher.idf.get(w, 0) > 1.0} or tokens(subject)
    else:
        want = {w for w in tokens(outcome) if matcher.idf.get(w, 0) > 1.0} or tokens(outcome)
    side = 'NO' if oc == 'no' else 'YES'
    best = None
    for score, ticker, ev, shared in cands:
        # The winner market for the signalled side is the one whose sub-title overlaps the wanted tokens
        # the most, and strictly more than any other (IG vs LGD both carry "Gaming").
        overl = sorted(((len(want & tokens(m['sub'])), m) for m in ev['markets']), key=lambda x: -x[0])
        if not (overl and overl[0][0] > 0 and (len(overl) == 1 or overl[0][0] > overl[1][0])):
            continue
        mk = overl[0][1]
        if best is None or score > best[0]:
            best = (score, ticker, mk, shared)
    if best is None:
        return None
    score, ticker, mk, shared = best
    return {'event': ticker, 'score': round(score, 3), 'shared': shared, 'market': mk['ticker'], 'side': side, 'yes_bid': mk['yes_bid'], 'yes_ask': mk['yes_ask']}


def match_polyus(matcher, title, outcome, slug):
    if re.search(r'\b(game|map|set|half|quarter|period)\s*\d', title or '', re.I) or re.search(r'\b1st\b|\b2nd\b', title or ''):
        return None
    b = matcher.best(f'{title} {outcome}')
    if not b:
        return None
    score, uslug, m, shared = b
    if ' vs' in (title or '').lower() and (m.get('type') == 'futures' or (len(shared) < 3 and score < 0.85)):
        return None
    if not dates_agree(poly_date(slug), poly_date(uslug)):
        return None
    return {'slug': uslug, 'score': round(score, 3), 'shared': shared, 'price': m['price'], 'type': m['type']}


# ------------------------------------------------------------------ signals
def detect(recent, state, kmatcher, umatcher):
    cut = NOW_TS - WINDOW_H * 3600
    buys = collections.defaultdict(dict)   # (conditionId) -> outcome -> {wallet: [trades]}
    for t in recent:
        if t['ts'] < cut or t.get('side') != 'BUY' or not t.get('conditionId'):
            continue
        buys[t['conditionId']].setdefault(t.get('outcome'), {}).setdefault(t['wallet'], []).append(t)
    signaled = state.setdefault('signaled', {})
    new = 0
    for cid, by_outcome in buys.items():
        for outcome, by_wallet in by_outcome.items():
            key = f'{cid}:{outcome}'
            if key in signaled:
                continue
            n_same = len(by_wallet)
            n_opp = max([len(w) for o, w in by_outcome.items() if o != outcome] or [0])
            trades = [x for ws in by_wallet.values() for x in ws]
            notional = sum(float(x.get('size') or 0) * float(x.get('price') or 0) for x in trades)
            if n_same < MIN_WALLETS or n_same <= n_opp or notional < MIN_NOTIONAL:
                continue
            trades.sort(key=lambda x: x['ts'])
            last = trades[-1]
            sig = {
                'ts': NOW.isoformat(timespec='seconds'), 'conditionId': cid, 'title': last.get('title'), 'slug': last.get('slug'), 'eventSlug': last.get('eventSlug'),
                'outcome': outcome, 'wallets': sorted({x['name'] for x in trades}), 'n_wallets': n_same, 'n_opposite': n_opp,
                'notional': round(notional, 2), 'first_ts': trades[0]['ts'], 'last_ts': last['ts'], 'poly_price': last.get('price'),
                'kalshi': match_kalshi(kmatcher, last.get('title'), outcome, last.get('eventSlug') or last.get('slug')) if kmatcher else None,
                'polyus': match_polyus(umatcher, last.get('title'), outcome, last.get('eventSlug') or last.get('slug')) if umatcher else None
            }
            append(SIGNALS, sig)
            signaled[key] = NOW_TS
            new += 1
    for k in list(signaled):
        if NOW_TS - signaled[k] > 30 * 86400:
            del signaled[k]
    log(f'signals: {new} new')


def kalshi_fee(p):
    return 0.07 * p * (1 - p)


def resolved_winner(m):
    """(winner, None) once a Gamma market has settled, else (None, reason). Pure; see selftest()."""
    try:
        outcomes = json.loads(m.get('outcomes') or '[]')
        prices = [float(x) for x in json.loads(m.get('outcomePrices') or '[]')]
    except Exception:  # noqa: BLE001
        return None, 'bad-outcomes'
    if not outcomes or not prices or max(prices) < 0.99:
        return None, 'not-resolved'
    return outcomes[prices.index(max(prices))], None


def grade(state):
    sigs = read_jsonl(SIGNALS)
    graded = state.setdefault('graded', {})
    n = 0
    skip = collections.Counter()
    deadline = time.time() + GRADE_BUDGET_S
    for s in sigs:
        if time.time() > deadline:
            # The task is killed at 45 minutes (ExecutionTimeLimit PT45M). A grade pass that runs past it
            # never reaches save_state, so the cursor never advances and the next pass repeats the work.
            # Stopping early with the cursor saved is strictly better than a complete pass that is killed.
            skip['budget-spent'] += 1
            continue
        key = f"{s['conditionId']}:{s['outcome']}"
        if key in graded:
            skip['already-graded'] += 1
            continue
        if NOW_TS - dt.datetime.fromisoformat(s['ts']).timestamp() < 3600:
            skip['too-fresh'] += 1
            continue
        if not s.get('slug'):
            skip['no-slug'] += 1
            continue
        try:
            ms = get_json(GAMMA.format(slug=urllib.parse.quote(s['slug'])))
        except Exception as e:  # noqa: BLE001
            log(f'gamma {s["slug"]} failed: {str(e)[:80]}')
            skip['fetch-failed'] += 1
            continue
        m = ms[0] if isinstance(ms, list) and ms else (ms if isinstance(ms, dict) else None)
        if not m:
            skip['not-found'] += 1
            continue
        if not m.get('closed'):
            skip['still-open'] += 1
            continue
        winner, why = resolved_winner(m)
        if winner is None:
            skip[why] += 1
            continue
        y = 1 if winner == s['outcome'] else 0
        p = float(s.get('poly_price') or 0)
        entry = {
            'ts': s['ts'], 'graded_at': NOW.isoformat(timespec='seconds'), 'conditionId': s['conditionId'], 'title': s['title'], 'outcome': s['outcome'], 'winner': winner, 'y': y,
            'n_wallets': s['n_wallets'], 'poly_price': p, 'brier_poly': round((p - y) ** 2, 4), 'pnl_poly': round((1 - p) if y else -p, 4),
            'hours_to_resolution': round((NOW_TS - dt.datetime.fromisoformat(s['ts']).timestamp()) / 3600, 1), 'category': (s.get('eventSlug') or '').split('-')[0]
        }
        k = s.get('kalshi')
        if k and k.get('market') and (k.get('yes_ask') is not None):
            # Priced on the side the wallets took: YES at the YES ask, NO at one minus the YES bid. Rows written
            # before 2026-09-19 carry no side and were matched to markets that were not the same bet; they are
            # not graded on the Kalshi leg at all.
            if k.get('side') == 'NO':
                px = None if k.get('yes_bid') is None else round(1 - k['yes_bid'], 4)
            elif k.get('side') == 'YES':
                px = k['yes_ask']
            else:
                px = None
            if px is not None:
                entry['kalshi_market'] = k['market']
                entry['kalshi_side'] = k['side']
                entry['kalshi_price'] = px
                entry['pnl_kalshi'] = round(((1 - px) if y else -px) - kalshi_fee(px), 4)
        u = s.get('polyus')
        if u and u.get('price') is not None:
            px = u['price']
            entry['polyus_slug'] = u['slug']
            entry['polyus_price'] = px
            entry['pnl_polyus'] = round(((1 - px) if y else -px) - 0.06 * px * (1 - px), 4)
        append(GRADES, entry)
        graded[key] = winner
        n += 1
        time.sleep(0.15)
    log(f'graded {n} signals' + (f' | skipped {dict(sorted(skip.items()))}' if skip else ''))


def dedupe(rows, key):
    """First row per key wins. The journals are append-only and were duplicated for nine days
    (BACKLOG 248: 43x, then 129x); every count printed from them has to be distinct or it is fiction."""
    seen, out = set(), []
    for r in rows:
        k = key(r)
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


def _band(rows, field):
    """Day-clustered 95%, in cents, as docs/PREREGISTERED-polymarket-consensus.md fixes it."""
    return bands.day_band95(rows, lambda r: str(r['ts'])[:10], lambda r: 100.0 * r[field])


def _say(label, rows, field):
    m, lo, hi, g, n = _band(rows, field)
    band = 'no band (1 day-cluster)' if lo is None else f'95% [{lo:+.2f}, {hi:+.2f}] over {g} day-clusters'
    print(f'{label} ({n} matched): {m:+.2f}c/contract, {band}')


def report():
    sig_rows = read_jsonl(SIGNALS)
    grade_rows = read_jsonl(GRADES)
    sigs = dedupe(sig_rows, lambda s: (s.get('conditionId'), s.get('outcome')))
    g = dedupe(grade_rows, lambda x: (x.get('title'), x.get('kalshi_market'), x.get('ts')))
    print(f'signals {len(sigs)} distinct ({len(sig_rows)} rows), matched kalshi {sum(1 for s in sigs if s.get("kalshi"))}, '
          f'matched polymarket us {sum(1 for s in sigs if s.get("polyus"))}, graded {len(g)} distinct ({len(grade_rows)} rows)')
    if not g:
        return
    hit = sum(x['y'] for x in g) / len(g)
    print(f'hit rate {hit:.2f} at mean price {sum(x["poly_price"] for x in g) / len(g):.2f}; Brier {sum(x["brier_poly"] for x in g) / len(g):.4f}')
    _say('P&L at the Polymarket price', g, 'pnl_poly')
    kk = [x for x in g if 'pnl_kalshi' in x]
    if kk:
        _say('P&L at the Kalshi ask net of fee', kk, 'pnl_kalshi')
        # The 2026-09-19 amendment (REVIEW-CHANGES §129) voided the Kalshi leg to date: the old matcher
        # bought YES on any event sharing a fixture name, so a row without `kalshi_side` was graded
        # against a market that was not the same bet. Those rows are the majority and they carry the
        # headline, so the registered cohort is printed beside it and is the only one that may be read.
        live = [x for x in kk if x.get('kalshi_side')]
        _say('  of which post-matcher (kalshi_side present; the registered cohort)', live, 'pnl_kalshi')
        if len(live) < len(kk):
            print(f'  {len(kk) - len(live)} row(s) predate the matcher fix and are VOID for build-queue 13 (PREREGISTERED-polymarket-consensus.md, amendment 2026-09-19)')
    uu = [x for x in g if 'pnl_polyus' in x]
    if uu:
        _say('P&L at the Polymarket US price net of fee', uu, 'pnl_polyus')
    by = collections.defaultdict(list)
    for x in g:
        by[x['category']].append(x)
    for c, xs in sorted(by.items(), key=lambda kv: -len(kv[1])):
        print(f'  {c:12s} n={len(xs):4d} hit={sum(x["y"] for x in xs) / len(xs):.2f} pnl={sum(x["pnl_poly"] for x in xs) / len(xs):+.4f} lead_h={sum(x["hours_to_resolution"] for x in xs) / len(xs):.0f}')


def repair():
    """One-off, re-runnable: de-duplicate the three journals in place and rewrite state.json from them.

    Nine days of passes on an unreadable state.json appended a copy of every trade, signal and grade an
    hour (BACKLOG 248/250). The duplicates carry no information, so dropping them loses nothing, and the
    rebuilt cursor is what stops them coming back. Each file is kept as <name>.dup-<date>.bak until a
    later session is satisfied; nothing is deleted here.
    """
    stamp = NOW.strftime('%Y%m%dT%H%M%SZ')
    for path, key in ((TRADES, lambda r: r.get('key')),
                      (SIGNALS, lambda r: (r.get('conditionId'), r.get('outcome'))),
                      (GRADES, lambda r: (r.get('title'), r.get('kalshi_market'), r.get('ts')))):
        if not os.path.exists(path):
            continue
        before = os.path.getsize(path)
        tmp, seen, kept, rows = path + '.tmp', set(), 0, 0
        with open(tmp, 'w', encoding='utf-8') as fh:
            for r in stream_jsonl(path):
                rows += 1
                k = key(r)
                if k in seen:
                    continue
                seen.add(k)
                kept += 1
                fh.write(json.dumps(r, ensure_ascii=False) + '\n')
        os.replace(path, f'{path}.dup-{stamp}.bak')
        os.replace(tmp, path)
        log(f'{os.path.basename(path)}: {rows} rows -> {kept} distinct, {before // 1048576} MB -> {os.path.getsize(path) // 1048576} MB')
    if os.path.exists(STATE):
        os.replace(STATE, f'{STATE}.corrupt-{stamp}.bak')
    save_state(rebuild_state())


def selftest():
    fails = []

    def ok(cond, what):
        if not cond:
            fails.append(what)

    # The 2026-09-12 defect: Gamma's /markets hides closed markets unless asked, so a grader that only
    # wants closed markets saw none of them and graded 0 of 3,381 signals for four days.
    ok('closed=true' in GAMMA, 'GAMMA must request closed markets')
    ok(resolved_winner({'outcomes': '["A", "B"]', 'outcomePrices': '["1", "0"]'}) == ('A', None), 'resolved yes')
    ok(resolved_winner({'outcomes': '["A", "B"]', 'outcomePrices': '["0", "1"]'}) == ('B', None), 'resolved no')
    ok(resolved_winner({'outcomes': '["A", "B"]', 'outcomePrices': '["0.6", "0.4"]'})[1] == 'not-resolved', 'open market')
    ok(resolved_winner({'outcomes': '[]', 'outcomePrices': '[]'})[1] == 'not-resolved', 'empty market')
    ok(resolved_winner({'outcomes': 'not json', 'outcomePrices': None})[1] == 'bad-outcomes', 'garbage market')

    # BACKLOG 248/250: the journals were duplicated for nine days, so nothing may be counted raw again.
    dup = [{'title': 'A', 'kalshi_market': 'K1', 'ts': '2026-09-20T00:00:00', 'y': 1},
           {'title': 'A', 'kalshi_market': 'K1', 'ts': '2026-09-20T00:00:00', 'y': 1},
           {'title': 'A', 'kalshi_market': 'K2', 'ts': '2026-09-20T00:00:00', 'y': 0}]
    ok(len(dedupe(dup, lambda x: (x['title'], x['kalshi_market'], x['ts']))) == 2, 'dedupe keeps one row per key')
    ok(dedupe(dup, lambda x: (x['title'], x['kalshi_market'], x['ts']))[0] is dup[0], 'dedupe keeps the first row')
    ok(len(dedupe([], lambda x: x)) == 0, 'dedupe of nothing')

    # A duplicated row must not narrow the band: it is the same day and the same value, so it can only
    # shrink an i.i.d. interval and cannot shrink a day-clustered one.
    one = [{'ts': '2026-09-2%dT00:00:00' % d, 'v': v} for d, v in ((0, 0.10), (1, -0.05), (2, 0.02), (3, 0.08), (4, -0.01))]
    m1, lo1, hi1, g1, n1 = bands.day_band95(one, lambda r: r['ts'][:10], lambda r: 100.0 * r['v'])
    m2, lo2, hi2, g2, n2 = bands.day_band95(one + one, lambda r: r['ts'][:10], lambda r: 100.0 * r['v'])
    ok(g1 == 5 and n1 == 5, 'five rows on five days cluster as five')
    ok(abs(m1 - m2) < 1e-9 and abs(lo1 - lo2) < 1e-9 and abs(hi1 - hi2) < 1e-9, 'duplicating every row cannot move a day-clustered band')
    ok(lo1 is not None and lo1 < m1 < hi1, 'the band brackets its mean')
    ok(bands.day_band95(one[:1], lambda r: r['ts'][:10], lambda r: r['v'])[1] is None, 'one day-cluster has no band')
    ok(bands.t975(4) == 2.776 and bands.t975(1000) == 1.960, 'the 95% quantile is Student t on G-1')

    # 2026-09-21: the state write was truncate-in-place and a kill inside it cost nine days of duplication.
    # save_state must leave no .tmp behind, and an interrupted write must leave the previous state intact.
    global STATE
    keep = STATE
    try:
        with tempfile.TemporaryDirectory() as d:
            STATE = os.path.join(d, 'state.json')
            def state_now():
                """Closed read: an open handle blocks the temp dir's cleanup on Windows, and a corrupt
                file must report as a failed assertion rather than a traceback."""
                try:
                    with open(STATE, encoding='utf-8') as fh:
                        return json.load(fh)
                except Exception:  # noqa: BLE001
                    return None

            save_state({'graded': {'c:Yes': 'Yes'}})
            ok(state_now() == {'graded': {'c:Yes': 'Yes'}}, 'save_state round-trips')
            ok(not os.path.exists(STATE + '.tmp'), 'save_state leaves no temp file')
            try:
                save_state({'bad': {1, 2}})                      # a set is not JSON: the dump dies mid-write
            except TypeError:
                pass
            ok(state_now() == {'graded': {'c:Yes': 'Yes'}}, 'a failed write leaves the old state readable')
    finally:
        STATE = keep
    ok(GRADE_BUDGET_S < 41 * 60, 'the grade budget leaves room inside the 45-minute task limit')
    total = 6 + 11
    print(f'selftest: {total - len(fails)} passed, {len(fails)} failed' + (f' -> {fails}' if fails else ''))
    return 1 if fails else 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'report':
        report()
        return
    if len(sys.argv) > 1 and sys.argv[1] == 'selftest':
        sys.exit(selftest())
    if len(sys.argv) > 1 and sys.argv[1] == 'grade':
        state = load_state()
        grade(state)
        save_state(state)
        return
    if len(sys.argv) > 1 and sys.argv[1] == 'repair':
        repair()
        return
    state = load_state()
    try:
        wallets = refresh_wallets(state)
        recent = poll_trades(wallets, state)
        kev = kalshi_catalog()
        kmatcher = Matcher([(e['ticker'], f"{e['title']} " + ' '.join(m['sub'] or '' for m in e['markets'][:12]), e) for e in kev]) if kev else None
        um = polyus_catalog()
        umatcher = Matcher([(m['slug'], f"{m['question']} {m['title']}", m) for m in um if m.get('slug')]) if um else None
        detect(recent, state, kmatcher, umatcher)
    except Exception as e:  # noqa: BLE001
        log(f'pass failed: {e}')
    # Saved before grading as well as after: grading is the long half, and if it is killed the trade and
    # signal cursors must still survive or the next pass re-appends everything it already has.
    save_state(state)
    try:
        grade(state)
    except Exception as e:  # noqa: BLE001
        log(f'grade failed: {e}')
    save_state(state)


if __name__ == '__main__':
    main()
