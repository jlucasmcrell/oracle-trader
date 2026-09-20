"""Periods the record must not be read as evidence. Prose copy and rationale: docs/DEGRADED-WINDOWS.md.

Settlements inside a window are real money and stay in every P&L total; they are not evidence about a
strategy's edge, because the configuration under test was not the one intended to run. Read scripts call
`label(ts_ms)` and report the halves separately rather than deleting anything.

`scope`: 'execution' windows affect any read (the fills themselves were degraded); 'calibration' windows affect
only numbers taken from the app's calibration ledger, not reads built from fills plus settlement results.
"""
import calendar, time

WINDOWS = [
    {'id': 1, 'scope': 'execution', 'from': '2026-09-12T12:46Z', 'to': '2026-09-17T08:07Z',
     'what': 'Kalshi order path slow (account reads before every order) and lead-lag sized for seven '
             'independent coins on one 15-minute window; -$31.28 in 90 minutes on 09-13, kill switch tripped',
     'ended': 'round 115: read/write rate lanes, cached position count, reserve-inside/submit-outside'},
    {'id': 2, 'scope': 'calibration', 'from': None, 'to': '2026-09-18T13:34Z',
     'what': 'netCentsOf divided an already-per-contract fee by the contract count again, so every '
             'calibration reading before the fix understated fees (dollar P&L was never affected)',
     'ended': 'v27 migration cleared the calibration accumulators (CALIB_CLEARED_AT)'},
]


def _ms(s):
    return None if s is None else calendar.timegm(time.strptime(s, '%Y-%m-%dT%H:%MZ')) * 1000


for _w in WINDOWS:
    _w['from_ms'] = _ms(_w['from'])
    _w['to_ms'] = _ms(_w['to'])


def hits(ts_ms, scope='execution'):
    """The windows of this scope covering a timestamp (ms)."""
    return [w for w in WINDOWS if w['scope'] == scope
            and (w['from_ms'] is None or ts_ms >= w['from_ms'])
            and (w['to_ms'] is None or ts_ms < w['to_ms'])]


def label(ts_ms, scope='execution'):
    """'clean', or 'degraded-<id>' for a read to split on."""
    h = hits(ts_ms, scope)
    return 'degraded-%d' % h[0]['id'] if h else 'clean'


def banner(scope='execution'):
    ws = [w for w in WINDOWS if w['scope'] == scope]
    return 'degraded windows (%s): ' % scope + '; '.join(
        '#%d %s..%s' % (w['id'], w['from'] or 'start', w['to'] or 'now') for w in ws)
