#!/usr/bin/env python
"""Mention-market base-rate shadow (build-queue item 12). Read-only: no orders, no keys.

Kalshi "mention" markets pay if a speaker says a phrase during an event. The most profitable
public Kalshi traders (Foster, catboyautist, theduckguesses, PredMTrader) say their edge there is
transcript word frequencies plus watching the event. This shadow tests the first half: for every
open mention strike whose speaker has a free transcript corpus, compute the base rate at which
the phrase appeared in comparable past transcripts, log it against the Kalshi price every hour,
and grade both at settlement. Nothing trades until the report shows the base rate beats the
market (docs/BACKLOG.md item 12 trigger: >= 100 graded strikes, Brier better than the price).

Corpora (all free):
  fed    KXFEDMENTION        Federal Reserve press-conference transcripts (PDF, federalreserve.gov)
  press  KXSECPRESSMENTION   White House press briefings, YouTube auto-captions via yt-dlp
  trump  KXTRUMPMENTION      President Trump remarks/speeches, YouTube auto-captions via yt-dlp
  trump-period KXTRUMPSAY*   weekly/monthly aggregates: fraction of recent ISO weeks with a mention
Other speakers are logged as unsupported (coverage is reported, not guessed).

  python scripts/mention_shadow.py            # one hourly pass: refresh corpora, observe, grade
  python scripts/mention_shadow.py report     # Brier and counterfactual P&L to date
  python scripts/mention_shadow.py selftest   # pure assertions, no network
  python scripts/mention_shadow.py regrade    # rebuild grades.jsonl from observations, no network
Data: data/mention-shadow/{observations.jsonl,grades.jsonl,state.json,corpus/,captions/,run.log}
"""
import collections
import datetime as dt
import glob
import io
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data', 'mention-shadow')
CORPUS = os.path.join(DATA, 'corpus')
CAPS = os.path.join(DATA, 'captions')
OBS = os.path.join(DATA, 'observations.jsonl')
GRADES = os.path.join(DATA, 'grades.jsonl')
STATE = os.path.join(DATA, 'state.json')
LOG = os.path.join(DATA, 'run.log')
KALSHI = 'https://api.elections.kalshi.com/trade-api/v2'
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'}
WH_CHANNEL = 'https://www.youtube.com/@WhiteHouse/videos'
NOW = dt.datetime.now(dt.timezone.utc)
FAMILIES = {
    'fed': {'prefixes': ('KXFEDMENTION',), 'n': 12},
    'press': {'prefixes': ('KXSECPRESSMENTION',), 'n': 12, 'title_re': r'press briefing|press secretary', 'exclude_re': r'gaggle'},
    'trump': {'prefixes': ('KXTRUMPMENTION',), 'n': 20, 'title_re': r'president trump|potus', 'exclude_re': r'press briefing|press secretary|first lady|vice president vance'},
    'trump-period': {'prefixes': ('KXTRUMPSAY',), 'weeks': 10, 'title_re': r'president trump|potus', 'exclude_re': r'press briefing|press secretary|first lady|vice president vance'},
}
for d in (DATA, CORPUS, CAPS):
    os.makedirs(d, exist_ok=True)


def log(msg):
    line = f'[{dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}] {msg}'
    print(line)
    with open(LOG, 'a', encoding='utf-8') as fh:
        fh.write(line + '\n')


def get(url, binary=False, timeout=60, retries=3):
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                b = r.read()
                return b if binary else b.decode('utf-8', 'replace')
        except Exception as e:  # noqa: BLE001
            if attempt == retries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))
    return None


def get_json(url):
    return json.loads(get(url))


def load_state():
    try:
        return json.load(open(STATE, encoding='utf-8'))
    except Exception:  # noqa: BLE001
        return {'graded': {}, 'observed': {}, 'videos': {}}


def save_state(state):
    json.dump(state, open(STATE, 'w', encoding='utf-8'), indent=1)


def append(path, row):
    with open(path, 'a', encoding='utf-8') as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + '\n')


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    out = []
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except Exception:  # noqa: BLE001
                pass
    return out


# ------------------------------------------------------------------ corpora
def fed_corpus(n):
    """Last n FOMC press-conference transcripts as (date, text)."""
    d = os.path.join(CORPUS, 'fed')
    os.makedirs(d, exist_ok=True)
    try:
        page = get('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm')
        dates = sorted(set(re.findall(r'fomcpresconf(\d{8})\.htm', page)))
    except Exception as e:  # noqa: BLE001
        log(f'fed calendar failed: {e}')
        dates = []
    have = {os.path.basename(p)[:8] for p in glob.glob(os.path.join(d, '*.txt'))}
    for ymd in dates:
        if ymd in have or ymd > NOW.strftime('%Y%m%d'):
            continue
        try:
            import pypdf  # local import: only needed here
            pdf = get(f'https://www.federalreserve.gov/mediacenter/files/FOMCpresconf{ymd}.pdf', binary=True)
            reader = pypdf.PdfReader(io.BytesIO(pdf))
            text = '\n'.join((p.extract_text() or '') for p in reader.pages)
            if len(text.split()) > 500:
                open(os.path.join(d, f'{ymd}.txt'), 'w', encoding='utf-8').write(text)
                log(f'fed transcript stored {ymd} ({len(text.split())} words)')
        except Exception as e:  # noqa: BLE001
            log(f'fed transcript {ymd} failed: {e}')
    files = sorted(glob.glob(os.path.join(d, '*.txt')))[-n:]
    return [(os.path.basename(f)[:8], open(f, encoding='utf-8').read()) for f in files]


def yt_list(channel, limit=150):
    """[(id, title)] newest first from a channel's videos tab (flat, one request)."""
    try:
        out = subprocess.run(
            ['yt-dlp', '--no-update', '--no-warnings', '--js-runtimes', 'node', '--flat-playlist', '--playlist-end', str(limit), '--print', '%(id)s\t%(title)s', channel],
            capture_output=True, text=True, timeout=180, encoding='utf-8', errors='replace'
        )
        rows = [ln.split('\t', 1) for ln in out.stdout.splitlines() if '\t' in ln]
        return [(i, t) for i, t in rows if re.fullmatch(r'[\w-]{11}', i)]
    except Exception as e:  # noqa: BLE001
        log(f'yt list failed: {e}')
        return []


def vtt_text(path):
    lines = []
    last = ''
    for raw in open(path, encoding='utf-8', errors='replace'):
        s = raw.strip()
        if not s or s.startswith(('WEBVTT', 'Kind:', 'Language:', 'NOTE')) or '-->' in s or re.fullmatch(r'\d+', s):
            continue
        s = re.sub(r'<[^>]+>', '', s)
        s = re.sub(r'\s+', ' ', s).strip()
        if s and s != last:
            lines.append(s)
            last = s
    return ' '.join(lines)


def yt_captions(video_id, state):
    """Auto-caption text for one video, cached; returns (upload_date, text) or None."""
    meta = state['videos'].get(video_id)
    txt_path = os.path.join(CAPS, f'{video_id}.txt')
    if meta and os.path.exists(txt_path):
        return meta.get('date'), open(txt_path, encoding='utf-8').read()
    if meta and meta.get('failed', 0) >= 2:
        return None
    try:
        out = subprocess.run(
            # YouTube extraction needs a JavaScript runtime since 2026; node is on this box (no runtime = silent no-captions).
            # --print implies --simulate (nothing written) unless --no-simulate is given.
            ['yt-dlp', '--no-update', '--no-warnings', '--js-runtimes', 'node', '--no-simulate', '--skip-download', '--write-auto-subs', '--sub-langs', 'en', '--sub-format', 'vtt',
             '--print', '%(upload_date)s\t%(title)s', '-o', os.path.join(CAPS, '%(id)s.%(ext)s'), f'https://www.youtube.com/watch?v={video_id}'],
            capture_output=True, text=True, timeout=240, encoding='utf-8', errors='replace'
        )
        first = (out.stdout.strip().splitlines() or [''])[0]
        date, _, title = first.partition('\t')
        vtts = glob.glob(os.path.join(CAPS, f'{video_id}*.vtt'))
        if not vtts:
            state['videos'][video_id] = {'failed': (meta or {}).get('failed', 0) + 1, 'title': title}
            return None
        text = vtt_text(vtts[0])
        for v in vtts:
            os.remove(v)
        open(txt_path, 'w', encoding='utf-8').write(text)
        state['videos'][video_id] = {'date': date, 'title': title, 'words': len(text.split())}
        log(f'captions stored {video_id} {date} {title[:60]} ({len(text.split())} words)')
        return date, text
    except Exception as e:  # noqa: BLE001
        log(f'captions {video_id} failed: {e}')
        state['videos'][video_id] = {'failed': (meta or {}).get('failed', 0) + 1}
        return None


def yt_corpus(fam, state, listing):
    """Comparable transcripts for a YouTube-backed family: [(date, text)] newest first."""
    spec = FAMILIES[fam]
    want = spec.get('n') or 60
    picked = []
    for vid, title in listing:
        t = title.lower()
        if not re.search(spec['title_re'], t) or re.search(spec.get('exclude_re', '^$'), t):
            continue
        picked.append(vid)
        if len(picked) >= want:
            break
    docs = []
    for vid in picked:
        got = yt_captions(vid, state)
        # A comparable is a real speech, not a 60-second clip (the channel posts both).
        if got and got[1] and len(got[1].split()) >= spec.get('min_words', 500):
            docs.append(got)
    return docs


# ------------------------------------------------------------------ phrases
def parse_phrase(sub_title):
    """'AI / Artificial Intelligence' -> ([...alternatives], threshold)."""
    s = (sub_title or '').strip()
    threshold = 1
    m = re.search(r'\((\d+)\+?\s*times?\)', s, re.I)
    if m:
        threshold = int(m.group(1))
        s = s[:m.start()].strip()
    s = re.sub(r'\s*\([^)]*\)\s*$', '', s).strip()
    alts = [a.strip() for a in re.split(r'\s*/\s*', s) if a.strip()]
    return alts, threshold


def phrase_regex(alt):
    words = [re.escape(w) for w in alt.split()]
    if not words:
        return None
    words[-1] = words[-1] + r"(?:s|es|'s|’s)?"
    return re.compile(r'(?<![\w-])' + r'\s+'.join(words) + r'(?![\w-])', re.I)


def count_phrase(alts, text):
    n = 0
    for a in alts:
        rx = phrase_regex(a)
        if rx:
            n += len(rx.findall(text))
    return n


def base_rate(docs, alts, threshold):
    n = len(docs)
    k = sum(1 for _, text in docs if count_phrase(alts, text) >= threshold)
    return n, k, (k + 0.5) / (n + 1) if n else None


def weekly_base_rate(docs, alts, threshold, weeks):
    """For weekly/monthly aggregate markets: fraction of the last `weeks` ISO weeks with a mention."""
    by_week = collections.defaultdict(list)
    for date, text in docs:
        if not date or len(date) != 8:
            continue
        d = dt.date(int(date[:4]), int(date[4:6]), int(date[6:]))
        by_week[d.isocalendar()[:2]].append(text)
    wk = sorted(by_week)[-weeks:]
    n = len(wk)
    k = sum(1 for w in wk if any(count_phrase(alts, t) >= threshold for t in by_week[w]))
    return n, k, (k + 0.5) / (n + 1) if n else None


# ------------------------------------------------------------------ kalshi
def kalshi_mention_events():
    evs, cur = [], ''
    for _ in range(80):
        d = get_json(f'{KALSHI}/events?status=open&limit=200&with_nested_markets=true' + (f'&cursor={cur}' if cur else ''))
        evs += d.get('events', [])
        cur = d.get('cursor') or ''
        if not cur or not d.get('events'):
            break
        time.sleep(0.15)
    return [e for e in evs if re.search(r'MENTION|SAY', e.get('event_ticker') or '')]


def speaker_docs(docs, event_title):
    """Same-speaker comparables. The Fed corpus spans chairs, and phrasing habits are personal:
    Powell opened with "Good afternoon", Warsh opens with "Good day" (2026-09-08: an 81% base rate
    for "Good Afternoon" against a 12c ask). Keep transcripts whose header names the current
    speaker when at least two exist; otherwise fall back to all, flagged."""
    m = re.search(r'will\s+(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+say', event_title or '')
    if not m:
        return docs, False
    last = m.group(1).split()[-1]
    same = [d for d in docs if re.search(r'\b' + re.escape(last) + r'\b', d[1][:600], re.I)]
    return (same, True) if len(same) >= 2 else (docs, False)


def family_of(ticker):
    series = (ticker or '').split('-')[0]
    for fam, spec in FAMILIES.items():
        if fam == 'trump-period':
            continue
        if series in spec['prefixes']:
            return fam
    if series.startswith('KXTRUMPSAY'):
        return 'trump-period'
    return None


def period_weeks(m):
    """Weeks a period market covers, from open_time to expiration (clamped 1..13)."""
    try:
        a = dt.datetime.fromisoformat((m.get('open_time') or '').replace('Z', '+00:00'))
        b = dt.datetime.fromisoformat((m.get('expiration_time') or m.get('close_time') or '').replace('Z', '+00:00'))
        return max(1.0, min(13.0, (b - a).total_seconds() / (7 * 86400)))
    except Exception:  # noqa: BLE001
        return 4.0


def market_end(row):
    """The moment every strike of a market is knowable: the expiration, never an early YES settlement."""
    return max(row.get('expiration_time') or '', row.get('close_time') or '')


def price(m, key):
    v = m.get(key + '_dollars')
    if v not in (None, ''):
        try:
            return float(v)
        except ValueError:
            pass
    v = m.get(key)
    if v in (None, ''):
        return None
    try:
        f = float(v)
        return f / 100 if f > 1 else f
    except ValueError:
        return None


# ------------------------------------------------------------------ passes
def observe(state):
    events = kalshi_mention_events()
    fams_needed = collections.Counter(family_of(m.get('ticker')) for e in events for m in (e.get('markets') or []))
    log(f'mention events {len(events)}, strikes by family {dict(fams_needed)}')
    corpora = {}
    if fams_needed.get('fed'):
        corpora['fed'] = fed_corpus(FAMILIES['fed']['n'])
    if any(fams_needed.get(f) for f in ('press', 'trump', 'trump-period')):
        listing = yt_list(WH_CHANNEL, limit=400)
        log(f'white house channel listing {len(listing)} videos')
        if fams_needed.get('press'):
            corpora['press'] = yt_corpus('press', state, listing)
        if fams_needed.get('trump') or fams_needed.get('trump-period'):
            corpora['trump'] = yt_corpus('trump', state, listing)
            corpora['trump-period'] = corpora['trump'] and yt_corpus('trump-period', state, listing)
    for fam, docs in corpora.items():
        log(f'corpus {fam}: {len(docs or [])} transcripts')
    hour = NOW.strftime('%Y-%m-%dT%H')
    logged = unsupported = 0
    for e in events:
        for m in e.get('markets') or []:
            t = m.get('ticker')
            fam = family_of(t)
            if fam is None or not corpora.get(fam):
                unsupported += 1
                continue
            if state['observed'].get(t) == hour:
                continue
            alts, thr = parse_phrase(m.get('yes_sub_title'))
            if not alts or alts[0].lower().startswith('event does not qualify'):
                continue
            p_week = weeks = None
            speaker_ok = None
            if fam == 'fed':
                docs, speaker_ok = speaker_docs(corpora[fam], e.get('title'))
                n, k, p = base_rate(docs, alts, thr)
            elif fam == 'trump-period':
                # A period market pays if the phrase is said at least once in the whole period: the
                # weekly hit rate compounds over the weeks the market covers (open_time to expiration).
                n, k, p_week = weekly_base_rate(corpora[fam], alts, thr, FAMILIES[fam]['weeks'])
                weeks = period_weeks(m)
                p = None if p_week is None else 1 - (1 - p_week) ** weeks
            else:
                n, k, p = base_rate(corpora[fam], alts, thr)
            if p is None:
                continue
            row = {
                'ts': NOW.isoformat(timespec='seconds'), 'ticker': t, 'event': e.get('event_ticker'), 'family': fam,
                'phrase': ' / '.join(alts), 'threshold': thr, 'n': n, 'k': k, 'p_base': round(p, 4),
                'p_week': None if p_week is None else round(p_week, 4), 'period_weeks': weeks, 'speaker_match': speaker_ok,
                'yes_bid': price(m, 'yes_bid'), 'yes_ask': price(m, 'yes_ask'), 'last': price(m, 'last_price'),
                'close_time': m.get('close_time'), 'expiration_time': m.get('expiration_time'), 'open_time': m.get('open_time')
            }
            append(OBS, row)
            state['observed'][t] = hour
            logged += 1
    log(f'observed {logged} strikes this hour; unsupported/uncovered {unsupported}')


def kalshi_fee(p):
    return 0.07 * p * (1 - p)


def scored_observation(rows):
    """The observation a base-rate trader could actually have acted on: the FIRST sight of the strike.

    A mention market settles YES the instant the phrase is said and Kalshi sets close_time to that
    moment, so the last quote at or before the close is the post-resolution 99c/1c pin. Scoring it
    gave every one of the first 34 graded strikes a market Brier of exactly 0.0000 (2026-09-16), which
    made build-queue item 12's ">= 100 graded, Brier better than the price" trigger unreachable by
    construction. The base rate is static over the period, so the honest pairing is the earliest quote
    we logged against the base rate we held at that moment.
    """
    return min(rows, key=lambda r: r['ts'])


def counterfactual(p, bid, ask, y, gap=0.15):
    """Taker trade when the base rate is `gap` clear of the tradeable price, held to settlement."""
    if ask is not None and p - ask >= gap:
        return {'side': 'YES', 'price': round(ask, 4), 'pnl': round((1 - ask if y else -ask) - kalshi_fee(ask), 4)}
    # NO costs 1 - yes_bid and is worth 1 - p, so its edge is bid - p. The original first clause read
    # (1 - bid) - (1 - p), which is p - bid -- the negative of the edge -- and contradicted the second
    # clause, so the NO branch could never fire. That branch is the whole strategy whenever the base
    # rate sits under the price, which on the 2026-09-16 data is 19 of 34 strikes.
    if bid is not None and bid - p >= gap:
        px = round(1 - bid, 4)
        return {'side': 'NO', 'price': px, 'pnl': round((1 - px if not y else -px) - kalshi_fee(px), 4)}
    return None


def grade_entry(rows, y, graded_at):
    """Pure: the grades.jsonl row for one strike, given its observations and its settled outcome."""
    r = scored_observation(rows)
    bid, ask = r.get('yes_bid'), r.get('yes_ask')
    mid = (bid + ask) / 2 if bid is not None and ask is not None else r.get('last')
    p = r['p_base']
    last = sorted(rows, key=lambda x: x['ts'])[-1]
    lbid, lask = last.get('yes_bid'), last.get('yes_ask')
    mid_last = (lbid + lask) / 2 if lbid is not None and lask is not None else last.get('last')
    return {
        'ticker': r['ticker'], 'event': r['event'], 'family': r['family'], 'phrase': r['phrase'],
        'n': r['n'], 'k': r['k'], 'p_base': p, 'mid': None if mid is None else round(mid, 4),
        'scored_ts': r['ts'], 'mid_last': None if mid_last is None else round(mid_last, 4),
        'y': y, 'graded_at': graded_at,
        'brier_base': round((p - y) ** 2, 4), 'brier_mkt': None if mid is None else round((mid - y) ** 2, 4),
        'trade': counterfactual(p, bid, ask, y),
    }


def settled_result(m):
    """(result, None) for a strike Kalshi settled yes/no, else (None, why): 'void' when it settled without one,
    'no-result' while it has not settled. Pure; see selftest()."""
    result = (m.get('result') or '').lower()
    if result in ('yes', 'no'):
        return result, None
    return None, 'void' if (m.get('status') or '') in ('settled', 'finalized') else 'no-result'


def grade(state):
    obs = read_jsonl(OBS)
    by_ticker = collections.defaultdict(list)
    for o in obs:
        by_ticker[o['ticker']].append(o)
    graded = 0
    # Why nothing graded, per reason: a bare "graded 0 strikes" is how a silent shadow hides for days (backlog 93).
    skip = collections.Counter()
    for t, rows in by_ticker.items():
        if t in state['graded']:
            skip['already-graded'] += 1
            continue
        last = rows[-1]
        # Grade only once the period is over. Mention markets settle YES the moment the phrase is
        # said, so grading early scores only the winners (2026-09-08: 19 early YES settlements
        # made a 5% base rate look absurd before a single NO could exist).
        end = market_end(last)
        if end and end > NOW.isoformat():
            skip['not-expired'] += 1
            continue
        try:
            m = get_json(f'{KALSHI}/markets/{t}').get('market', {})
        except Exception as e:  # noqa: BLE001
            log(f'grade fetch {t} failed: {e}')
            skip['fetch-failed'] += 1
            continue
        result, why = settled_result(m)
        if why:
            skip[why] += 1
            if why == 'void':
                state['graded'][t] = 'void'
            continue
        y = 1 if result == 'yes' else 0
        entry = grade_entry(rows, y, NOW.isoformat(timespec='seconds'))
        append(GRADES, entry)
        state['graded'][t] = result
        graded += 1
        time.sleep(0.1)
    log(f'graded {graded} strikes' + (f' | skipped {dict(sorted(skip.items()))}' if skip else ''))


def report():
    g = read_jsonl(GRADES)
    obs = read_jsonl(OBS)
    print(f'observations {len(obs)} rows, strikes {len({o["ticker"] for o in obs})}, graded {len(g)}')
    if not g:
        return
    def mean(xs):
        xs = [x for x in xs if x is not None]
        return sum(xs) / len(xs) if xs else None
    print(f'Brier base {mean([x["brier_base"] for x in g]):.4f} vs market {mean([x["brier_mkt"] for x in g]):.4f} (lower is better)')
    for fam in sorted({x['family'] for x in g}):
        xs = [x for x in g if x['family'] == fam]
        print(f'  {fam:13s} n={len(xs):4d} base {mean([x["brier_base"] for x in xs]):.4f} market {mean([x["brier_mkt"] for x in xs]):.4f}')
    trades = [x['trade'] for x in g if x.get('trade')]
    if trades:
        net = sum(t['pnl'] for t in trades)
        print(f'counterfactual 15c-gap taker trades: {len(trades)}, net {net:+.3f} per contract-sum, mean {net / len(trades):+.4f}/contract')
    buckets = collections.defaultdict(list)
    for x in g:
        buckets[min(9, int(x['p_base'] * 10))].append(x['y'])
    print('calibration of the base rate (bucket: n, hit rate):')
    for b in sorted(buckets):
        ys = buckets[b]
        print(f'  {b / 10:.1f}-{(b + 1) / 10:.1f}: n={len(ys)} hit={sum(ys) / len(ys):.2f}')


def regrade():
    """Rebuild grades.jsonl from the observations and the outcomes already recorded. No network."""
    old = read_jsonl(GRADES)
    if not old:
        log('regrade: nothing to rebuild')
        return
    by_ticker = collections.defaultdict(list)
    for o in read_jsonl(OBS):
        by_ticker[o['ticker']].append(o)
    rebuilt = []
    for g in old:
        rows = by_ticker.get(g['ticker'])
        if not rows:
            log(f'regrade: no observations for {g["ticker"]}, keeping the old row')
            rebuilt.append(g)
            continue
        rebuilt.append(grade_entry(rows, g['y'], g['graded_at']))
    bak = GRADES + '.bak-' + NOW.strftime('%Y%m%dT%H%M%SZ')
    os.replace(GRADES, bak)
    with open(GRADES, 'w', encoding='utf-8') as fh:
        for g in rebuilt:
            fh.write(json.dumps(g, ensure_ascii=False) + chr(10))
    log(f'regrade: rewrote {len(rebuilt)} rows; previous file kept at {os.path.basename(bak)}')


def selftest():
    fails = []

    def ok(cond, what):
        if not cond:
            fails.append(what)

    def obs(ts, bid, ask, p=0.10, close='2026-09-10T19:00:00Z'):
        return {'ticker': 'T', 'event': 'E', 'family': 'trump-period', 'phrase': 'x', 'n': 22, 'k': 2,
                'ts': ts, 'yes_bid': bid, 'yes_ask': ask, 'p_base': p, 'close_time': close}

    # The 2026-09-16 defect: close_time IS the early-YES settlement moment, so the last quote before
    # the close is the 99c pin. The scored quote must be the first sight, not the last.
    rows = [obs('2026-09-08T11:00:00Z', 0.24, 0.28), obs('2026-09-10T18:00:00Z', 0.99, 1.0),
            obs('2026-09-11T18:00:00Z', 0.99, 1.0)]
    ok(scored_observation(rows)['ts'] == '2026-09-08T11:00:00Z', 'scores the first pre-close observation')
    ok(scored_observation(list(reversed(rows)))['ts'] == '2026-09-08T11:00:00Z', 'order of the file does not matter')
    ok(scored_observation([obs('2026-09-12T00:00:00Z', 0.5, 0.5)])['ts'] == '2026-09-12T00:00:00Z',
       'a strike first seen after its close is still scored at that first sight')
    e = grade_entry(rows, 1, 'now')
    ok(e['brier_mkt'] == round((0.26 - 1) ** 2, 4), 'brier_mkt uses the first-sight mid')
    ok(e['mid_last'] == 0.995, 'the settled pin is kept as mid_last, not as the score')

    # The NO counterfactual was unreachable: its first clause was the negative of the edge.
    ok(counterfactual(0.05, 0.24, 0.28, 0) == {'side': 'NO', 'price': 0.76,
                                               'pnl': round(0.24 - kalshi_fee(0.76), 4)}, 'NO fires when bid - p >= gap')
    lost = counterfactual(0.05, 0.24, 0.28, 1)
    ok(lost is not None and lost['pnl'] == round(-0.76 - kalshi_fee(0.76), 4), 'NO loses its stake on YES')
    ok(counterfactual(0.05, 0.19, 0.23, 0) is None, 'NO refuses a gap under 15c')
    ok(counterfactual(0.50, 0.30, 0.34, 1) == {'side': 'YES', 'price': 0.34,
                                               'pnl': round(0.66 - kalshi_fee(0.34), 4)}, 'YES still fires')
    ok(counterfactual(0.50, None, None, 1) is None, 'no quote, no trade')

    # The two skip reasons the venue decides (backlog 93).
    ok(settled_result({'result': 'YES', 'status': 'finalized'}) == ('yes', None), 'a yes/no result is graded')
    ok(settled_result({'result': '', 'status': 'finalized'}) == (None, 'void'), 'settled without a result is void')
    ok(settled_result({'status': 'active'}) == (None, 'no-result'), 'expired but unsettled is no-result')
    print(f'selftest: {13 - len(fails)} passed, {len(fails)} failed' + (f' -> {fails}' if fails else ''))
    return 1 if fails else 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'report':
        report()
        return
    if len(sys.argv) > 1 and sys.argv[1] == 'selftest':
        sys.exit(selftest())
    if len(sys.argv) > 1 and sys.argv[1] == 'regrade':
        regrade()
        report()
        return
    state = load_state()
    try:
        observe(state)
    except Exception as e:  # noqa: BLE001
        log(f'observe failed: {e}')
    try:
        grade(state)
    except Exception as e:  # noqa: BLE001
        log(f'grade failed: {e}')
    save_state(state)


if __name__ == '__main__':
    main()
