#!/usr/bin/env python
"""Fade audit on the Becker Kalshi trade dataset (build-queue item 15a). Read-only.

Every Kalshi trade in the dataset carries the taker side and joins to a finalized result, so for
each trade we score BOTH seats: the taker at the price they paid, and the maker at 100 minus that.
Excess return = win rate minus price (cents per contract, before fees); the taker also pays
Kalshi's fee 7c * P * (1 - P) per contract, the maker pays 0 (maker-fee series are not marked in
the data, so maker figures are an upper bound). The fade arm buys the 90-99c side (NO at 90-97c
today) and the question is where, when and in which seat that pays after fees.

  python scripts/backtests/fade_audit.py [--data G:/DATA/prediction-market-analysis/data/kalshi] [--since 2024-10-01]
Writes docs/reports/backtest-fade-audit-<date>.md and prints the headline tables.
"""
import argparse
import datetime as dt
import os
import sys

import duckdb

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kalshi_categories import get_group  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ap = argparse.ArgumentParser()
ap.add_argument('--data', default='G:/DATA/prediction-market-analysis/data/kalshi')
ap.add_argument('--since', default='2024-10-01', help='first trade date (post the Oct-2024 regime change by default)')
ap.add_argument('--out', default=None)
args = ap.parse_args()
TR = f"'{args.data}/trades/*.parquet'"
MK = f"'{args.data}/markets/*.parquet'"
today = dt.date.today().isoformat()
out_path = args.out or os.path.join(ROOT, 'docs', 'reports', f'backtest-fade-audit-{today}.md')

con = duckdb.connect()
con.execute('PRAGMA threads=8')
os.makedirs('G:/DATA/prediction-market-analysis/tmp', exist_ok=True)
con.execute("SET temp_directory='G:/DATA/prediction-market-analysis/tmp'")

# Category group per event-ticker prefix, computed in Python once and joined as a table.
prefixes = [r[0] for r in con.execute(f"""
    SELECT DISTINCT regexp_extract(event_ticker, '^([A-Z0-9]+)', 1) AS p FROM {MK} WHERE event_ticker IS NOT NULL
""").fetchall()]
con.execute('CREATE TABLE groups(prefix VARCHAR, grp VARCHAR)')
con.executemany('INSERT INTO groups VALUES (?, ?)', [(p, get_group(p.replace('KX', '', 1) if p.startswith('KX') else p)) for p in prefixes if p])

# One row per (trade, seat): price paid in cents, whether that seat won, fee, category, hour ET, hours to close.
con.execute(f"""
CREATE TABLE seats AS
WITH mk AS (
    SELECT ticker, event_ticker, result, close_time,
           regexp_extract(event_ticker, '^([A-Z0-9]+)', 1) AS prefix
    FROM {MK} WHERE status = 'finalized' AND result IN ('yes', 'no')
),
tr AS (
    SELECT t.ticker, t.count, t.yes_price, t.no_price, t.taker_side, t.created_time, m.result, m.close_time, m.prefix
    FROM {TR} t JOIN mk m ON t.ticker = m.ticker
    WHERE t.created_time >= TIMESTAMP '{args.since}'
),
seat_rows AS (
    SELECT 'taker' AS seat, taker_side AS side,
           CASE WHEN taker_side = 'yes' THEN yes_price ELSE no_price END AS price,
           CASE WHEN taker_side = result THEN 1 ELSE 0 END AS won,
           count, created_time, close_time, prefix
    FROM tr
    UNION ALL
    SELECT 'maker', CASE WHEN taker_side = 'yes' THEN 'no' ELSE 'yes' END,
           CASE WHEN taker_side = 'yes' THEN no_price ELSE yes_price END,
           CASE WHEN taker_side <> result THEN 1 ELSE 0 END,
           count, created_time, close_time, prefix
    FROM tr
)
SELECT b.*, COALESCE(g.grp, 'Other') AS grp,
       CASE WHEN b.seat = 'taker' THEN 7.0 * (b.price / 100.0) * (1 - b.price / 100.0) ELSE 0 END AS fee_cents,
       hour(timezone('America/New_York', b.created_time)) AS hour_et,
       date_diff('minute', b.created_time, b.close_time) / 60.0 AS hours_to_close
FROM seat_rows b LEFT JOIN groups g ON b.prefix = g.prefix
""")

n_all = con.execute('SELECT count(*) FROM seats').fetchone()[0]


def table(sql, cols):
    rows = con.execute(sql).fetchall()
    head = '| ' + ' | '.join(cols) + ' |\n|' + '---|' * len(cols) + '\n'
    body = ''.join('| ' + ' | '.join(str(x) for x in r) + ' |\n' for r in rows)
    return head + body


NET = 'round(100.0 * avg(won) - avg(price) - avg(fee_cents), 3)'
NETW = 'round(100.0 * sum(won * count) / sum(count) - sum(price * count) / sum(count) - sum(fee_cents * count) / sum(count), 3)'
BUCKET = "CASE WHEN price BETWEEN 85 AND 89 THEN '85-89' WHEN price BETWEEN 90 AND 94 THEN '90-94' WHEN price BETWEEN 95 AND 97 THEN '95-97' WHEN price >= 98 THEN '98-99' END"
HTC = "CASE WHEN hours_to_close < 1 THEN 'a <1h' WHEN hours_to_close < 6 THEN 'b 1-6h' WHEN hours_to_close < 24 THEN 'c 6-24h' WHEN hours_to_close < 72 THEN 'd 1-3d' ELSE 'e >3d' END"

sections = []
sections.append(('Favourite side (85-99c) by seat, side bought and price bucket', table(f"""
    SELECT seat, side, {BUCKET} AS bucket, count(*) AS n, sum(count) AS contracts,
           round(100.0 * avg(won), 2) AS win_pct, round(avg(price), 2) AS avg_price,
           {NET} AS net_c_per_contract, {NETW} AS net_c_weighted
    FROM seats WHERE price >= 85 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
""", ['seat', 'side', 'price', 'trades', 'contracts', 'win %', 'avg price', 'net c/contract (equal-weight)', 'net c/contract (size-weight)'])))

sections.append(('Fade seat (buy the 90-99c side) by category group and seat', table(f"""
    SELECT grp, seat, count(*) AS n, sum(count) AS contracts, round(100.0 * avg(won), 2) AS win_pct,
           round(avg(price), 2) AS avg_price, {NET} AS net_eq, {NETW} AS net_w
    FROM seats WHERE price >= 90 GROUP BY 1, 2 HAVING count(*) >= 2000 ORDER BY 1, 2
""", ['group', 'seat', 'trades', 'contracts', 'win %', 'avg price', 'net eq', 'net weighted'])))

sections.append(('Fade seat by side bought (NO vs YES) and category, taker only', table(f"""
    SELECT grp, side, count(*) AS n, round(100.0 * avg(won), 2) AS win_pct, {NET} AS net_eq, {NETW} AS net_w
    FROM seats WHERE price >= 90 AND seat = 'taker' GROUP BY 1, 2 HAVING count(*) >= 2000 ORDER BY 1, 2
""", ['group', 'side', 'trades', 'win %', 'net eq', 'net weighted'])))

sections.append(('Fade seat by hour of day (ET), taker and maker', table(f"""
    SELECT hour_et, seat, count(*) AS n, round(100.0 * avg(won), 2) AS win_pct, {NET} AS net_eq, {NETW} AS net_w
    FROM seats WHERE price >= 90 GROUP BY 1, 2 ORDER BY 1, 2
""", ['hour ET', 'seat', 'trades', 'win %', 'net eq', 'net weighted'])))

sections.append(('Fade seat by hours to close, taker and maker', table(f"""
    SELECT {HTC} AS htc, seat, count(*) AS n, round(100.0 * avg(won), 2) AS win_pct, {NET} AS net_eq, {NETW} AS net_w
    FROM seats WHERE price >= 90 GROUP BY 1, 2 ORDER BY 1, 2
""", ['hours to close', 'seat', 'trades', 'win %', 'net eq', 'net weighted'])))

sections.append(('Longshot side (1-15c) by category and seat: what mean reversion buys', table(f"""
    SELECT grp, seat, count(*) AS n, round(100.0 * avg(won), 2) AS win_pct, round(avg(price), 2) AS avg_price, {NET} AS net_eq, {NETW} AS net_w
    FROM seats WHERE price <= 15 GROUP BY 1, 2 HAVING count(*) >= 2000 ORDER BY 1, 2
""", ['group', 'seat', 'trades', 'win %', 'avg price', 'net eq', 'net weighted'])))

sections.append(('Every price, both seats (calibration ladder, net of taker fee)', table(f"""
    SELECT price, count(*) AS n, round(100.0 * avg(won), 2) AS win_pct,
           {NET} AS net_all
    FROM seats GROUP BY price ORDER BY price
""", ['price', 'trades', 'win %', 'net c/contract'])))

with open(out_path, 'w', encoding='utf-8') as fh:
    fh.write(f'# Backtest: fade audit on the Becker Kalshi dataset ({today})\n\n')
    fh.write(f'Trades since {args.since} joined to finalized results; {n_all:,} seat-rows (two per trade). '
             'Net = win% x 100 - price - fee, in cents per contract; taker fee 7c*P*(1-P), maker fee 0 (upper bound). '
             'Source: github.com/Jon-Becker/prediction-market-analysis (MIT).\n\n')
    for title, body in sections:
        fh.write(f'## {title}\n\n{body}\n')
print(f'wrote {out_path} ({n_all:,} seat rows)')
for title, body in sections[:3]:
    print('\n##', title)
    print(body)
