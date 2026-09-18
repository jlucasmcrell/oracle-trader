#!/usr/bin/env python
"""Domain calibration slopes on the Becker Kalshi trade archive (build-queue 79, taxonomy C2/C3). Read-only.

Question: by category group, horizon and price band, is the traded YES price a calibrated probability, or
are prices compressed toward 50c (slope > 1: favourites win more often than they are priced, the shape the
political-markets literature reports) or pushed away from it (slope < 1)? And, per band, does buying the
side at its traded price earn anything AFTER Kalshi's taker fee? The taker seat is the trade price; the
maker seat is its complement (upper bound: maker fees are not marked in the data).

Every trade is one observation of (price paid for YES, did YES happen), contract-weighted. Slope = weighted
least squares of outcome on price per (group, horizon). Uncertainty is day-clustered (cluster = close date):
bands come from resampling clusters, never rows, so a thousand trades on one market count as one cluster.
Split: SELECTION half (trades before 2025-07-01) and EVALUATION half (2025-07-01 to the archive end,
2026-02-05) reported side by side, so a cell that only looks good in the half we looked at first is visible.

  python scripts/backtests/calibration_slopes.py [--data G:/DATA/prediction-market-analysis/data/kalshi]
        [--since 2024-10-01] [--split 2025-07-01] [--out docs/reports/backtest-calibration-slopes-<date>.md]
"""
import argparse
import datetime as dt
import math
import os
import random
import sys

import duckdb

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kalshi_categories import get_group  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ap = argparse.ArgumentParser()
ap.add_argument('--data', default='G:/DATA/prediction-market-analysis/data/kalshi')
ap.add_argument('--since', default='2024-10-01')
ap.add_argument('--split', default='2025-07-01')
ap.add_argument('--out', default=None)
ap.add_argument('--boot', type=int, default=400)
ap.add_argument('--seed', type=int, default=79)
args = ap.parse_args()
TR = f"'{args.data}/trades/*.parquet'"
MK = f"'{args.data}/markets/*.parquet'"
today = dt.date.today().isoformat()
out_path = args.out or os.path.join(ROOT, 'docs', 'reports', f'backtest-calibration-slopes-{today}.md')
random.seed(args.seed)

con = duckdb.connect()
con.execute('PRAGMA threads=8')
os.makedirs('G:/DATA/prediction-market-analysis/tmp', exist_ok=True)
con.execute("SET temp_directory='G:/DATA/prediction-market-analysis/tmp'")

prefixes = [r[0] for r in con.execute(f"""
    SELECT DISTINCT regexp_extract(event_ticker, '^([A-Z0-9]+)', 1) AS p FROM {MK} WHERE event_ticker IS NOT NULL
""").fetchall()]
con.execute('CREATE TABLE groups(prefix VARCHAR, grp VARCHAR)')
con.executemany('INSERT INTO groups VALUES (?, ?)',
                [(p, get_group(p.replace('KX', '', 1) if p.startswith('KX') else p)) for p in prefixes if p])

HTC = ("CASE WHEN hours_to_close < 1 THEN 'a <1h' WHEN hours_to_close < 6 THEN 'b 1-6h' WHEN hours_to_close < 24 THEN 'c 6-24h' "
       "WHEN hours_to_close < 72 THEN 'd 1-3d' WHEN hours_to_close < 168 THEN 'e 3-7d' ELSE 'f >7d' END")

# One row per trade: YES price in cents (the taker's price if they bought YES, else 100 - their NO price),
# whether YES happened, contracts, group, horizon bucket, half, close date (the cluster key).
con.execute(f"""
CREATE TABLE obs AS
WITH mk AS (
    SELECT ticker, result, close_time, regexp_extract(event_ticker, '^([A-Z0-9]+)', 1) AS prefix
    FROM {MK} WHERE status = 'finalized' AND result IN ('yes', 'no') AND market_type = 'binary'
),
tr AS (
    SELECT t.yes_price AS p, CASE WHEN m.result = 'yes' THEN 1 ELSE 0 END AS y, t.count AS w, t.taker_side,
           t.created_time, m.close_time, m.prefix,
           date_diff('minute', t.created_time, m.close_time) / 60.0 AS hours_to_close
    FROM {TR} t JOIN mk m ON t.ticker = m.ticker
    WHERE t.created_time >= TIMESTAMP '{args.since}' AND t.yes_price BETWEEN 1 AND 99 AND t.count > 0
)
SELECT p, y, w, taker_side, COALESCE(g.grp, 'Other') AS grp, {HTC} AS htc,
       CASE WHEN created_time < TIMESTAMP '{args.split}' THEN 'A select' ELSE 'B evaluate' END AS half,
       CAST(close_time AS DATE) AS cday,
       CAST((p - 1) / 5 AS INTEGER) AS band5
FROM tr LEFT JOIN groups g ON tr.prefix = g.prefix
""")
n_obs, n_contracts = con.execute('SELECT count(*), sum(w) FROM obs').fetchone()
print(f'observations {n_obs:,} trades, {n_contracts:,.0f} contracts', flush=True)

# Cluster-level sufficient statistics for the weighted regression y ~ a + b * p (p in [0,1]).
con.execute("""
CREATE TABLE cl AS
SELECT grp, htc, half, cday,
       sum(w) AS sw, sum(w * p / 100.0) AS swp, sum(w * y) AS swy,
       sum(w * p * p / 10000.0) AS swpp, sum(w * p * y / 100.0) AS swpy, count(*) AS n
FROM obs GROUP BY grp, htc, half, cday
""")


def slope_from(rows):
    sw = sum(r[0] for r in rows); swp = sum(r[1] for r in rows); swy = sum(r[2] for r in rows)
    swpp = sum(r[3] for r in rows); swpy = sum(r[4] for r in rows)
    if sw <= 0:
        return None
    mp, my = swp / sw, swy / sw
    var = swpp / sw - mp * mp
    if var <= 1e-9:
        return None
    cov = swpy / sw - mp * my
    return cov / var


def slope_band(rows, boot):
    """Point slope and the 10th/90th percentile of the cluster-bootstrap slope distribution."""
    pt = slope_from(rows)
    if pt is None or len(rows) < 5:
        return pt, None, None
    sl = []
    for _ in range(boot):
        s = slope_from([rows[random.randrange(len(rows))] for _ in range(len(rows))])
        if s is not None:
            sl.append(s)
    sl.sort()
    return pt, sl[int(0.1 * len(sl))], sl[int(0.9 * len(sl)) - 1]


def clustered_excess(cells):
    """cells: list of (sw, swy, swp, sfee) per cluster. Contract-weighted mean of (100y - p - fee) with a
    cluster-robust SE (Liang-Zeger on cluster sums)."""
    sw = sum(c[0] for c in cells)
    if sw <= 0:
        return None, None, 0
    m = sum(100.0 * c[1] - c[2] - c[3] for c in cells) / sw
    # residual sums per cluster around the pooled mean
    se = math.sqrt(sum((100.0 * c[1] - c[2] - c[3] - m * c[0]) ** 2 for c in cells)) / sw
    return m, se, len(cells)


sections = []
print('slopes by group and horizon...', flush=True)
slope_rows = []
groups = [r[0] for r in con.execute("SELECT grp FROM cl GROUP BY grp ORDER BY sum(sw) DESC").fetchall()]
htcs = [r[0] for r in con.execute('SELECT DISTINCT htc FROM cl ORDER BY htc').fetchall()]
for grp in groups:
    for half in ('A select', 'B evaluate'):
        for htc in ['ALL'] + htcs:
            cond = '' if htc == 'ALL' else f"AND htc = '{htc}'"
            rows = con.execute(f"""
                SELECT sum(sw), sum(swp), sum(swy), sum(swpp), sum(swpy) FROM cl
                WHERE grp = ? AND half = ? {cond} GROUP BY cday
            """, [grp, half]).fetchall()
            if not rows:
                continue
            contracts = sum(r[0] for r in rows)
            if contracts < 20000:
                continue
            pt, lo, hi = slope_band(rows, args.boot)
            if pt is None:
                continue
            slope_rows.append((grp, half, htc, len(rows), contracts, pt, lo, hi))

head = '| group | half | horizon | day-clusters | contracts | slope | 10% | 90% | reads |\n|---|---|---|---|---|---|---|---|---|\n'
body = ''
for grp, half, htc, D, c, pt, lo, hi in slope_rows:
    verdict = ''
    if lo is not None:
        if lo > 1:
            verdict = 'COMPRESSED (favourites under-priced)'
        elif hi < 1:
            verdict = 'STRETCHED (favourites over-priced)'
        else:
            verdict = 'calibrated within band'
    body += f'| {grp} | {half} | {htc} | {D} | {c:,.0f} | {pt:.3f} | {lo if lo is None else round(lo, 3)} | {hi if hi is None else round(hi, 3)} | {verdict} |\n'
sections.append(('Calibration slope of outcome on traded YES price (1.0 = calibrated), contract-weighted, '
                 'day-clustered bootstrap band (10-90%)', head + body))

print('excess by band...', flush=True)
# Net-of-fee excess of BUYING the side at its price, per group x half x 5c band of the price PAID (not the YES
# price): a trade at YES 90 is "buy YES at 90" for the taker who bought YES, and "buy NO at 10" for the one
# who bought NO. Taker fee 7c * P * (1-P) per contract. Maker seat: the complement price, fee 0 (upper bound).
con.execute("""
CREATE TABLE side_obs AS
SELECT grp, htc, half, cday, w,
       CASE WHEN taker_side = 'yes' THEN p ELSE 100 - p END AS paid,
       CASE WHEN taker_side = 'yes' THEN y ELSE 1 - y END AS won,
       7.0 * (p / 100.0) * (1 - p / 100.0) AS fee
FROM obs
""")
band_rows = []
for grp in groups:
    for half in ('A select', 'B evaluate'):
        for lo_c in range(5, 100, 10):
            hi_c = lo_c + 9
            cells = con.execute("""
                SELECT sum(w), sum(w * won), sum(w * paid), sum(w * fee) FROM side_obs
                WHERE grp = ? AND half = ? AND paid BETWEEN ? AND ? GROUP BY cday
            """, [grp, half, lo_c, hi_c]).fetchall()
            m, se, D = clustered_excess(cells)
            if m is None or D < 5:
                continue
            contracts = sum(c[0] for c in cells)
            if contracts < 20000:
                continue
            mk = con.execute("""
                SELECT sum(w), sum(w * (1 - won)), sum(w * (100 - paid)), 0 FROM side_obs
                WHERE grp = ? AND half = ? AND paid BETWEEN ? AND ? GROUP BY cday
            """, [grp, half, lo_c, hi_c]).fetchall()
            mm, mse, _ = clustered_excess(mk)
            band_rows.append((grp, half, f'{lo_c:02d}-{hi_c:02d}', D, contracts, m, se, mm, mse))

head = ('| group | half | price paid | day-clusters | contracts | taker net c | +-1.28 SE | maker net c (no fee) | +-1.28 SE |\n'
        '|---|---|---|---|---|---|---|---|---|\n')
body = ''
for grp, half, band, D, c, m, se, mm, mse in band_rows:
    flag = ' **' if (m - 1.28 * se) > 0 else ''
    body += f'| {grp} | {half} | {band} | {D} | {c:,.0f} | {m:+.2f}{flag} | {1.28 * se:.2f} | {mm:+.2f} | {1.28 * mse:.2f} |\n'
sections.append(('Net excess return of buying the side at its traker price, cents per contract after the taker fee, '
                 'by group, half and 10c band of the price paid (** = day-clustered 80% lower bound above zero)', head + body))

print('politics detail...', flush=True)
pol_rows = []
for htc in htcs:
    for half in ('A select', 'B evaluate'):
        for lo_c in range(5, 100, 10):
            hi_c = lo_c + 9
            cells = con.execute("""
                SELECT sum(w), sum(w * won), sum(w * paid), sum(w * fee) FROM side_obs
                WHERE grp = 'Politics' AND htc = ? AND half = ? AND paid BETWEEN ? AND ? GROUP BY cday
            """, [htc, half, lo_c, hi_c]).fetchall()
            m, se, D = clustered_excess(cells)
            if m is None or D < 5:
                continue
            contracts = sum(c[0] for c in cells)
            if contracts < 5000:
                continue
            pol_rows.append((htc, half, f'{lo_c:02d}-{hi_c:02d}', D, contracts, m, se))
head = '| horizon | half | price paid | day-clusters | contracts | taker net c | +-1.28 SE |\n|---|---|---|---|---|---|---|\n'
body = ''.join(f'| {h} | {half} | {b} | {D} | {c:,.0f} | {m:+.2f}{" **" if (m - 1.28 * se) > 0 else ""} | {1.28 * se:.2f} |\n'
               for h, half, b, D, c, m, se in pol_rows)
sections.append(('Politics only: taker net by horizon, half and band', head + body))

# The claim under test for calibratedYesRate() (backlog 68): "zero bias above 10c". Per group, evaluation half,
# YES price 10-90: contract-weighted mean of (100y - p) with day-clustered SE.
print('bias above 10c...', flush=True)
bias_rows = []
for grp in groups:
    cells = con.execute("""
        SELECT sum(w), sum(w * y), sum(w * p), 0 FROM obs WHERE grp = ? AND half = 'B evaluate' AND p BETWEEN 10 AND 90 GROUP BY cday
    """, [grp]).fetchall()
    m, se, D = clustered_excess(cells)
    if m is None or D < 5:
        continue
    bias_rows.append((grp, D, sum(c[0] for c in cells), m, se))
head = '| group | day-clusters | contracts | realised YES minus price (c) | +-1.28 SE |\n|---|---|---|---|---|\n'
body = ''.join(f'| {g} | {D} | {c:,.0f} | {m:+.2f} | {1.28 * se:.2f} |\n' for g, D, c, m, se in bias_rows)
sections.append(('Mean bias of YES price 10-90c, evaluation half (what calibratedYesRate() assumes is zero)', head + body))

md = [f'# Calibration slopes by domain, Becker Kalshi archive ({today})', '',
      f'Trades since {args.since}; split at {args.split}; {n_obs:,} trades, {n_contracts:,.0f} contracts; '
      f'finalized binary markets only; day-clustered by close date; bootstrap {args.boot} resamples of clusters.', '',
      'Slope 1.0 means the traded price is a calibrated probability. Above 1: outcomes more extreme than prices '
      '(prices compressed toward 50c; buying favourites pays before fees). Below 1: prices more extreme than '
      'outcomes (buying longshots pays before fees). The band tables say whether either survives the taker fee.', '']
for title, tbl in sections:
    md += [f'## {title}', '', tbl, '']
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(md))
print(f'wrote {out_path}')
for title, tbl in sections[:1]:
    print('\n' + title + '\n' + tbl)
print('\n' + sections[3][0] + '\n' + sections[3][1])
