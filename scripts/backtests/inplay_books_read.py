"""Read for BACKLOG 165 (registered 2026-09-19, due 2026-09-26): does Kalshi's in-game book lag the free MLB
Stats API play-by-play by more than the taker fee?

The recorder (`scripts/inplay-books.mjs`, task OracleTrader-InplayBooks) writes one row per live game every ~15 s
with the feed state and every Kalshi book for that game. The registered statistic is, per SCORING PLAY (a change in
the feed's run totals): how many recorder cycles pass before the moneyline / RFI / totals top moves, and the cents a
taker would have at the stale book after Kalshi's fee.

Decision unit: one scoring play x one market. The "stale" price is the ask in the FIRST row that already carries the
new score; the reference is the mid AFTER the top has moved, which is what the venue itself decided the news was
worth. Edge = (post-move mid) - (stale ask) - taker fee, so a positive number means the stale ask was cheap by that
much per contract. Only the side the run favours is bought: the team that scored on a moneyline, and OVER on a
total (every KXMLBTOTAL / KXMLBRFI market in the feed is a "more runs" question, so a run can only help it).

Usage: python scripts/backtests/inplay_books_read.py [--since 2026-09-22]
"""
import argparse
import glob
import json
import math
import os
import statistics
from collections import defaultdict

FEE = lambda p: math.ceil(7 * p * (1 - p)) / 100.0  # Kalshi taker fee, one contract, in dollars


def top(b):
    """The comparable top of book. A missing side is part of the top, so None is a value, not a skip."""
    return (b.get("bid"), b.get("ask"))


def load(paths):
    games = defaultdict(list)
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue  # a torn final line
                if row.get("gamePk") and row.get("feed") and row.get("books"):
                    games[row["gamePk"]].append(row)
    for rows in games.values():
        rows.sort(key=lambda r: r["ts"])
    return games


def side_of(ticker, game, scored_home):
    """Which outcome the run favours, or None if this market cannot be read that way."""
    series = ticker.split("-")[0]
    if series in ("KXMLBTOTAL", "KXMLBRFI"):
        return "over"
    if series == "KXMLBGAME":
        team = ticker.rsplit("-", 1)[-1]
        if team == game["home"]:
            return "home" if scored_home else None
        if team == game["away"]:
            return "away" if not scored_home else None
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-09-22")
    ap.add_argument("--dir", default="data/inplay-books")
    args = ap.parse_args()
    paths = sorted(p for p in glob.glob(os.path.join(args.dir, "*.jsonl")) if os.path.basename(p)[:10] >= args.since)
    games = load(paths)
    rows_total = sum(len(v) for v in games.values())

    plays = 0
    per_series = defaultdict(list)
    never_moved = defaultdict(int)
    no_ask = defaultdict(int)
    for gamePk, rows in games.items():
        for i in range(1, len(rows)):
            prev, cur = rows[i - 1], rows[i]
            pa, ph = prev["feed"].get("awayRuns"), prev["feed"].get("homeRuns")
            ca, ch = cur["feed"].get("awayRuns"), cur["feed"].get("homeRuns")
            if None in (pa, ph, ca, ch) or (ca, ch) == (pa, ph):
                continue
            if ca < pa or ch < ph:
                continue  # a feed correction, not a run
            scored_home = ch > ph
            plays += 1
            for ticker, book in cur["books"].items():
                series = ticker.split("-")[0]
                side = side_of(ticker, cur, scored_home)
                if side is None:
                    continue
                stale = top(book)
                # Buying the favoured side means paying its own ask: OVER/that team is the YES leg of that ticker.
                ask = book.get("ask")
                if ask is None or not book.get("askSize"):
                    no_ask[series] += 1
                    continue
                cycles, moved = 0, None
                for later in rows[i + 1:]:
                    b2 = later["books"].get(ticker)
                    if b2 is None:
                        continue
                    cycles += 1
                    if top(b2) != stale:
                        moved = (later, b2)
                        break
                if moved is None:
                    never_moved[series] += 1
                    continue
                later, b2 = moved
                bid2, ask2 = b2.get("bid"), b2.get("ask")
                if bid2 is None or ask2 is None:
                    continue  # no two-sided reference price to mark against
                mid2 = (bid2 + ask2) / 2
                secs = (
                    _parse(later["ts"]) - _parse(cur["ts"])
                )
                per_series[series].append(
                    {
                        "cycles": cycles,
                        "secs": secs,
                        "ask": ask,
                        "askSize": book["askSize"],
                        "mid2": mid2,
                        "edge": mid2 - ask - FEE(ask),
                        "day": cur["ts"][:10],
                    }
                )

    print(f"in-play books read (BACKLOG 165) - {len(paths)} day file(s) from {args.since}, {rows_total} rows, {len(games)} games")
    print(f"scoring plays detected: {plays}")
    print()
    print(f"{'series':<12}{'n':>6}{'cycles p50':>12}{'p90':>6}{'secs p50':>10}{'edge c/contract':>17}{'95% band':>22}{'pos':>6}{'depth p50':>11}")
    allrows = []
    for series, rows in sorted(per_series.items()):
        allrows += rows
        _line(series, rows)
    if len(per_series) > 1:
        _line("ALL", allrows)
    print()
    for series in sorted(set(list(never_moved) + list(no_ask))):
        print(f"  {series}: {never_moved.get(series,0)} tops never moved inside the recording, {no_ask.get(series,0)} had no ask to take")
    print()
    print("Registered rule (BACKLOG 165): 'cents a taker gets at a stale book, after fees'; a registration follows only")
    print("if that is positive. The band is day-clustered over UTC days.")


def _parse(ts):
    import datetime

    return datetime.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc).timestamp()


def _line(name, rows):
    if not rows:
        print(f"{name:<12}{0:>6}")
        return
    cy = sorted(r["cycles"] for r in rows)
    sc = sorted(r["secs"] for r in rows)
    edges = [100 * r["edge"] for r in rows]
    mean = sum(edges) / len(edges)
    by_day = defaultdict(list)
    for r in rows:
        by_day[r["day"]].append(100 * r["edge"])
    g = len(by_day)
    if g >= 2:
        ss = sum((sum(v) - len(v) * mean) ** 2 for v in by_day.values())
        se = math.sqrt(g / (g - 1) * ss) / len(rows)
        lo, hi = mean - 1.96 * se, mean + 1.96 * se
        band = f"[{lo:+.2f}, {hi:+.2f}]"
    else:
        band = "[one day cluster]"
    pos = sum(1 for e in edges if e > 0) / len(edges)
    depth = statistics.median(r["askSize"] for r in rows)
    print(
        f"{name:<12}{len(rows):>6}{_p(cy,.5):>12.0f}{_p(cy,.9):>6.0f}{_p(sc,.5):>10.0f}{mean:>+17.2f}{band:>22}{pos:>6.0%}{depth:>11.0f}"
    )


def _p(sorted_vals, q):
    if not sorted_vals:
        return 0
    return sorted_vals[min(len(sorted_vals) - 1, int(q * len(sorted_vals)))]


if __name__ == "__main__":
    main()
