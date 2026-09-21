"""Backlog 157 - executable-bound lead-lag regrade (pre-registered read, 2026-09-21).

The live arm scores a dislocation against the Polymarket MID (`polyPrice`). A mid is not a
price anyone can trade; on a wide book it is an average of two quotes that may both be far
from fair. This regrades every `kalshiSource == 'orderbook'` row (round 116: list-priced rows
are void) against each Polymarket BOUND instead, and stratifies by the Polymarket spread, so
the question "does the edge live only in the wide-spread rows, where the mid is least
trustworthy?" has a number.

Two bounds are reported because the registration's phrase "the adverse side" is ambiguous in
this direction convention and reporting both settles it without a judgement call:

  favourable  BUY_KALSHI_YES -> polyAsk,  BUY_KALSHI_NO -> polyBid
  adverse     BUY_KALSHI_YES -> polyBid,  BUY_KALSHI_NO -> polyAsk

`edge` is always signed so that positive = the dislocation the arm claims, in cents, before
the row's own `feeCents`.

The forward block is the honest half: the signal edge is a claim about the Kalshi price, so
each row is marked out against the SAME ticker's own later orderbook observation in this file
(nearest row at least `--markout` minutes later, within twice that). No fills, no P&L - this
measures the signal, exactly as `leadlag_orderbook_baseline.py` does.
"""

import argparse
import json
import os
import statistics
import sys
from collections import defaultdict

BUCKETS = [(0, 1), (1, 2), (2, 4), (4, 8), (8, 10**9)]


def bucket_label(lo, hi):
    return f"{lo}-{hi}c" if hi < 10**9 else f"{lo}c+"


def load(path):
    rows = []
    with open(path, "r", encoding="utf8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("kalshiSource") != "orderbook":
                continue
            if not isinstance(r.get("polyBid"), (int, float)):
                continue
            if not isinstance(r.get("polyAsk"), (int, float)):
                continue
            rows.append(r)
    return rows


def ts_ms(r):
    t = r.get("ts")
    if not t:
        return None
    from datetime import datetime

    return datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp() * 1000.0


def edges(r):
    """(mid, favourable, adverse) signal edge in cents, before fee."""
    k = r["kalshiPrice"] * 100.0
    mid = r["polyPrice"] * 100.0
    bid = r["polyBid"] * 100.0
    ask = r["polyAsk"] * 100.0
    if r.get("suggestedAction") == "BUY_KALSHI_YES":
        return mid - k, ask - k, bid - k
    # BUY_KALSHI_NO: the arm claims Polymarket values YES BELOW the Kalshi price.
    return k - mid, k - bid, k - ask


def describe(name, vals):
    if not vals:
        return f"  {name:<12} n=0"
    m = statistics.fmean(vals)
    sd = statistics.pstdev(vals) if len(vals) > 1 else 0.0
    se = sd / (len(vals) ** 0.5) if len(vals) > 1 else 0.0
    pos = sum(1 for v in vals if v > 0)
    return (
        f"  {name:<12} n={len(vals):<5} mean {m:+7.2f}c  median {statistics.median(vals):+7.2f}c"
        f"  SE {se:5.2f}  >0 {100.0 * pos / len(vals):5.1f}%"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", default=None)
    ap.add_argument("--markout", type=float, default=5.0, help="forward markout in minutes")
    args = ap.parse_args()

    path = args.path or os.path.join(
        os.environ.get("APPDATA", ""), "oracle-trader", "leadlag-dislocations.jsonl"
    )
    rows = load(path)
    if not rows:
        print("no orderbook-priced rows with a Polymarket book", file=sys.stderr)
        return 1

    print(f"executable-bound regrade of {len(rows)} orderbook rows")
    print(f"  {rows[0].get('ts')}  ->  {rows[-1].get('ts')}")
    print()

    # ---- signal edge, before and after the row's own fee -------------------------------
    for after_fee in (False, True):
        head = "AFTER the row's own fee" if after_fee else "BEFORE fees"
        print(f"signal edge {head}")
        cols = {"mid": [], "favourable": [], "adverse": []}
        for r in rows:
            fee = (r.get("feeCents") or 0.0) if after_fee else 0.0
            m, f, a = edges(r)
            cols["mid"].append(m - fee)
            cols["favourable"].append(f - fee)
            cols["adverse"].append(a - fee)
        for k in ("mid", "favourable", "adverse"):
            print(describe(k, cols[k]))
        print()

    # ---- stratified by Polymarket spread ------------------------------------------------
    print("by Polymarket spread (edge AFTER the row's own fee)")
    print(f"  {'spread':<8} {'n':>5}  {'mid':>9}  {'favourable':>11}  {'adverse':>9}  {'exec%':>6}")
    by = defaultdict(lambda: {"mid": [], "fav": [], "adv": [], "exec": 0})
    for r in rows:
        sp = round((r["polyAsk"] - r["polyBid"]) * 100.0, 4)
        for lo, hi in BUCKETS:
            if lo <= sp < hi:
                key = bucket_label(lo, hi)
                break
        else:
            key = "?"
        fee = r.get("feeCents") or 0.0
        m, f, a = edges(r)
        by[key]["mid"].append(m - fee)
        by[key]["fav"].append(f - fee)
        by[key]["adv"].append(a - fee)
        by[key]["exec"] += 1 if r.get("executed") else 0
    order = [bucket_label(lo, hi) for lo, hi in BUCKETS]
    for key in order:
        d = by.get(key)
        if not d or not d["mid"]:
            continue
        n = len(d["mid"])
        print(
            f"  {key:<8} {n:>5}  {statistics.fmean(d['mid']):+9.2f}  "
            f"{statistics.fmean(d['fav']):+11.2f}  {statistics.fmean(d['adv']):+9.2f}  "
            f"{100.0 * d['exec'] / n:5.1f}%"
        )
    print()

    # ---- forward markout against the same ticker's own later orderbook row ---------------
    win = args.markout * 60_000.0
    per = defaultdict(list)
    for r in rows:
        t = ts_ms(r)
        if t is None:
            continue
        per[r.get("kalshiTicker")].append((t, r))
    for k in per:
        per[k].sort(key=lambda x: x[0])

    print(f"forward Kalshi markout at +{args.markout:g} min (same ticker, own later orderbook row)")
    print(f"  {'spread':<8} {'n':>5}  {'markout':>9}  {'SE':>5}  {'edge@adverse>0':>15}  {'markout|adv>0':>13}")
    fwd = defaultdict(lambda: {"mk": [], "advpos": [], "mk_advpos": []})
    total = 0
    for ticker, seq in per.items():
        for i, (t, r) in enumerate(seq):
            nxt = None
            for t2, r2 in seq[i + 1 :]:
                if t2 - t >= win:
                    if t2 - t <= 2 * win:
                        nxt = r2
                    break
            if nxt is None:
                continue
            total += 1
            move = (nxt["kalshiPrice"] - r["kalshiPrice"]) * 100.0
            # signed the way the arm would profit: a YES buy wants the Kalshi price to rise.
            mk = move if r.get("suggestedAction") == "BUY_KALSHI_YES" else -move
            sp = round((r["polyAsk"] - r["polyBid"]) * 100.0, 4)
            for lo, hi in BUCKETS:
                if lo <= sp < hi:
                    key = bucket_label(lo, hi)
                    break
            else:
                key = "?"
            _, _, adv = edges(r)
            adv -= r.get("feeCents") or 0.0
            fwd[key]["mk"].append(mk)
            fwd[key]["advpos"].append(1 if adv > 0 else 0)
            if adv > 0:
                fwd[key]["mk_advpos"].append(mk)
    for key in order:
        d = fwd.get(key)
        if not d or not d["mk"]:
            continue
        n = len(d["mk"])
        sd = statistics.pstdev(d["mk"]) if n > 1 else 0.0
        se = sd / (n ** 0.5) if n > 1 else 0.0
        sub = d["mk_advpos"]
        sub_txt = f"{statistics.fmean(sub):+7.2f}c n={len(sub)}" if sub else "        -"
        print(
            f"  {key:<8} {n:>5}  {statistics.fmean(d['mk']):+9.2f}  {se:5.2f}  "
            f"{100.0 * sum(d['advpos']) / n:14.1f}%  {sub_txt:>13}"
        )
    allmk = [v for d in fwd.values() for v in d["mk"]]
    allsub = [v for d in fwd.values() for v in d["mk_advpos"]]
    if allmk:
        se = statistics.pstdev(allmk) / (len(allmk) ** 0.5)
        print(f"  {'ALL':<8} {len(allmk):>5}  {statistics.fmean(allmk):+9.2f}  {se:5.2f}")
    if allsub:
        se = statistics.pstdev(allsub) / (len(allsub) ** 0.5) if len(allsub) > 1 else 0.0
        print(
            f"  rows whose adverse-bound edge clears the fee: n={len(allsub)}  "
            f"markout {statistics.fmean(allsub):+.2f}c  SE {se:.2f}"
        )
    print()
    print(f"({total} of {len(rows)} rows had a same-ticker orderbook row in the markout window)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
