#!/usr/bin/env python
"""Favorites and weather audit on the Becker Kalshi dataset (build-queue items 8d, 15c, 15d). Read-only.

Three questions, same seat table as fade_audit.py (both seats of every trade, net of the taker fee):
  8d   "buy the 70-90c side an hour before close" (the operator's 70%+ idea): taker net by price band and hours to close.
  15c  the quoter: MAKER returns in Weather by hour ET and by minutes to close, the last hours in detail.
  15d  the weather-morning arm: TAKER returns in Weather by hour ET on the favourite and longshot sides.

  python scripts/backtests/favorites_weather_audit.py [--since 2024-10-01]
Writes docs/reports/backtest-favorites-weather-<date>.md.
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
ap.add_argument('--since', default='2024-10-01')
args = ap.parse_args()
TR = f"'{args.data}/trades/*.parquet'"
MK = f"'{args.data}/markets/*.parquet'"
today = dt.date.today().isoformat()
out_path = os.path.join(ROOT, 'docs', 'reports', f'backtest-favorites-weather-{today}.md')

con = duckdb.connect()
con.execute('PRAGMA threads=8')
os.makedirs('G:/DATA/prediction-market-analysis/tmp', exist_ok=True)
con.execute("SET temp_directory='G:/DATA/prediction-market-analysis/tmp'")
prefixes = [r[0] for r in con.execute(f"SELECT DISTINCT regexp_extract(event_ticker, '^([A-Z0-9]+)', 1) FROM {MK} WHERE event_ticker IS NOT NULL").fetchall()]
con.execute('CREATE TABLE groups(prefix VARCHAR, grp VARCHAR)')
con.executemany('INSERT INTO groups VALUES (?, ?)', [(p, get_group(p.replace('KX', '', 1) if p.startswith('KX') else p)) for p in prefixes if p])
con.execute(f"""
CREATE TABLE seats AS
WITH mk AS (
    SELECT ticker, event_ticker, result, close_time, regexp_extract(event_ticker, '^([A-Z0-9]+)', 1) AS prefix
    FROM {MK} WHERE status = 'finalized' AND result IN ('yes', 'no')
),
tr AS (
    SELECT t.ticker, t.count, t.yes_price, t.no_price, t.taker_side, t.created_time, m.result, m.close_time, m.prefix
    FROM {TR} t JOIN mk m ON t.ticker = m.ticker WHERE t.created_time >= TIMESTAMP '{args.since}'
),
seat_rows AS (
    SELECT 'taker' AS seat, taker_side AS side, CASE WHEN taker_side = 'yes' THEN yes_price ELSE no_price END AS price,
           CASE WHEN taker_side = result THEN 1 ELSE 0 END AS won, count, created_time, close_time, prefix, ticker FROM tr
    UNION ALL
    SELECT 'maker', CASE WHEN taker_side = 'yes' THEN 'no' ELSE 'yes' END, CASE WHEN taker_side = 'yes' THEN no_price ELSE yes_price END,
           CASE WHEN taker_side <> result THEN 1 ELSE 0 END, count, created_time, close_time, prefix, ticker FROM tr
)
SELECT b.*, COALESCE(g.grp, 'Other') AS grp,
       CASE WHEN b.seat = 'taker' THEN 7.0 * (b.price / 100.0) * (1 - b.price / 100.0) ELSE 0 END AS fee_cents,
       hour(timezone('America/New_York', b.created_time)) AS hour_et,
       date_diff('minute', b.created_time, b.close_time) AS min_to_close
FROM seat_rows b LEFT JOIN groups g ON b.prefix = g.prefix
""")
n_all = con.execute('SELECT count(*) FROM seats').fetchone()[0]


def table(sql, cols):
    rows = con.execute(sql).fetchall()
    return '| ' + ' | '.join(cols) + ' |\n|' + '---|' * len(cols) + '\n' + ''.join('| ' + ' | '.join(str(x) for x in r) + ' |\n' for r in rows)


NET = 'round(100.0 * avg(won) - avg(price) - avg(fee_cents), 3)'
NETW = 'round(100.0 * sum(won * count) / sum(count) - sum(price * count) / sum(count) - sum(fee_cents * count) / sum(count), 3)'
HTC = "CASE WHEN min_to_close < 60 THEN 'a <1h' WHEN min_to_close < 180 THEN 'b 1-3h' WHEN min_to_close < 360 THEN 'c 3-6h' WHEN min_to_close < 1440 THEN 'd 6-24h' WHEN min_to_close < 4320 THEN 'e 1-3d' ELSE 'f >3d' END"
FAV = "CASE WHEN price BETWEEN 70 AND 74 THEN '70-74' WHEN price BETWEEN 75 AND 79 THEN '75-79' WHEN price BETWEEN 80 AND 84 THEN '80-84' WHEN price BETWEEN 85 AND 89 THEN '85-89' WHEN price BETWEEN 90 AND 94 THEN '90-94' ELSE '95-99' END"
MTC = "CASE WHEN min_to_close < 30 THEN 'a <30m' WHEN min_to_close < 60 THEN 'b 30-60m' WHEN min_to_close < 120 THEN 'c 1-2h' WHEN min_to_close < 240 THEN 'd 2-4h' WHEN min_to_close < 480 THEN 'e 4-8h' WHEN min_to_close < 1440 THEN 'f 8-24h' ELSE 'g >24h' END"

sections = [
    ('8d: favourites 70-99c as a TAKER, by price band and hours to close (all categories)', table(f"""
        SELECT {FAV} AS band, {HTC} AS htc, count(*) AS n, round(100.0 * avg(won), 2) AS win_pct, {NET} AS net_eq, {NETW} AS net_w
        FROM seats WHERE seat = 'taker' AND price >= 70 GROUP BY 1, 2 ORDER BY 1, 2
    """, ['band', 'hours to close', 'trades', 'win %', 'net eq', 'net weighted'])),
    ('8d: favourites 70-89c as a TAKER by category', table(f"""
        SELECT grp, count(*) AS n, round(100.0 * avg(won), 2) AS win_pct, round(avg(price), 1) AS avg_price, {NET} AS net_eq, {NETW} AS net_w
        FROM seats WHERE seat = 'taker' AND price BETWEEN 70 AND 89 GROUP BY 1 HAVING count(*) >= 2000 ORDER BY 1
    """, ['group', 'trades', 'win %', 'avg price', 'net eq', 'net weighted'])),
    ('15c: Weather MAKER by minutes to close', table(f"""
        SELECT {MTC} AS mtc, count(*) AS n, round(100.0 * avg(won), 2) AS win_pct, round(avg(price), 1) AS avg_price, {NET} AS net_eq, {NETW} AS net_w
        FROM seats WHERE seat = 'maker' AND grp = 'Weather' GROUP BY 1 ORDER BY 1
    """, ['minutes to close', 'trades', 'win %', 'avg price', 'net eq', 'net weighted'])),
    ('15c: Weather MAKER by hour ET', table(f"""
        SELECT hour_et, count(*) AS n, round(100.0 * avg(won), 2) AS win_pct, round(avg(price), 1) AS avg_price, {NET} AS net_eq, {NETW} AS net_w
        FROM seats WHERE seat = 'maker' AND grp = 'Weather' GROUP BY 1 ORDER BY 1
    """, ['hour ET', 'trades', 'win %', 'avg price', 'net eq', 'net weighted'])),
    ('15c: Weather MAKER by price side and minutes to close (favourite 85c+ vs longshot <=15c)', table(f"""
        SELECT CASE WHEN price >= 85 THEN 'favourite 85c+' WHEN price <= 15 THEN 'longshot <=15c' ELSE 'middle' END AS side, {MTC} AS mtc, count(*) AS n,
               round(100.0 * avg(won), 2) AS win_pct, {NET} AS net_eq, {NETW} AS net_w
        FROM seats WHERE seat = 'maker' AND grp = 'Weather' GROUP BY 1, 2 ORDER BY 1, 2
    """, ['side', 'minutes to close', 'trades', 'win %', 'net eq', 'net weighted'])),
    ('15d: Weather TAKER by hour ET and side (the weather-morning arm trades 08-11 station-local)', table(f"""
        SELECT hour_et, CASE WHEN price >= 85 THEN 'favourite 85c+' WHEN price <= 15 THEN 'longshot <=15c' ELSE 'middle' END AS side, count(*) AS n,
               round(100.0 * avg(won), 2) AS win_pct, {NET} AS net_eq, {NETW} AS net_w
        FROM seats WHERE seat = 'taker' AND grp = 'Weather' GROUP BY 1, 2 ORDER BY 1, 2
    """, ['hour ET', 'side', 'trades', 'win %', 'net eq', 'net weighted'])),
]
with open(out_path, 'w', encoding='utf-8') as fh:
    fh.write(f'# Backtest: favourites (8d) and weather quoter/morning (15c, 15d) on the Becker Kalshi dataset ({today})\n\n')
    fh.write(f'Trades since {args.since}, {n_all:,} seat-rows. Net = win% x 100 - price - fee, cents per contract; taker fee 7c*P*(1-P), maker 0. Source: github.com/Jon-Becker/prediction-market-analysis (MIT).\n\n')
    for title, body in sections:
        fh.write(f'## {title}\n\n{body}\n')
print(f'wrote {out_path} ({n_all:,} seat rows)')
for title, body in sections[:3]:
    print('\n##', title)
    print(body)
