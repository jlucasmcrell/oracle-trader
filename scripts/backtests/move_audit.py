#!/usr/bin/env python
"""Move audit on the Becker Kalshi dataset (build-queue item 15b): what happens AFTER a fast move.

Rebuilds one-minute candles from the trade tape (last price and trade count per minute per market), then
for every minute with a traded move of >= 8c over the previous 10 minutes (>= 3 traded minutes in the window,
market >= 6 h from close, post-move price 5-95c: the mean-reversion arm's rule) scores two seats held to
settlement as a TAKER at the post-move price: MEAN REVERSION buys the side the price moved away from,
MOMENTUM buys the side it moved toward. One signal per market per 6-hour block (the live arm enters once).
Net = win% x 100 - price - fee (cents per contract), taker fee 7c*P*(1-P).

  python scripts/backtests/move_audit.py [--since 2024-10-01]
Writes docs/reports/backtest-move-audit-<date>.md.
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
ap.add_argument('--min-move', type=int, default=8)
args = ap.parse_args()
TR = f"'{args.data}/trades/*.parquet'"
MK = f"'{args.data}/markets/*.parquet'"
today = dt.date.today().isoformat()
out_path = os.path.join(ROOT, 'docs', 'reports', f'backtest-move-audit-{today}.md')

con = duckdb.connect()
con.execute('PRAGMA threads=8')
os.makedirs('G:/DATA/prediction-market-analysis/tmp', exist_ok=True)
con.execute("SET temp_directory='G:/DATA/prediction-market-analysis/tmp'")
prefixes = [r[0] for r in con.execute(f"SELECT DISTINCT regexp_extract(event_ticker, '^([A-Z0-9]+)', 1) FROM {MK} WHERE event_ticker IS NOT NULL").fetchall()]
con.execute('CREATE TABLE groups(prefix VARCHAR, grp VARCHAR)')
con.executemany('INSERT INTO groups VALUES (?, ?)', [(p, get_group(p.replace('KX', '', 1) if p.startswith('KX') else p)) for p in prefixes if p])

con.execute(f"""
CREATE TABLE candles AS
WITH mk AS (
    SELECT ticker, result, close_time, regexp_extract(event_ticker, '^([A-Z0-9]+)', 1) AS prefix
    FROM {MK} WHERE status = 'finalized' AND result IN ('yes', 'no') AND close_time IS NOT NULL
)
SELECT t.ticker, m.result, m.close_time, m.prefix,
       date_trunc('minute', t.created_time) AS minute,
       arg_max(t.yes_price, t.created_time) AS close_yes,
       count(*) AS trades,
       -- bid-ask-bounce control: a minute where takers bought BOTH sides brackets the last price inside the spread
       count(DISTINCT t.taker_side) AS sides,
       min(CASE WHEN t.taker_side = 'yes' THEN t.yes_price END) AS yes_ask_seen,
       min(CASE WHEN t.taker_side = 'no' THEN t.no_price END) AS no_ask_seen
FROM {TR} t JOIN mk m ON t.ticker = m.ticker
WHERE t.created_time >= TIMESTAMP '{args.since}'
GROUP BY 1, 2, 3, 4, 5
""")
n_candles = con.execute('SELECT count(*) FROM candles').fetchone()[0]

con.execute(f"""
CREATE TABLE moves AS
WITH w AS (
    SELECT *,
           first_value(close_yes) OVER (PARTITION BY ticker ORDER BY minute RANGE BETWEEN INTERVAL 10 MINUTE PRECEDING AND CURRENT ROW) AS from_yes,
           count(*) OVER (PARTITION BY ticker ORDER BY minute RANGE BETWEEN INTERVAL 10 MINUTE PRECEDING AND CURRENT ROW) AS traded_minutes,
           date_diff('minute', minute, close_time) / 60.0 AS hours_to_close
    FROM candles
),
sig AS (
    SELECT *, close_yes - from_yes AS move_cents,
           floor(epoch(minute) / 21600) AS block6h
    FROM w
    WHERE abs(close_yes - from_yes) >= {args.min_move} AND traded_minutes >= 3 AND hours_to_close >= 6
      AND close_yes BETWEEN 5 AND 95
),
first_per_block AS (
    SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY ticker, block6h ORDER BY minute) AS rn FROM sig) WHERE rn = 1
)
SELECT s.*, COALESCE(g.grp, 'Other') AS grp,
       -- mean reversion buys the side the price moved away from; momentum the side it moved toward
       CASE WHEN move_cents > 0 THEN 'NO' ELSE 'YES' END AS mr_side,
       CASE WHEN move_cents > 0 THEN 100 - close_yes ELSE close_yes END AS mr_price,
       CASE WHEN (move_cents > 0 AND result = 'no') OR (move_cents < 0 AND result = 'yes') THEN 1 ELSE 0 END AS mr_won,
       CASE WHEN move_cents > 0 THEN close_yes ELSE 100 - close_yes END AS mo_price,
       CASE WHEN (move_cents > 0 AND result = 'yes') OR (move_cents < 0 AND result = 'no') THEN 1 ELSE 0 END AS mo_won
FROM first_per_block s LEFT JOIN groups g ON s.prefix = g.prefix
""")
n_moves = con.execute('SELECT count(*) FROM moves').fetchone()[0]


def table(sql, cols):
    rows = con.execute(sql).fetchall()
    return '| ' + ' | '.join(cols) + ' |\n|' + '---|' * len(cols) + '\n' + ''.join('| ' + ' | '.join(str(x) for x in r) + ' |\n' for r in rows)


FEE = lambda p: f'7.0 * ({p} / 100.0) * (1 - {p} / 100.0)'  # noqa: E731
MR_NET = f'round(100.0 * avg(mr_won) - avg(mr_price) - avg({FEE("mr_price")}), 3)'
MO_NET = f'round(100.0 * avg(mo_won) - avg(mo_price) - avg({FEE("mo_price")}), 3)'
PB = "CASE WHEN mr_price < 20 THEN 'a <20c' WHEN mr_price < 35 THEN 'b 20-34c' WHEN mr_price < 50 THEN 'c 35-49c' WHEN mr_price < 65 THEN 'd 50-64c' WHEN mr_price < 80 THEN 'e 65-79c' ELSE 'f 80c+' END"

sections = [
    ('By the price mean reversion would pay (all categories)', table(f"""
        SELECT {PB} AS mr_buy_price, count(*) AS n, round(avg(abs(move_cents)), 1) AS avg_move,
               round(100.0 * avg(mr_won), 2) AS mr_win_pct, {MR_NET} AS mr_net_c, round(100.0 * avg(mo_won), 2) AS mo_win_pct, {MO_NET} AS mo_net_c
        FROM moves GROUP BY 1 ORDER BY 1
    """, ['MR buy price', 'signals', 'avg move c', 'MR win %', 'MR net c/contract', 'MOM win %', 'MOM net c/contract'])),
    ('By category (MR buy price >= 35c, the v2 fence)', table(f"""
        SELECT grp, count(*) AS n, round(100.0 * avg(mr_won), 2) AS mr_win, {MR_NET} AS mr_net, round(100.0 * avg(mo_won), 2) AS mo_win, {MO_NET} AS mo_net
        FROM moves WHERE mr_price >= 35 GROUP BY 1 HAVING count(*) >= 300 ORDER BY 1
    """, ['group', 'signals', 'MR win %', 'MR net', 'MOM win %', 'MOM net'])),
    ('By category, all prices', table(f"""
        SELECT grp, count(*) AS n, round(avg(mr_price), 1) AS avg_mr_price, round(100.0 * avg(mr_won), 2) AS mr_win, {MR_NET} AS mr_net, round(100.0 * avg(mo_won), 2) AS mo_win, {MO_NET} AS mo_net
        FROM moves GROUP BY 1 HAVING count(*) >= 300 ORDER BY 1
    """, ['group', 'signals', 'avg MR price', 'MR win %', 'MR net', 'MOM win %', 'MOM net'])),
    ('By move size (MR buy price >= 35c)', table(f"""
        SELECT CASE WHEN abs(move_cents) < 12 THEN 'a 8-11c' WHEN abs(move_cents) < 20 THEN 'b 12-19c' WHEN abs(move_cents) < 30 THEN 'c 20-29c' ELSE 'd 30c+' END AS move, count(*) AS n,
               round(100.0 * avg(mr_won), 2) AS mr_win, {MR_NET} AS mr_net, round(100.0 * avg(mo_won), 2) AS mo_win, {MO_NET} AS mo_net
        FROM moves WHERE mr_price >= 35 GROUP BY 1 ORDER BY 1
    """, ['move', 'signals', 'MR win %', 'MR net', 'MOM win %', 'MOM net'])),
    ('Bounce control: signal minutes where takers bought both sides, MR entered at the price a taker actually PAID for that side that minute', table(f"""
        SELECT {PB} AS mr_buy_price, count(*) AS n, round(100.0 * avg(mr_won), 2) AS mr_win,
               round(100.0 * avg(mr_won) - avg(paid) - avg(7.0 * (paid / 100.0) * (1 - paid / 100.0)), 3) AS mr_net_at_paid,
               {MR_NET} AS mr_net_at_last
        FROM (SELECT *, CASE WHEN mr_side = 'YES' THEN yes_ask_seen ELSE no_ask_seen END AS paid FROM moves WHERE sides = 2)
        WHERE paid IS NOT NULL GROUP BY 1 ORDER BY 1
    """, ['MR buy price', 'signals', 'MR win %', 'MR net at price paid', 'MR net at last price'])),
    ('By hours to close (MR buy price >= 35c)', table(f"""
        SELECT CASE WHEN hours_to_close < 12 THEN 'a 6-12h' WHEN hours_to_close < 24 THEN 'b 12-24h' WHEN hours_to_close < 72 THEN 'c 1-3d' ELSE 'd >3d' END AS htc, count(*) AS n,
               round(100.0 * avg(mr_won), 2) AS mr_win, {MR_NET} AS mr_net, round(100.0 * avg(mo_won), 2) AS mo_win, {MO_NET} AS mo_net
        FROM moves WHERE mr_price >= 35 GROUP BY 1 ORDER BY 1
    """, ['hours to close', 'signals', 'MR win %', 'MR net', 'MOM win %', 'MOM net'])),
]
with open(out_path, 'w', encoding='utf-8') as fh:
    fh.write(f'# Backtest: move audit (mean reversion vs momentum) on the Becker Kalshi dataset ({today})\n\n')
    fh.write(f'Trades since {args.since}; {n_candles:,} one-minute candles; {n_moves:,} qualifying moves (>= {args.min_move}c in 10 min, >= 3 traded minutes, >= 6 h to close, post-move 5-95c, one per market per 6 h). '
             'Both seats are takers at the post-move price, held to settlement, fee 7c*P*(1-P). MR = buy the side the price moved away from; MOM = buy the side it moved toward. '
             'Source: github.com/Jon-Becker/prediction-market-analysis (MIT).\n\n')
    for title, body in sections:
        fh.write(f'## {title}\n\n{body}\n')
print(f'wrote {out_path}: {n_candles:,} candles, {n_moves:,} moves')
for title, body in sections[:2]:
    print('\n##', title)
    print(body)
