# SportsGameOdds V2 Lifecycle Upgrade

Implemented: 2026-09-05

## Scope

The SportsGameOdds feed remains shadow-only. It cannot place, veto, resize, or approve orders.

## Changes

- Discovery requests now include `includeOpenCloseOdds=true`.
- Discovery cadence changed from every 6 hours to every 12 hours.
- Exact SportsGameOdds event IDs matched to Kalshi are persisted.
- Subsequent requests target only matched `eventIDs`.
- Targeted snapshots are taken near game start and immediately before start.
- Finalized events are fetched after the game and graded from official team scores.
- Current bookmaker pairs older than 30 minutes are excluded from consensus.
- Opening and closing bookmaker odds are independently de-vigged.
- SportsGameOdds fair odds are used only as fallback when bookmaker detail is filtered.
- CLV, Brier score, stale-book exclusions, matched events, and object usage are tracked.
- A 2,400-object monthly local ceiling preserves margin under the 2,500-object plan.
- Daily and weekly Prompt Studio reports now include the SportsGameOdds report.

## Report

```powershell
npm run sgo:report
```

The report reads point-in-time SportsGameOdds anchor observations from the Oracle Trader episode ledger and reports lifecycle phase counts, stale quotes excluded, graded outcomes, closing-line value, and calibration.

## Live verification

The first upgraded discovery found and persisted an exact NCAAF match:

- Alabama vs East Carolina
- Both Kalshi moneyline legs matched
- One discovery snapshot recorded
- One targeted near-start snapshot recorded
- 14 fresh bookmaker leg pairs used
- Zero stale pairs admitted

At verification time:

- Monthly locally tracked objects: 41 / 2,400
- Tracked external events: 1
- Graded outcomes: 0 (game not final)

## Files

- `src/main/strategies/sportsGameOdds.ts`
- `src/main/strategies/sportsAnchor.ts`
- `src/shared/ipc.ts`
- `src/renderer/src/AutoTraderPanel.tsx`
- `scripts/sgo-anchor-report.mjs`
- `package.json`
- `G:\Prompt Studio\desktop\backend\oracle_monitor.py`

Backups use the suffix `.bak_20260905_sgo_docs_upgrade`.
