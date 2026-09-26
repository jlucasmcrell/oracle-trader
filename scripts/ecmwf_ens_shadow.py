"""ECMWF ENS weather shadow (BACKLOG 149, registered 2026-09-25, built 2026-09-26). Read-only, free, no key.

Question: does the ECMWF 51-member ensemble price the Kalshi daily-high / daily-low BRACKETS better than the models
we already have? HRRR (BACKLOG 116) is the control: it wins on mean absolute error but lost on the cheap brackets,
which is a distributional question an ensemble can answer and a single deterministic run cannot.

What the registration said, and what the source actually has - stated here because they differ. Backlog 149 names
`mx2t6`/`mn2t6` at 0.25 deg. The ECMWF open-data index for `stream=enfo, resol=0p25` has NEITHER: it serves
**`mx2t3`/`mn2t3`** (3-hourly extrema), and `type=cf` is not indexed alongside them either, so the usable ensemble is
the **50 perturbed members** (`type=pf`), without the control run. Probed 2026-09-26: `mx2t6` -> "No index entries for
param=mx2t6. Did you mean 'mx2t3'"; `type=cf` -> "No index entries for type=cf". 3-hourly extrema are strictly better
for a daily max than 6-hourly, so the substitution costs nothing; the missing control costs one member of fifty.

Ensemble -> bracket: each member gives one daily max (the max of its 3-hourly maxima inside the station's LOCAL day),
so 50 members give a distribution, and P(bracket) is the share of members landing in it. Brackets are Kalshi's
2 degF bands (`T<low>` .. `B<lo>.5` style questions settle on a 2-degree band), floored to an even Fahrenheit degree.

Observations come from `data/hrrr-shadow/grades.jsonl`, which already grades the same 27 stations from the same NWS
observations - the ENS read must be comparable to the HRRR control, so it must not use a different truth.

  python scripts/ecmwf_ens_shadow.py pull                 the newest ENS run, D+1..D+3, all 27 stations
  python scripts/ecmwf_ens_shadow.py pull --days 1        D+1 only (one third of the download)
  python scripts/ecmwf_ens_shadow.py report               calibration and the registered gate

The gate (backlog 149, unchanged): positive at 95% over >= 30 station-days AT THE MODAL BRACKET -> register a taker
weather arm. Until then weather stays closed and this file records why. `report` prints the station-day count so the
bar is never guessed at. The book-relative leg (the modal bracket's ask) is added when the count is in reach; there
is no point pulling weather books for a sample that does not exist yet.
"""
import argparse
import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "data", "ecmwf-ens")
FORECASTS = os.path.join(OUT_DIR, "forecasts.jsonl")
HRRR_GRADES = os.path.join(REPO, "data", "hrrr-shadow", "grades.jsonl")
RUN_LOG = os.path.join(OUT_DIR, "run.log")

# The 27 stations of scripts/hrrr-shadow.mjs, kept identical on purpose: same points, same observations, same grader.
STATIONS = {
    "NYC": (40.78, -73.97, "America/New_York"), "EWR": (40.69, -74.17, "America/New_York"),
    "TTN": (40.28, -74.81, "America/New_York"), "PHIL": (39.87, -75.24, "America/New_York"),
    "BOS": (42.36, -71.01, "America/New_York"), "DC": (38.85, -77.04, "America/New_York"),
    "ATL": (33.64, -84.43, "America/New_York"), "DET": (42.21, -83.35, "America/New_York"),
    "SDF": (38.17, -85.74, "America/New_York"), "DAL": (32.90, -97.04, "America/Chicago"),
    "HOU": (29.65, -95.28, "America/Chicago"), "AUS": (30.19, -97.67, "America/Chicago"),
    "SATX": (29.53, -98.47, "America/Chicago"), "NOLA": (29.99, -90.25, "America/Chicago"),
    "CHI": (41.79, -87.75, "America/Chicago"), "KC": (39.30, -94.71, "America/Chicago"),
    "MSP": (44.88, -93.22, "America/Chicago"), "OKC": (35.39, -97.60, "America/Chicago"),
    "DEN": (39.86, -104.67, "America/Denver"), "PHX": (33.43, -112.01, "America/Phoenix"),
    "LAX": (33.94, -118.41, "America/Los_Angeles"), "SFO": (37.62, -122.38, "America/Los_Angeles"),
    "SEA": (47.45, -122.31, "America/Los_Angeles"), "PDX": (45.59, -122.60, "America/Los_Angeles"),
    "LAS": (36.08, -115.15, "America/Los_Angeles"), "SAN": (32.73, -117.19, "America/Los_Angeles"),
    "MIA": (25.79, -80.29, "America/New_York"),
}
MEMBERS = 50  # type=pf only; the control run is not in the 0p25 enfo index (see the module docstring)
BRACKET = 2.0  # degF; Kalshi's daily temperature bands


def log(msg):
    line = f"[{datetime.now(timezone.utc).isoformat()}] {msg}"
    print(line)
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(RUN_LOG, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def bracket_floor(f):
    """The even-Fahrenheit floor of the 2-degree band a value settles in."""
    return math.floor(f / BRACKET) * BRACKET


def pull(days, keep):
    from ecmwf.opendata import Client
    import numpy as np
    import xarray as xr

    os.makedirs(OUT_DIR, exist_ok=True)
    client = Client(source="ecmwf")
    run = client.latest(stream="enfo", type="pf", param="mx2t3")
    run = run.replace(tzinfo=timezone.utc) if run.tzinfo is None else run
    log(f"ENS run {run.isoformat()}; D+1..D+{days}; {len(STATIONS)} stations")

    # Only the steps that can land inside a COMPLETE local day D+1..D+days. The earliest station is UTC-4, so local
    # day D+1 opens at step 28 (floor to the 3-hourly grid: 27); the latest is UTC-7, so local day D+days closes at
    # 24*(days+1)+7 (round up: +9). Steps outside that contribute to no complete day and are not downloaded - ECMWF
    # open data has no spatial or temporal subsetting, so every step is a whole 0.25 deg globe, ~32 MB per field.
    first, last = 27, 24 * (days + 1) + 9
    steps = list(range(first, last + 1, 3))
    # member -> local date -> list of 3-hourly values, per station and per field.
    acc = {"mx2t3": defaultdict(lambda: defaultdict(lambda: defaultdict(list))),
           "mn2t3": defaultdict(lambda: defaultdict(lambda: defaultdict(list)))}
    tmp = os.path.join(OUT_DIR, "_chunk.grib2")
    for param in ("mx2t3", "mn2t3"):
        # One step per request: a whole-globe 0.25 deg field is ~32 MB per member-set, so chunking keeps peak disk at
        # one field rather than the ~1.1 GB the full D+1..D+3 pull would otherwise hold at once.
        for step in steps:
            if os.path.exists(tmp):
                os.remove(tmp)
            client.retrieve(stream="enfo", type="pf", param=param, step=step, target=tmp)
            ds = xr.open_dataset(tmp, engine="cfgrib", backend_kwargs={"indexpath": ""})
            var = list(ds.data_vars)[0]
            valid = run + timedelta(hours=step)
            for name, (lat, lon, tz) in STATIONS.items():
                col = ds[var].sel(latitude=lat, longitude=lon % 360, method="nearest")
                vals = np.atleast_1d(col.values)
                # Label by the file's own member numbers, not by position: a step that came back short would
                # otherwise silently shift every member's day series by one.
                numbers = [int(n) for n in np.atleast_1d(ds["number"].values)] if "number" in ds.coords else [1]
                # The window is (valid-3h, valid]; attribute it to the local date of its midpoint.
                local_date = (valid - timedelta(hours=1, minutes=30)).astimezone(ZoneInfo(tz)).strftime("%Y-%m-%d")
                for member, kelvin in zip(numbers, vals):
                    if np.isfinite(kelvin):
                        acc[param][name][local_date][member].append(float(kelvin) * 9 / 5 - 459.67)
            ds.close()
        log(f"{param}: {len(steps)} steps decoded")
    if os.path.exists(tmp) and not keep:
        os.remove(tmp)

    # Only complete local days: a day whose windows are clipped by the run start or the forecast horizon would give a
    # daily max over part of a day, which is a different number from the one the market settles.
    expected = 8
    written = 0
    with open(FORECASTS, "a", encoding="utf-8") as fh:
        for name in STATIONS:
            dates = set(acc["mx2t3"][name]) | set(acc["mn2t3"][name])
            for local_date in sorted(dates):
                highs, lows = [], []
                for member in range(1, MEMBERS + 1):
                    hs = acc["mx2t3"][name][local_date].get(member, [])
                    ls = acc["mn2t3"][name][local_date].get(member, [])
                    if len(hs) == expected:
                        highs.append(round(max(hs), 2))
                    if len(ls) == expected:
                        lows.append(round(min(ls), 2))
                if len(highs) < MEMBERS or len(lows) < MEMBERS:
                    continue
                fh.write(json.dumps({
                    "at": datetime.now(timezone.utc).isoformat(), "run": run.isoformat(), "station": name,
                    "localDate": local_date, "leadDays": (datetime.strptime(local_date, "%Y-%m-%d").date() - run.date()).days,
                    "members": len(highs), "highsF": highs, "lowsF": lows,
                }) + "\n")
                written += 1
    log(f"wrote {written} station-day rows to {FORECASTS}")
    return 0


def report():
    if not os.path.exists(FORECASTS):
        print("no ENS rows yet; run `pull` first")
        return 1
    obs = {}
    if os.path.exists(HRRR_GRADES):
        for line in open(HRRR_GRADES, encoding="utf-8"):
            if not line.strip():
                continue
            g = json.loads(line)
            if g.get("obsMaxF") is not None:
                obs[(g["station"], g["localDate"])] = g["obsMaxF"]
    rows = [json.loads(l) for l in open(FORECASTS, encoding="utf-8") if l.strip()]
    # One row per station-day and lead: the newest run wins, so a re-pull does not double-count.
    newest = {}
    for r in rows:
        newest[(r["station"], r["localDate"], r["leadDays"])] = r
    graded = [(k, r) for k, r in newest.items() if (k[0], k[1]) in obs]

    print(f"ECMWF ENS shadow (BACKLOG 149): {len(newest)} station-day-lead rows, {len(graded)} graded against NWS observations")
    print(f"observations available for {len(obs)} station-days (source: data/hrrr-shadow/grades.jsonl)")
    if not graded:
        print("\nNothing graded yet - the first pull's target days have not been observed. The registered gate needs")
        print(">= 30 graded station-days AT THE MODAL BRACKET; nothing is decided or registered until then.")
        return 0
    by_lead = defaultdict(list)
    for (station, local_date, lead), r in graded:
        o = obs[(station, local_date)]
        highs = r["highsF"]
        modal_counts = defaultdict(int)
        for h in highs:
            modal_counts[bracket_floor(h)] += 1
        modal, hits = max(modal_counts.items(), key=lambda kv: (kv[1], -abs(kv[0])))
        p_modal = hits / len(highs)
        landed = bracket_floor(o) == modal
        brier = sum((modal_counts[b] / len(highs) - (1.0 if bracket_floor(o) == b else 0.0)) ** 2 for b in modal_counts)
        by_lead[lead].append({
            "err": sum(highs) / len(highs) - o, "pModal": p_modal, "landed": landed, "brier": brier,
            "day": local_date,
        })
    print(f"\n{'lead':<6}{'n':>5}{'ENS mean bias':>15}{'MAE':>7}{'modal P':>9}{'modal hit':>11}{'edge vs P':>11}{'95% band':>20}")
    everything = []
    for lead in sorted(by_lead):
        everything += by_lead[lead]
        _line(f"D+{lead}", by_lead[lead])
    if len(by_lead) > 1:
        _line("ALL", everything)
    print("\nGate (backlog 149): >= 30 graded station-days at the modal bracket AND a 95% band above zero -> register a")
    print("taker weather arm. 'edge vs P' is (hit - modal probability): positive means the ensemble UNDERSTATES its own")
    print("modal bracket, which is the direction a taker needs. The book-relative leg (modal bracket's ask) is added")
    print("once the count is within reach; grading against a price we never recorded would not be the registered read.")
    return 0


def _line(name, rows):
    n = len(rows)
    bias = sum(r["err"] for r in rows) / n
    mae = sum(abs(r["err"]) for r in rows) / n
    p = sum(r["pModal"] for r in rows) / n
    hit = sum(1 for r in rows if r["landed"]) / n
    edges = [(1.0 if r["landed"] else 0.0) - r["pModal"] for r in rows]
    mean = sum(edges) / n
    by_day = defaultdict(list)
    for r, e in zip(rows, edges):
        by_day[r["day"]].append(e)
    g = len(by_day)
    if g >= 2:
        ss = sum((sum(v) - len(v) * mean) ** 2 for v in by_day.values())
        se = math.sqrt(g / (g - 1) * ss) / n
        band = f"[{mean - 1.96 * se:+.3f}, {mean + 1.96 * se:+.3f}]"
    else:
        band = "[one day cluster]"
    print(f"{name:<6}{n:>5}{bias:>+15.2f}{mae:>7.2f}{p:>9.2f}{hit:>11.2f}{mean:>+11.3f}{band:>20}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["pull", "report"])
    ap.add_argument("--days", type=int, default=3, help="forecast days D+1..D+days (registration: 3)")
    ap.add_argument("--keep", action="store_true", help="keep the last grib chunk on disk for inspection")
    args = ap.parse_args()
    return pull(args.days, args.keep) if args.command == "pull" else report()


if __name__ == "__main__":
    sys.exit(main())
