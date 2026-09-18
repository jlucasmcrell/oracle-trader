# Oracle Trader External Data Upgrade - 2026-09-05

## Implemented

- Multi-source news discovery now combines Google News RSS, GDELT DOC 2.0, and official Federal Reserve, BLS, and SEC feeds.
- Results are timestamped, deduplicated, sorted, cached for ten minutes, and source failures are isolated.
- Oracle Intelligence packets are enriched with the multi-source evidence before model review.
- Optional Bright Data Reddit discovery is implemented for sports, politics, entertainment, personnel, and breaking-event markets.
- Reddit is excluded from mechanical crypto, weather, and numeric macro pricing.
- Bright Data usage is capped at 4,000 requested records per UTC month, six records per query, with a six-hour per-query cache.
- The sports anchor now devigs each available bookmaker separately and combines books into a weighted consensus instead of trusting the first bookmaker returned.
- Sports observations are tagged `consensus-v1` so they can be separated from the older single-book sample.
- None of these additions can directly place or resize an order. They provide shadow evidence to the existing deterministic and AI review layers.

## Recommended sports-odds providers

### First choice: The Odds API

Use for the initial low-cost shadow test. It has a free 500-credit tier and paid historical access beginning at a modest monthly price. Oracle Trader already supports its API key in the Kalshi Auto Trader panel.

Signup: https://the-odds-api.com/
Docs: https://the-odds-api.com/liveapi/guides/v4

### Escalation trial: OpticOdds

Request a trial only if The Odds API consensus demonstrates out-of-sample value. OpticOdds advertises real-time updates, broad bookmaker coverage, player props, alternate markets, history, and injury/news data, but pricing requires sales contact.

Signup/demo: https://opticodds.com/sports-betting-api

### Structured sports data: SportsDataIO

Useful if the model needs lineups, injuries, schedules, results, and entity mapping in addition to prices. Request the free trial after odds-only matching is working.

Trial: https://sportsdata.io/free-trial

### Not recommended yet

Sportradar, Genius Sports, Unabated, and enterprise news/odds feeds are likely too expensive for the current research bankroll. Evaluate only after the inexpensive feed shows enough edge to pay for them.

## Keys needed from the operator

- The Odds API: paste a current key into Kalshi Auto Trader -> `odds key`. A key is already saved in the current configuration; verify quota/account status if the panel reports authentication or quota errors.
- Bright Data: create an API key and provide it for local installation as the Windows user environment variable `BRIGHTDATA_API_KEY`, then restart Oracle Trader. No key is currently installed.
- OpenRouter: already installed and working.
- Federal Reserve, BLS, SEC, GDELT, Google News: no key required.

## Bright Data controls

Dataset: Reddit Posts / discovery by keyword (`gd_lvz8ah06191smkebj4`).

The implementation deliberately treats Reddit as discovery evidence, not a probability oracle. The LLM sees post title/body, subreddit, age, comments, and upvotes. Deterministic pricing still controls order economics.

Review Reddit and Bright Data terms for the intended use. A third-party scraper does not automatically eliminate obligations imposed by the source platform.

## Next engineering priorities

1. Grade consensus-v1 sports observations by settlement and executable venue prices.
2. Extend exact sports matching to Polymarket US after enough mapped examples exist.
3. Add Polymarket US public/private WebSockets after validating the exact current message and authentication schemas.
4. Add contract-authoritative Kalshi weather index data only for contracts whose rules name that index.
5. Complete the Kalshi fixed-point migration before legacy integer fields are removed.
