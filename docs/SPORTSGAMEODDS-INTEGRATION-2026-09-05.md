# SportsGameOdds Integration - 2026-09-05

## Status

SportsGameOdds is installed as a supplemental, shadow-only sports probability anchor. It cannot place, resize, approve, or veto an order.

Authentication is stored in the Windows user environment variable `SPORTSGAMEODDS_API_KEY`; the credential is not embedded in source or runtime JSON.

## Free-tier budget

The Amateur account reports:

- 10 requests per minute
- 2,500 event objects per month
- Eight available leagues: NBA, MLB, MLS, NCAAB, NCAAF, NFL, NHL, and UEFA Champions League

Oracle Trader makes one combined request every six hours, asks for no more than 20 upcoming event objects, and persists its throttle across app restarts. Maximum normal consumption is 2,400 event objects in a 30-day month.

The request asks only for opposing full-game moneyline legs. Unsupported league aliases are excluded because one invalid league ID rejects an entire combined request.

## Probability construction

For each event:

1. Find opposing full-game home and away moneyline legs.
2. Use bookmakers present on both sides.
3. Convert American odds to implied probabilities.
4. Remove each bookmaker's overround independently.
5. Weight available sharper books more heavily.
6. Average the no-vig probabilities.
7. Fall back to SportsGameOdds fair odds only when both opposing fair legs exist.
8. Match both teams, event grouping, timing, and plain moneyline semantics to Kalshi.

Every observation records its provider/method so SportsGameOdds can be graded separately from The Odds API.

## First live poll

- Polls: 1
- Event objects: 20
- Exact Kalshi matches: 2
- Provider notice: free-plan filtering was present

Matched NCAAF example:

- East Carolina YES: Kalshi 5.0%, consensus 5.34%, gap -0.34 cents
- Alabama YES: Kalshi 97.0%, consensus 94.66%, gap +2.34 cents
- Contributing books: FanDuel, PointsBet, Unibet, ESPN BET, DraftKings, Bovada, BetMGM

These are research observations, not trade instructions.

## UI

The Sports Anchor panel now shows:

- SportsGameOdds poll count
- Event objects consumed out of 2,500
- Exact market matches
- Plan-filter notice
- Provider errors

## Files

Added:

- `src/main/strategies/sportsGameOdds.ts`
- `scripts/start-with-user-env.cmd`

Modified:

- `src/main/strategies/autoTrader.ts`
- `src/main/strategies/sportsAnchor.ts`
- `src/shared/ipc.ts`
- `src/renderer/src/AutoTraderPanel.tsx`

Backups use the suffix `.bak_20260905_sgo`.

## Verification

- Account authentication: passed
- Live usage endpoint: passed
- Filtered moneyline request: passed
- TypeScript: passed
- Production build: passed
- First app poll: passed
- Exact Kalshi matches persisted: passed
- Oracle Trader restarted: passed
