/**
 * Regression tests for the 2026-09-06 review fixes (rounds 1 and 2). Pure
 * functions only; no network, no Electron. Run: npm run test:review
 */
import { bracketState, inBlackout, inBlackoutLocal, printFills, stationLocalHour, tempKindOfSeries } from '../../src/main/strategies/quoter'
import { bracketFairValue, forecastSigma, normalCdf, parseUsTempSlug, quoteAroundFair, remainingExtremes } from '../../src/main/strategies/weatherForecast'
import { defaultSportsShadow, gradeObservation, isSameGame, lineConsensus, observationConsistent, pacedBudget, parseLineMarket, pollPlan, ruleOutcome, sportFor, SPORTS_SERIES, SportsAnchor, subjectTeam, teamCodes, tickerDateMatches } from '../../src/main/strategies/sportsAnchor'
import { FLOW_DEFAULTS, flowStats, flowVerdict } from '../../src/main/strategies/flowMonitor'
import { kalshiBookTop, kalshiTakerFeeCents, LEADLAG_COINS, LEADLAG_PROVEN_DEFAULT, LeadLagEngine, leadLagPairs, polyBookTradeable, SlugTokenCache, slugEpoch, sweepSizeFor, windowRoom } from '../../src/main/strategies/leadLag'
import type { VenueAdapter } from '../../src/shared/venue'
import { shouldRepriceMaker, CROSS_VENUE_SEARCH_BUDGET, crossVenueBatch, phaseDurations, capacityKey, clusterDayOf, longHorizonCapFor, holdsToSettlement, meanReversionVerdict, morningForecastVerdict, ratchetBracketVerdict, ratchetEntryBlock, ratchetVerdict, RATCHET_GUARD_F } from '../../src/main/strategies/autoTrader'
import { mapKalshiSettlement, KALSHI_MAKER_FEE_COEF, universeWindows } from '../../src/main/venues/kalshi'
import { ACTIVITY_PAGE_PACE_MS, deriveUsCloseTime, isUsFutures, PolymarketUsAdapter } from '../../src/main/venues/polymarketUs'
import { isPinnedQuote, refreshedCloseTime, settlementProbeDue, statsBand, stuckSettlements } from '../../src/main/strategies/ledgerAudit'
import { GENERIC_STRATEGIES, leadLagRowCounts } from '../../src/main/ladder/ladder'
import { ConsensusFeed, CONSENSUS_RULE, consensusAgeHours, consensusRefusal, parseConsensusSignals } from '../../src/main/strategies/consensus'
import { bankObservations, eventDayStatus, localDate, parseEventDate, stationCode, stationTimeZone } from '../../src/main/strategies/weatherDay'
import { planFillIngest } from '../../src/main/store/fillReconciler'
import { fadeCategoryBlock, isWeatherSeries, underlyingOf, weatherSeatBlock } from '../../src/main/strategies/classify'
import { dailyBrakeBlock } from '../../src/main/strategies/miniAuto'
import { hunchModelPlans } from '../../src/main/strategies/hunch'
import { computeCandidate, MAX_ROWS_PER_DAY, midOf, momentumCandidateStats, momentumCandidatesActive, recordMomentumCandidates, resetMomentumCandidates, setMomentumCandidateDir } from '../../src/main/strategies/momentumCandidates'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { killState } from '../lib/kill-state.mjs'
import { isDnsFailure, makeResolverLookup, PUBLIC_RESOLVERS } from '../lib/dns-fallback.mjs'
import { needsSettleFetch, settledCacheEntry } from '../lib/cull-cache.mjs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { GEMINI, geminiKey } from '../../src/main/intelligence/gemini'
import type { MarketTrade, VenueFill } from '../../src/shared/types'

let pass = 0
let fail = 0
function eq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else {
    fail++
    console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
  }
}

// ---- quoter bracket gate (running extreme vs bracket) ----
eq('high above open', bracketState('high', 'greater', 90, undefined, 85, 60, 2, 1.5), 'open')
eq('high above near', bracketState('high', 'greater', 90, undefined, 88.6, 60, 2, 1.5), 'near')
eq('high above decided', bracketState('high', 'greater', 90, undefined, 92.5, 60, 2, 1.5), 'decided')
eq('high between open', bracketState('high', 'between', 86, 87, 80, 60, 2, 1.5), 'open')
eq('high between near', bracketState('high', 'between', 86, 87, 85, 60, 2, 1.5), 'near')
eq('high between decided', bracketState('high', 'between', 86, 87, 89, 60, 2, 1.5), 'decided')
eq('high below decided', bracketState('high', 'less', undefined, 95, 97.2, 60, 2, 1.5), 'decided')
eq('high below open', bracketState('high', 'less', undefined, 95, 80, 60, 2, 1.5), 'open')
eq('low below open', bracketState('low', 'less', undefined, 60, 90, 70, 2, 1.5), 'open')
eq('low below near', bracketState('low', 'less', undefined, 60, 90, 61, 2, 1.5), 'near')
eq('low below decided', bracketState('low', 'less', undefined, 60, 90, 57.9, 2, 1.5), 'decided')
eq('low between open', bracketState('low', 'between', 64, 65, 90, 75, 2, 1.5), 'open')
eq('low between near', bracketState('low', 'between', 64, 65, 90, 66, 2, 1.5), 'near')
eq('low between decided', bracketState('low', 'between', 64, 65, 90, 61.9, 2, 1.5), 'decided')
eq('custom open', bracketState('high', 'custom', undefined, undefined, 99, 0, 2, 1.5), 'open')

// ---- blackout windows ----
eq('high blackout 16Z', inBlackout('high', 16), true)
eq('high blackout 23Z', inBlackout('high', 23), true)
eq('high open 15Z', inBlackout('high', 15), false)
eq('high open 0Z', inBlackout('high', 0), false)
eq('low blackout 8Z', inBlackout('low', 8), true)
eq('low blackout 14Z', inBlackout('low', 14), true)
eq('low open 15Z', inBlackout('low', 15), false)
eq('local high blackout 13h', inBlackoutLocal('high', 13), true)
eq('local high open 9h', inBlackoutLocal('high', 9), false)
eq('local low blackout 5h', inBlackoutLocal('low', 5), true)
eq('local low open 12h', inBlackoutLocal('low', 12), false)
eq('station local hour: Miami at 16Z in September is 12h', stationLocalHour('KXHIGHTMIA-26SEP06-B90.5', Date.parse('2026-09-06T16:30:00Z')), 12)
eq('station local hour: unknown station is null', stationLocalHour('KXNOTASTATION-26SEP06', Date.now()), null)

// ---- forecast fair value ----
eq('normal cdf at 0', Math.abs(normalCdf(0) - 0.5) < 1e-6, true)
eq('normal cdf at 1.96', Math.abs(normalCdf(1.96) - 0.975) < 1e-3, true)
eq('fair: between bracket around mu', Math.abs((bracketFairValue('high', 'between', 70, 72, 71, 1.0) ?? 0) - 0.8664) < 0.002, true)
eq('fair: greater threshold', Math.abs((bracketFairValue('high', 'greater', 65, undefined, 68, 2) ?? 0) - 0.8944) < 0.002, true)
eq('fair: less threshold', Math.abs((bracketFairValue('high', 'less', undefined, 65, 68, 2) ?? 0) - 0.0401) < 0.002, true)
eq('fair: unknown strike type is null', bracketFairValue('high', 'weird', 65, 70, 68, 2), null)
eq('fair: gte K is X >= K', Math.abs((bracketFairValue('high', 'gte', 93, undefined, 92, 1) ?? 0) - (1 - normalCdf(0.5))) < 1e-6, true)
eq('fair: lt K is X <= K-1', Math.abs((bracketFairValue('high', 'lt', undefined, 82, 82, 1) ?? 0) - normalCdf(-0.5)) < 1e-6, true)
eq('us slug: bracket', parseUsTempSlug('tc-temp-miahigh-2026-08-30-gte87lt88f'), { station: 'MIA', kind: 'high', eventDate: '2026-08-30', strikeType: 'between', floor: 87, cap: 87 })
eq('us slug: less-than', parseUsTempSlug('tc-temp-nychigh-2026-08-30-lt82f'), { station: 'NYC', kind: 'high', eventDate: '2026-08-30', strikeType: 'lt', cap: 82 })
eq('us slug: at-least, Midway maps to Chicago', parseUsTempSlug('tc-temp-mdwlow-2026-09-01-gte70f'), { station: 'CHI', kind: 'low', eventDate: '2026-09-01', strikeType: 'gte', floor: 70 })
eq('us slug: not a temperature market', parseUsTempSlug('aec-wta-jespeg-sorcir-2026-09-06'), null)
eq('quote: fair above the market bids at ask-1 and never sells', quoteAroundFair(0.8, 0.4, 0.45, 2, 0, 3), { bid: 0.44, ask: null })
eq('quote: fair below the market sells at bid+1 and never bids', quoteAroundFair(0.1, 0.4, 0.45, 2, 0, 3), { bid: null, ask: 0.41 })
eq('quote: fair inside a wide spread quotes both sides', quoteAroundFair(0.5, 0.4, 0.6, 2, 0, 3), { bid: 0.48, ask: 0.52 })
eq('quote: inventory leans the center', quoteAroundFair(0.5, 0.4, 0.6, 2, 2, 3), { bid: 0.46, ask: 0.5 })
eq('quote: inventory cap stops the bid', quoteAroundFair(0.5, 0.4, 0.6, 2, 3, 3).bid, null)
eq('quote: margin is never given up on a tight spread', quoteAroundFair(0.5, 0.49, 0.51, 2, 0, 3), { bid: null, ask: null })
eq('quote: joins the best level when the margin lands on it', quoteAroundFair(0.5, 0.48, 0.52, 2, 0, 3), { bid: 0.48, ask: 0.52 })
eq('quote: a quote behind the best level is still dropped', quoteAroundFair(0.5, 0.49, 0.51, 3, 0, 3), { bid: null, ask: null })
eq('sigma: shrinks through the day, floors at station noise', forecastSigma(24) > forecastSigma(6) && forecastSigma(0) >= 0.9 && forecastSigma(48) <= 3.0, true)
const fc = { updatedAt: 0, periods: [13, 14, 15, 16, 17].map((h, i) => ({ start: Date.parse(`2026-09-06T${h}:00:00Z`), temp: [66, 70, 74, 72, 68][i] })) }
eq('remaining extremes: event day in station time, from an hour ago', remainingExtremes(fc, '2026-09-06', 'America/New_York', Date.parse('2026-09-06T14:30:00Z')), { max: 74, min: 68, hours: 4 })
eq('remaining extremes: other day is null', remainingExtremes(fc, '2026-09-07', 'America/New_York', Date.parse('2026-09-06T14:30:00Z')), null)

// ---- order-flow monitor ----
const TF = Date.now()
const tr = (count: number, side: 'yes' | 'no', ageMin: number, yes = 0.5) => ({ id: '', yesPrice: yes, noPrice: 1 - yes, count, createdTs: TF - ageMin * 60_000, takerOutcomeSide: side, takerBookSide: 'bid' as const, isBlockTrade: false })
const calm = flowStats([tr(2, 'yes', 3), tr(3, 'no', 5), tr(2, 'yes', 8), tr(1, 'no', 10), tr(2, 'yes', 12)], TF)
eq('flow: calm market is not toxic', flowVerdict(calm, FLOW_DEFAULTS).toxic, false)
eq('flow: median of the window', calm.medianCount, 2)
const whale = flowVerdict(flowStats([tr(2, 'yes', 3), tr(3, 'no', 5), tr(60, 'no', 1), tr(2, 'yes', 8), tr(1, 'no', 10)], TF), FLOW_DEFAULTS)
eq('flow: one print many times the median flags the taker side', { toxic: whale.toxic, side: whale.side }, { toxic: true, side: 'NO' })
const stream = flowVerdict(flowStats([tr(8, 'yes', 1), tr(9, 'yes', 2), tr(7, 'yes', 4), tr(8, 'yes', 6), tr(2, 'no', 9), tr(8, 'yes', 12)], TF), FLOW_DEFAULTS)
eq('flow: one-sided stream flags the dominant side', { toxic: stream.toxic, side: stream.side }, { toxic: true, side: 'YES' })
eq('flow: old prints are ignored', flowStats([tr(60, 'no', 40)], TF).n, 0)
eq('flow: a big print in a big market is not unusual', flowVerdict(flowStats([tr(30, 'yes', 1), tr(28, 'no', 3), tr(31, 'yes', 5), tr(29, 'no', 7), tr(30, 'yes', 9)], TF), FLOW_DEFAULTS).toxic, false)

// ---- odds-api credit plan ----
const T0 = Date.parse('2026-09-06T14:00:00Z')
const H = 3600_000
const mk = (series: string, n: number, closeInH: number) => Array.from({ length: n }, (_, i) => ({ id: `${series}-${i}`, seriesTicker: series, closeTime: T0 + closeInH * H }))
const universe = [...mk('KXNFLGAME', 6, 4), ...mk('KXKBOGAME', 2, 30), ...mk('KXLALIGAGAME', 3, 12), ...mk('KXMLSGAME', 1, 20), ...mk('KXNPBGAME', 5, 2)]
const oddsPlan = pollPlan(universe, {}, T0)
eq('plan: soonest games first, only leagues with a game inside a day', oddsPlan.map((p) => p.sport), ['baseball_npb', 'americanfootball_nfl', 'soccer_spain_la_liga', 'soccer_usa_mls'])
eq('plan: no game within a day means no credit', oddsPlan.some((p) => p.sport === 'baseball_kbo'), false)
eq('plan: Pinnacle region only for a major league near its game', oddsPlan.find((p) => p.sport === 'americanfootball_nfl')?.regions, 'us,eu')
eq('plan: minor league near its game stays on the us region', oddsPlan.find((p) => p.sport === 'baseball_npb')?.regions, 'us')
eq('plan: far game uses the us region', oddsPlan.find((p) => p.sport === 'soccer_spain_la_liga')?.regions, 'us')
eq('plan: hourly near a game', pollPlan(universe, { americanfootball_nfl: T0 - 50 * 60_000 }, T0).some((p) => p.sport === 'americanfootball_nfl'), false)
eq('plan: hourly near a game (due)', pollPlan(universe, { americanfootball_nfl: T0 - 61 * 60_000 }, T0).some((p) => p.sport === 'americanfootball_nfl'), true)
eq('plan: eight-hourly otherwise', pollPlan(universe, { soccer_spain_la_liga: T0 - 7 * H }, T0).some((p) => p.sport === 'soccer_spain_la_liga'), false)
eq('plan: cost is one credit per region', oddsPlan.map((p) => p.cost), [1, 2, 1, 1])
eq('sport for a spread ladder', sportFor('KXNFLSPREAD'), 'americanfootball_nfl')
eq('sport for a first-half total', sportFor('KXMLB1HTOTAL'), 'baseball_mlb')
eq('sport for an unknown series', sportFor('KXWEIRD'), undefined)
eq('ladder series list covers all suffixes', SPORTS_SERIES.filter((s) => s.startsWith('KXNFL')).sort(), ['KXNFL1HSPREAD', 'KXNFL1HTOTAL', 'KXNFLGAME', 'KXNFLSPREAD', 'KXNFLTOTAL'])
eq('plan: spread ladders count toward their league', pollPlan([{ id: 'KXNFLSPREAD-26SEP14DENKC-KC8', seriesTicker: 'KXNFLSPREAD', closeTime: T0 + 4 * H }], {}, T0).map((p) => p.sport), ['americanfootball_nfl'])
eq('plan: closing games first', oddsPlan.map((p) => p.sport)[0], 'baseball_npb')
eq('plan: paid tier adds spreads and totals at three markets per region', pollPlan(universe, {}, T0, 20000).map((p) => [p.markets, p.cost])[0], ['h2h,spreads,totals', 6])
eq('pace: one hour into the UTC day only a 24th of the allowance is spendable', Math.round(pacedBudget(645, Date.UTC(2026, 8, 7, 0, 30))), 27)
eq('pace: by 18:00 UTC most of it is', Math.round(pacedBudget(645, Date.UTC(2026, 8, 7, 18, 5))), 511)
eq('pace: a small plan is not paced', pacedBudget(16, Date.UTC(2026, 8, 7, 0, 30)), 16)
const paceNow = Date.UTC(2026, 8, 7, 1, 0)
const paceUniverse = [{ id: 'KXNFLGAME-26SEP07DENKC-KC', seriesTicker: 'KXNFLGAME', closeTime: paceNow + 4 * H }]
eq('pace: an early-UTC sweep stops at the paced share', pollPlan(paceUniverse, { '__spentDay:2026-09-07': 50 }, paceNow, 20000).length, 0)
eq('pace: the same sweep at midday proceeds', pollPlan(paceUniverse, { '__spentDay:2026-09-07': 50 }, Date.UTC(2026, 8, 7, 12, 0), 20000).length, 1)
eq('line: spread title', parseLineMarket('Kansas City wins by over 7.5 points?'), { kind: 'spread', point: 7.5 })
eq('line: total title', parseLineMarket('Will there be over 63.5 points scored?'), { kind: 'total', point: 63.5 })
eq('line: first half skipped', parseLineMarket('Will there be over 7.5 1H points scored?'), null)
eq('line: moneyline is not a line market', parseLineMarket('Will the Chiefs beat the Broncos?'), null)
eq('same game by ticker codes', isSameGame('KXNFLTOTAL-26SEP14DENKC-64', 'Kansas City Chiefs', 'Denver Broncos'), true)
eq('different game by ticker codes', isSameGame('KXNFLTOTAL-26SEP14DENKC-64', 'Miami Dolphins', 'Buffalo Bills'), false)
eq('same game: college ladder with a four-letter home code', isSameGame('KXNCAAFTOTAL-26SEP06WSUWASH-29', 'Washington Huskies', 'Washington State Cougars'), true)
eq('not the same game: NFL WAS@PHI vs Washington/Washington State', isSameGame('KXNFLTOTAL-26SEP13WASPHI-69', 'Washington Huskies', 'Washington State Cougars'), false)
eq('same game: MLB segment carries a start time', isSameGame('KXMLBTOTAL-26SEP061820MINCWS-8', 'Chicago White Sox', 'Minnesota Twins'), true)
eq('same game: exchange code longer than the city guess', isSameGame('KXMLBSPREAD-26SEP071335LAABOS-LAA2', 'Boston Red Sox', 'Los Angeles Angels'), true)
eq('same game: ticker date agrees with the start', isSameGame('KXNFLTOTAL-26SEP14DENKC-64', 'Kansas City Chiefs', 'Denver Broncos', Date.UTC(2026, 8, 14, 20)), true)
eq('not the same game: a week apart', isSameGame('KXNFLTOTAL-26SEP14DENKC-64', 'Kansas City Chiefs', 'Denver Broncos', Date.UTC(2026, 8, 21, 20)), false)
eq('consistency: NFL ladder paired with a college game', observationConsistent({ kalshiId: 'KXNFLTOTAL-26SEP13WASPHI-69', sportKey: 'americanfootball_ncaaf', homeTeam: 'Washington Huskies', awayTeam: 'Washington State Cougars', market: 'total' }), false)
eq('consistency: league and game agree', observationConsistent({ kalshiId: 'KXNCAAFTOTAL-26SEP06WSUWASH-29', sportKey: 'americanfootball_ncaaf', homeTeam: 'Washington Huskies', awayTeam: 'Washington State Cougars', market: 'total', eventStartsAt: Date.UTC(2026, 8, 6, 1) }), true)
eq('consistency: moneyline a week off its ticker date', observationConsistent({ kalshiId: 'KXNFLGAME-26SEP13WASPHI-WAS', sportKey: 'americanfootball_nfl', market: 'h2h', eventStartsAt: Date.UTC(2026, 8, 20, 17) }), false)
eq('codes: nickname initial disambiguates a shared city', [teamCodes('Los Angeles Angels').includes('LAA'), teamCodes('Los Angeles Dodgers').includes('LAD'), teamCodes('Chicago White Sox').includes('CWS'), teamCodes('Washington Huskies').includes('WASH')], [true, true, true, true])
eq('subject: spread ticker names the Angels', subjectTeam('KXMLBSPREAD-26SEP071335LAABOS-LAA2', 'Boston Red Sox', 'Los Angeles Angels'), 'Los Angeles Angels')
eq('subject: moneyline ticker names the White Sox', subjectTeam('KXMLBGAME-26SEP061820MINCWS-CWS', 'Chicago White Sox', 'Minnesota Twins'), 'Chicago White Sox')
eq('subject: Freeway Series resolves by exact code', subjectTeam('KXMLBGAME-26SEP07LAALAD-LAD', 'Los Angeles Angels', 'Los Angeles Dodgers'), 'Los Angeles Dodgers')
eq('subject: a total has no subject team', subjectTeam('KXMLBTOTAL-26SEP061820MINCWS-8', 'Chicago White Sox', 'Minnesota Twins'), undefined)
eq('not the same game: the Angels run line vs an MLS match', isSameGame('KXMLBSPREAD-26SEP071335LAABOS-LAA2', 'New York Red Bulls', 'Los Angeles FC'), false)
eq('consistency: MLB spread paired with a soccer event', observationConsistent({ kalshiId: 'KXMLBSPREAD-26SEP071335LAABOS-LAA2', sportKey: 'soccer_usa_mls', homeTeam: 'Los Angeles FC', awayTeam: 'New York Red Bulls', market: 'spread' }), false)
eq('ticker date: evening game in Chicago', tickerDateMatches('2026-09-06', Date.UTC(2026, 8, 6, 23, 10)), true)
eq('ticker date: the next day is a different game', tickerDateMatches('2026-09-07', Date.UTC(2026, 8, 6, 23, 10)), false)
eq('ticker date: late West-coast start stamped in ET with a time', tickerDateMatches('2026-09-06', Date.UTC(2026, 8, 7, 2, 10), '2210'), true)
eq('ticker date: a time stamp rejects the previous night of the series', tickerDateMatches('2026-09-07', Date.UTC(2026, 8, 7, 2, 10), '1310'), false)
eq('ticker date: college stamp is the UTC date of a late-evening kickoff', tickerDateMatches('2026-09-06', Date.UTC(2026, 8, 6, 1, 30)), true)
eq('same game: previous night of the same series is rejected', isSameGame('KXMLBSPREAD-26SEP071335LAABOS-LAA2', 'Boston Red Sox', 'Los Angeles Angels', Date.UTC(2026, 8, 6, 23, 10)), false)
eq('same game: today game accepted', isSameGame('KXMLBSPREAD-26SEP071335LAABOS-LAA2', 'Boston Red Sox', 'Los Angeles Angels', Date.UTC(2026, 8, 7, 17, 35)), true)
const evLines = { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', bookmakers: [
  { key: 'pinnacle', markets: [
    { key: 'spreads', outcomes: [{ name: 'Kansas City Chiefs', price: 1.95, point: -7.5 }, { name: 'Denver Broncos', price: 1.95, point: 7.5 }] },
    { key: 'totals', outcomes: [{ name: 'Over', price: 1.87, point: 63.5 }, { name: 'Under', price: 2.03, point: 63.5 }] } ] },
  { key: 'draftkings', markets: [
    { key: 'spreads', outcomes: [{ name: 'Kansas City Chiefs', price: 1.83, point: -7.5 }, { name: 'Denver Broncos', price: 2.0, point: 7.5 }] } ] } ] }
const lc = lineConsensus(evLines)
eq('line consensus: favorite spread priced, Pinnacle weighted', Math.abs((lc.spread.get('Kansas City Chiefs|7.5') ?? 0) - (3 * 0.5 + 1 * (1 / 1.83 / (1 / 1.83 + 1 / 2.0))) / 4) < 1e-9, true)
eq('line consensus: underdog side not a Kalshi strike', lc.spread.has('Denver Broncos|7.5'), false)
eq('line consensus: total over priced', Math.abs((lc.total.get('over|63.5') ?? 0) - (1 / 1.87) / (1 / 1.87 + 1 / 2.03)) < 1e-9, true)
eq('line consensus: books counted', lc.books, 2)
const evAlt = { home_team: 'Kansas City Chiefs', away_team: 'Denver Broncos', bookmakers: [{ key: 'pinnacle', markets: [
  { key: 'alternate_spreads', outcomes: [
    { name: 'Kansas City Chiefs', price: 1.5, point: -3.5 }, { name: 'Denver Broncos', price: 2.6, point: 3.5 },
    { name: 'Kansas City Chiefs', price: 2.4, point: -10.5 }, { name: 'Denver Broncos', price: 1.58, point: 10.5 } ] },
  { key: 'alternate_totals', outcomes: [
    { name: 'Over', price: 1.4, point: 55.5 }, { name: 'Under', price: 2.9, point: 55.5 },
    { name: 'Over', price: 2.5, point: 70.5 }, { name: 'Under', price: 1.55, point: 70.5 } ] } ] }] }
const la = lineConsensus(evAlt)
eq('alternate lines: every favorite strike priced', [...la.spread.keys()].sort(), ['Kansas City Chiefs|10.5', 'Kansas City Chiefs|3.5'])
eq('alternate lines: every total strike priced', [...la.total.keys()].sort(), ['over|55.5', 'over|70.5'])
eq('alternate lines: pairs devigged by point', Math.abs((la.spread.get('Kansas City Chiefs|10.5') ?? 0) - (1 / 2.4) / (1 / 2.4 + 1 / 1.58)) < 1e-9, true)
const obsBase = { kalshiId: 'x', question: '', kalshiMid: 0.4, fairProb: 0.5, gapCents: -10, bookmaker: '', sportKey: 's', ts: 0, homeTeam: 'H', awayTeam: 'A' }
eq('grade: moneyline home win', gradeObservation({ ...obsBase, market: 'h2h', team: 'H' }, 24, 17), { yesWon: true, ruleSide: 'YES', rulePnl: 0.6 })
eq('grade: spread not covered', gradeObservation({ ...obsBase, market: 'spread', team: 'H', point: 7.5 }, 24, 17), { yesWon: false, ruleSide: 'YES', rulePnl: -0.4 })
eq('grade: total over', gradeObservation({ ...obsBase, market: 'total', point: 40.5, gapCents: 5, kalshiMid: 0.6 }, 24, 17), { yesWon: true, ruleSide: 'NO', rulePnl: -0.4 })
eq('grade: small gap records the result without a trade', gradeObservation({ ...obsBase, market: 'h2h', team: 'A', gapCents: 1 }, 24, 17), { yesWon: false, ruleSide: null, rulePnl: 0 })
eq('grade: missing score is null', gradeObservation({ ...obsBase, market: 'h2h', team: 'H' }, Number.NaN, 17), null)

// --- backlog 43: NPB/KBO grade from Kalshi settlement, not the scores feed ---
// Measured 2026-09-10: `/scores` returned 0 completed games for baseball_npb and
// baseball_kbo on all five polls in 24 h while every other league graded fine.
eq('rule: the settlement path books the same P&L as the score path',
  ruleOutcome({ gapCents: -10, kalshiMid: 0.4 }, true), { yesWon: true, ruleSide: 'YES', rulePnl: 0.6 })
eq('rule: a sub-3c gap records the result and trades nothing',
  ruleOutcome({ gapCents: 1, kalshiMid: 0.4 }, false), { yesWon: false, ruleSide: null, rulePnl: 0 })
eq('rule: rich Kalshi sells the YES leg',
  ruleOutcome({ gapCents: 5, kalshiMid: 0.6 }, true), { yesWon: true, ruleSide: 'NO', rulePnl: -0.4 })

// The Kalshi-settlement path is async; this test file compiles to CJS, so it runs
// from a promise the summary at the bottom of the file waits on.
const anchorSettlementTests = async (): Promise<void> => {
  // Three observations lifted verbatim from the live pending queue on
  // 2026-09-10: two NPB sides of one game (which the scores feed has never
  // graded) and one MLS row (which it grades fine and must be left alone).
  const K_NOW = Date.parse('2026-09-10T12:00:00Z')
  const npbYes = { kalshiId: 'KXNPBGAME-26SEP080500HOKFUK-FUK', question: 'Fukuoka Hawks wins', kalshiMid: 0.9199999999999999, fairProb: 0.8855, gapCents: 3.45, bookmaker: 'consensus-v1:pinnacle', sportKey: 'baseball_npb', ts: 1788865258646, eventId: '5e7f74c5eeb66acceec4502b0cfe6267', homeTeam: 'Fukuoka SoftBank Hawks', awayTeam: 'Hokkaido Nippon-Ham Fighters', market: 'h2h' as const, team: 'Fukuoka SoftBank Hawks', eventStartsAt: 1788858025000 }
  const npbNo = { ...npbYes, kalshiId: 'KXNPBGAME-26SEP080500HOKFUK-HOK', question: 'Hokkaido Nippon-Ham Fighters wins', kalshiMid: 0.075, fairProb: 0.1145, gapCents: -3.95, team: 'Hokkaido Nippon-Ham Fighters' }
  const mlsObs = { kalshiId: 'KXMLSGAME-26SEP12SKCLAFC-SKC', question: 'Kansas City wins', kalshiMid: 0.185, fairProb: 0.1914, gapCents: -0.64, bookmaker: 'consensus-v1:pmu_fr', sportKey: 'soccer_usa_mls', ts: 1789012809511, eventId: '4076bf96178846a57e9120bcc81e94c7', homeTeam: 'Sporting Kansas City', awayTeam: 'Los Angeles FC', market: 'h2h' as const, team: 'Sporting Kansas City', eventStartsAt: 1789259400000 }
  eq('backlog 43: the fixtures are rows the matcher accepts',
    [npbYes, npbNo, mlsObs].every(observationConsistent), true)

  // (a) the scores poll no longer spends credits on the leagues it cannot grade
  const skipAnchor = new SportsAnchor()
  ;(skipAnchor as unknown as { http: { get: () => Promise<unknown> } }).http = {
    get: () => { throw new Error('the scores feed must not be polled for NPB/KBO') }
  }
  const skipStats = { ...defaultSportsShadow(), pending: [{ ...npbYes }] }
  const skipPollAt: Record<string, number> = {}
  await skipAnchor.grade('key', skipStats, skipPollAt, 500, K_NOW, () => {})
  eq('backlog 43: NPB is not polled on the scores feed', skipPollAt['__scores:baseball_npb'], undefined)
  eq('backlog 43: and no Odds API credit is spent', skipPollAt['__spentDay:2026-09-10'], undefined)

  // (b) it grades from Kalshi's settled market instead, by exact ticker
  const kAnchor = new SportsAnchor()
  const asked: string[] = []
  ;(kAnchor as unknown as { kalshi: { get: (u: string) => Promise<unknown> } }).kalshi = {
    get: async (u: string) => {
      asked.push(u)
      return { markets: [
        { ticker: 'KXNPBGAME-26SEP080500HOKFUK-FUK', result: 'yes' },
        { ticker: 'KXNPBGAME-26SEP080500HOKFUK-HOK', result: 'no' },
        { ticker: 'KXNPBGAME-26SEP080500HOKFUK-VOID', result: '' }
      ] }
    }
  }
  const kStats = { ...defaultSportsShadow(), pending: [{ ...npbYes }, { ...npbNo }, { ...mlsObs }] }
  const kPollAt: Record<string, number> = {}
  const written: Record<string, unknown>[] = []
  await kAnchor.gradeFromKalshi(kStats, kPollAt, K_NOW, (r) => written.push(r))
  eq('backlog 43: exactly one query, by series, for the blind league only',
    asked, ['/markets?series_ticker=KXNPBGAME&status=settled&limit=200'])
  eq('backlog 43: both NPB sides graded', written.map((r) => r.kalshiId),
    ['KXNPBGAME-26SEP080500HOKFUK-FUK', 'KXNPBGAME-26SEP080500HOKFUK-HOK'])
  eq('backlog 43: graded from settlement, not scores', written.map((r) => r.gradedFrom),
    ['kalshi-settlement', 'kalshi-settlement'])
  // Kalshi rich by 3.45c -> sell YES at 0.92; YES won, so the rule loses 8c.
  eq('backlog 43: the rich side sells and loses when YES wins',
    [written[0].yesWon, written[0].ruleSide, written[0].rulePnl], [true, 'NO', -0.08])
  // Kalshi cheap by 3.95c -> buy YES at 0.075; YES lost, so the rule loses 7.5c.
  eq('backlog 43: the cheap side buys and loses when YES loses',
    [written[1].yesWon, written[1].ruleSide, written[1].rulePnl], [false, 'YES', -0.075])
  eq('backlog 43: the running totals move', [kStats.gradedN, kStats.ruleN, kStats.ruleNet], [2, 2, -0.155])
  eq('backlog 43: Brier is summed against fairProb',
    Math.abs((kStats.gradedBrier ?? 0) - ((0.8855 - 1) ** 2 + 0.1145 ** 2)) < 1e-9, true)
  eq('backlog 43: the MLS observation is untouched',
    kStats.pending?.map((o) => o.kalshiId), ['KXMLSGAME-26SEP12SKCLAFC-SKC'])

  // (c) the six-hour throttle holds, and a market with no result stays pending
  let calls = 0
  ;(kAnchor as unknown as { kalshi: { get: (u: string) => Promise<unknown> } }).kalshi = {
    get: async () => { calls++; return { markets: [] } }
  }
  const kStats2 = { ...defaultSportsShadow(), pending: [{ ...npbYes }] }
  await kAnchor.gradeFromKalshi(kStats2, kPollAt, K_NOW + 60_000, () => {})
  eq('backlog 43: throttled inside six hours', calls, 0)
  await kAnchor.gradeFromKalshi(kStats2, kPollAt, K_NOW + 7 * 3_600_000, () => {})
  eq('backlog 43: polled again after six hours', calls, 1)
  eq('backlog 43: an unsettled market stays pending', kStats2.pending?.length, 1)

}
eq('plan: daily budget stops spending', pollPlan(universe, { '__spentDay:2026-09-06': 14 }, T0).map((p) => p.sport), ['baseball_npb'])
const big = pollPlan(universe, {}, T0, 20000)
eq('plan: a bigger allowance polls every league inside two days with Pinnacle', { n: big.length, eu: big.every((p) => p.regions === 'us,eu') }, { n: 5, eu: true })
eq('plan: bigger allowance shortens the cadence to 30 minutes', pollPlan(universe, { soccer_spain_la_liga: T0 - 31 * 60_000 }, T0, 20000).some((p) => p.sport === 'soccer_spain_la_liga'), true)
eq('plan: bigger allowance still respects the daily budget', pollPlan(universe, { '__spentDay:2026-09-06': 644 }, T0, 20000).length, 0)
eq('null never', inBlackout(null, 20), false)
eq('series kind high', tempKindOfSeries('KXHIGHTNYC'), 'high')
eq('series kind low', tempKindOfSeries('KXLOWTSFO'), 'low')
eq('series kind other', tempKindOfSeries('KXBTCD'), null)

// ---- Kalshi taker fee cents (delegated to the canonical 4dp model) ----
eq('fee at 50c', kalshiTakerFeeCents(0.5), 1.7500000000000002)
eq('fee at 95c', kalshiTakerFeeCents(0.95), 0.33999999999999997)
eq('fee at 99c', kalshiTakerFeeCents(0.99), 0.06999999999999999)
eq('fee at 10c', kalshiTakerFeeCents(0.1), 0.63)
eq('maker coef', KALSHI_MAKER_FEE_COEF, 0.0175)

// ---- settlement ratchet verdicts incl. between brackets ----
eq('guard const', RATCHET_GUARD_F, 2)
eq('single-threshold still works', ratchetVerdict('high', 'above', 90, 92.5, 60, 2), 'YES')
eq('between high NO when max clears cap', ratchetBracketVerdict('high', 'between', 86, 87, 89.5, 60, 2), 'NO')
eq('between high undecided below cap', ratchetBracketVerdict('high', 'between', 86, 87, 88.5, 60, 2), null)
eq('between low NO when min clears floor', ratchetBracketVerdict('low', 'between', 64, 65, 90, 61.5, 2), 'NO')
eq('between low undecided', ratchetBracketVerdict('low', 'between', 64, 65, 90, 63, 2), null)
eq('above high YES', ratchetBracketVerdict('high', 'greater', 90, undefined, 92.1, 60, 2), 'YES')
eq('above high never NO', ratchetBracketVerdict('high', 'greater', 90, undefined, 50, 40, 2), null)
eq('below high NO when exceeded', ratchetBracketVerdict('high', 'less', undefined, 95, 97.5, 60, 2), 'NO')
eq('below low YES when min clears', ratchetBracketVerdict('low', 'less', undefined, 60, 90, 57.5, 2), 'YES')
eq('above low NO when min clears floor', ratchetBracketVerdict('low', 'greater', 70, undefined, 90, 67.5, 2), 'NO')
eq('custom null', ratchetBracketVerdict('high', 'custom', 1, 2, 99, 0, 2), null)

// ---- settlement mapping (paired proceeds) — reproduces the live audit arithmetic ----
const s = mapKalshiSettlement({
  ticker: 'KXHIGHTNOLA-26SEP02-B92.5',
  market_result: 'no',
  yes_count_fp: '14.00',
  no_count_fp: '13.00',
  yes_total_cost_dollars: '8.000000',
  no_total_cost_dollars: '7.770000',
  revenue: 0,
  fee_cost: '0.000000',
  settled_time: '2026-09-03T12:11:05Z'
})
eq('paired proceeds', s.pairedRevenue, 13)
eq('realized', Math.round(s.realizedPnl * 100) / 100, -2.77)

// ---- weather observation-day binding (round 2) ----
eq('event date parse', parseEventDate('KXHIGHTMIA-26SEP06-B90.5'), '2026-09-06')
eq('event date parse event ticker', parseEventDate('KXLOWTSFO-26DEC31'), '2026-12-31')
eq('event date parse none', parseEventDate('KXBTCD-26SEP0309-T78599.99'), null)
eq('station code', stationCode('KXHIGHTMIA-26SEP06'), 'MIA')
eq('station code no T', stationCode('KXHIGHPHIL-26SEP06'), 'PHIL')
eq('station tz miami', stationTimeZone('KXHIGHTMIA-26SEP06'), 'America/New_York')
eq('station tz dfw', stationTimeZone('KXLOWTDAL-26SEP06'), 'America/Chicago')
eq('station tz unknown', stationTimeZone('KXHIGHTZZZ-26SEP06'), null)
// 2026-09-06T03:30Z is 2026-09-05 23:30 in New York but 2026-09-06 in UTC.
const t0330z = Date.parse('2026-09-06T03:30:00Z')
eq('local date NY before midnight', localDate(t0330z, 'America/New_York'), '2026-09-05')
eq('local date NY after midnight', localDate(Date.parse('2026-09-06T04:30:00Z'), 'America/New_York'), '2026-09-06')
eq('day status future', eventDayStatus('2026-09-07', 'America/New_York', Date.parse('2026-09-06T20:00:00Z')), 'future')
eq('day status active', eventDayStatus('2026-09-06', 'America/New_York', Date.parse('2026-09-06T20:00:00Z')), 'active')
eq('day status past', eventDayStatus('2026-09-05', 'America/New_York', Date.parse('2026-09-06T20:00:00Z')), 'past')
// A series spanning local midnight: yesterday's 92 must not leak into today's bank.
const series = [
  { timestamp: Date.parse('2026-09-06T01:00:00Z'), price: 92 }, // 21:00 NY on 09-05
  { timestamp: Date.parse('2026-09-06T03:59:00Z'), price: 80 }, // 23:59 NY on 09-05
  { timestamp: Date.parse('2026-09-06T04:01:00Z'), price: 71 }, // 00:01 NY on 09-06
  { timestamp: Date.parse('2026-09-06T08:00:00Z'), price: 68 } // 04:00 NY on 09-06
]
eq('bank today only', bankObservations(series, '2026-09-06', 'America/New_York'), { hi: 71, lo: 68, n: 2 })
eq('bank yesterday only', bankObservations(series, '2026-09-05', 'America/New_York'), { hi: 92, lo: 80, n: 2 })
eq('bank tomorrow none', bankObservations(series, '2026-09-07', 'America/New_York'), null)

// ---- shadow proxy fills from trade prints ----
const trades: MarketTrade[] = [
  { id: 'a', yesPrice: 0.46, noPrice: 0.54, count: 1, createdTs: 1000, takerOutcomeSide: 'no', takerBookSide: 'ask', isBlockTrade: false }, // before placement
  { id: 'b', yesPrice: 0.5, noPrice: 0.5, count: 1, createdTs: 3000, takerOutcomeSide: 'yes', takerBookSide: 'bid', isBlockTrade: false },
  { id: 'c', yesPrice: 0.44, noPrice: 0.56, count: 2, createdTs: 4000, takerOutcomeSide: 'no', takerBookSide: 'ask', isBlockTrade: false },
  { id: 'd', yesPrice: 0.43, noPrice: 0.57, count: 2, createdTs: 5000, takerOutcomeSide: 'no', takerBookSide: 'ask', isBlockTrade: false }
]
eq('yes bid filled by first print at/below', printFills('YES', 0.45, 2000, trades)?.id, 'c')
eq('yes bid ignores pre-placement print', printFills('YES', 0.46, 2000, trades)?.id, 'c')
eq('no ask filled by print at/above', printFills('NO', 0.5, 2000, trades)?.id, 'b')
eq('no ask unfilled', printFills('NO', 0.6, 2000, trades), null)

// ---- venue-fill reconciler planning ----
const fills: VenueFill[] = [
  { id: 'f1', orderId: 'ot-1', marketId: 'M', outcome: 'YES', side: 'buy', shares: 1, price: 0.4, fee: 0, isTaker: false, timestamp: 2 },
  { id: 'f2', orderId: 'ot-2', marketId: 'M', outcome: 'NO', side: 'buy', shares: 2, price: 0.3, fee: 0.01, isTaker: true, timestamp: 1 },
  { id: 'f3', orderId: 'ot-3', marketId: 'N', outcome: 'YES', side: 'sell', shares: 1, price: 0.7, fee: 0, isTaker: false, timestamp: 3 },
  { id: 'f1', orderId: 'ot-1', marketId: 'M', outcome: 'YES', side: 'buy', shares: 1, price: 0.4, fee: 0, isTaker: false, timestamp: 2 } // duplicate row
]
const plan = planFillIngest(fills, new Set(['f3']), new Map([['ot-2', 1]]), 'kalshi')
eq('reconciler preserves every unseen execution including placements', plan.rows.map((r) => r.id), ['fill:f2', 'fill:f1'])
eq('reconciler never drops an execution by timestamp', plan.skippedPlacement, 0)
eq('reconciler new ids exclude seen', plan.newIds, ['f2', 'f1'])
eq('reconciler row shape', { ref: plan.rows[1].ref, amount: plan.rows[1].amount, side: plan.rows[1].side }, { ref: 'venue-fill', amount: 0.4, side: 'buy' })
const later: VenueFill[] = [
  { id: 'f4', orderId: 'ot-2', marketId: 'M', outcome: 'NO', side: 'buy', shares: 8, price: 0.3, fee: 0.04, isTaker: false, timestamp: 1 + 60_000 }
]
eq('reconciler publishes a later fill of a placed order', planFillIngest(later, new Set(), new Map([['ot-2', 1]]), 'kalshi').rows.map((r) => r.id), ['fill:f4'])
const hunchPlans = hunchModelPlans({ llmBaseUrl: 'https://api.deepseek.com/v1', llmApiKey: 'k', llmModel: 'deepseek-v4-pro' }, 'router')
const HGEM = geminiKey() ? GEMINI.models : []
eq('hunch plans: router fast models, then Gemini', hunchPlans.map((p) => p.model), ['google/gemini-3.8-flash', 'deepseek/deepseek-v4-pro', 'z-ai/glm-5.3-flash', ...HGEM])
// Presence, not value; and only when the environment carries a key (a clean checkout must pass, 2026-09-19).
const hunchGemini = hunchPlans.find((p) => GEMINI.models.includes(p.model))
if (hunchGemini) eq('hunch plans: Gemini carries a key and is not local', [hunchGemini.base, hunchGemini.key.length > 0, hunchGemini.local], [GEMINI.base, true, false])

// Calibration day buckets are the day the P&L was realized. A sports market's
// cached close_time sits days ahead until play ends (MILCIN traded 09-06 with
// close 09-09), and a future bucket is both a nonsense date and a single
// cluster with a zero-width band.
const nowMs = Date.parse('2026-09-06T19:40:00Z')
eq('cluster day: a future close time clamps to today', clusterDayOf(Date.parse('2026-09-09T16:10:00Z'), nowMs), '2026-09-06')
eq('cluster day: a real past close keeps its own day', clusterDayOf(Date.parse('2026-09-06T19:29:54Z'), nowMs), '2026-09-06')
eq('cluster day: an older close keeps its own day', clusterDayOf(Date.parse('2026-09-04T10:00:00Z'), nowMs), '2026-09-04')
eq('cluster day: a missing close time is today, never "unknown"', clusterDayOf(undefined, nowMs), '2026-09-06')

// Mean reversion on extremes (pre-registered 2026-09-07): fade a traded move
// of 8c or more in 10 minutes on a market with 6+ hours left.
const RULE = { minMoveCents: 8, minHoursToClose: 6 }
const rise = { prices: [0.40, 0.44, 0.50], tradedCandles: 4, hoursToClose: 20 }
eq('reversion: fades a big rise by buying NO', meanReversionVerdict(rise, RULE)?.direction, 'NO')
eq('reversion: reports the move in cents', Math.round((meanReversionVerdict(rise, RULE)?.moveCents ?? 0) * 100) / 100, 10)
eq('reversion: fades a big fall by buying YES', meanReversionVerdict({ ...rise, prices: [0.50, 0.44, 0.40] }, RULE)?.direction, 'YES')
eq('reversion: a small move does not fire', meanReversionVerdict({ ...rise, prices: [0.40, 0.42, 0.44] }, RULE), null)
eq('reversion: an untraded move is a quote flicker', meanReversionVerdict({ ...rise, tradedCandles: 2 }, RULE), null)
eq('reversion: no room to revert near close', meanReversionVerdict({ ...rise, hoursToClose: 5.9 }, RULE), null)
eq('reversion: exactly the horizon still fires', meanReversionVerdict({ ...rise, hoursToClose: 6 }, RULE)?.direction, 'NO')
eq('reversion: never fades into the top tail', meanReversionVerdict({ ...rise, prices: [0.85, 0.92, 0.96] }, RULE), null)
eq('reversion: never fades into the bottom tail', meanReversionVerdict({ ...rise, prices: [0.15, 0.08, 0.04] }, RULE), null)
eq('reversion: one price is not a move', meanReversionVerdict({ ...rise, prices: [0.4] }, RULE), null)
// v2 (2026-09-08): the reverting side is never bought as a longshot.
eq('reversion v2: a fall to 20c is not bought', meanReversionVerdict({ ...rise, prices: [0.32, 0.25, 0.20] }, RULE), null)
eq('reversion v2: a fall to 40c is bought', meanReversionVerdict({ ...rise, prices: [0.52, 0.45, 0.40] }, RULE)?.direction, 'YES')
eq('reversion v2: a rise to 30c is faded with NO at 70c', meanReversionVerdict({ ...rise, prices: [0.15, 0.22, 0.30] }, RULE)?.direction, 'NO')
eq('reversion v2: a rise to 80c would buy NO at 20c: no', meanReversionVerdict({ ...rise, prices: [0.65, 0.72, 0.80] }, RULE), null)
eq('reversion v2: the floor is a rule parameter', meanReversionVerdict({ ...rise, prices: [0.52, 0.45, 0.40] }, { ...RULE, minEntryPrice: 0.5 }), null)

// ---- Polymarket US close-time derivation: futures vs games (2026-09-08) ----
{
  const NOW = Date.parse('2026-09-08T00:00:00Z')
  const H = 3600_000
  const D = 24 * H
  eq('polyus: futures never close at the next fixture', deriveUsCloseTime({ endMs: NOW + 285 * D, gameMs: NOW + 13 * H, resolved: false, futures: true }, NOW), NOW + 285 * D)
  eq('polyus: futures with a past fixture are not dead', deriveUsCloseTime({ endMs: NOW + 285 * D, gameMs: NOW - 3 * D, resolved: false, futures: true }, NOW), NOW + 285 * D)
  eq('polyus: a game closes at kickoff', deriveUsCloseTime({ endMs: NOW + 14 * D, gameMs: NOW + 13 * H, resolved: false, futures: false }, NOW), NOW + 13 * H)
  eq('polyus: a game that started 7h ago is dead', deriveUsCloseTime({ endMs: NOW + 14 * D, gameMs: NOW - 7 * H, resolved: false, futures: false }, NOW), NOW - 7 * H)
  eq('polyus: a resolved old game is not re-dated', deriveUsCloseTime({ endMs: NOW + 14 * D, gameMs: NOW - 7 * H, resolved: true, futures: false }, NOW), NOW + 14 * D)
  // The six-hour hole (round 70): between kickoff and the stale-game branch this returned endDate, a
  // placeholder at kickoff + 14 days, and refreshedCloseTime then ratcheted live positions a fortnight out.
  eq('polyus: a game 2h after kickoff still closes at kickoff', deriveUsCloseTime({ endMs: NOW + 14 * D, gameMs: NOW - 2 * H, resolved: false, futures: false }, NOW), NOW - 2 * H)
  eq('polyus: and 5h59m after kickoff, just inside the old hole', deriveUsCloseTime({ endMs: NOW + 14 * D, gameMs: NOW - 5.98 * H, resolved: false, futures: false }, NOW), NOW - 5.98 * H)
  eq('polyus: right at kickoff', deriveUsCloseTime({ endMs: NOW + 14 * D, gameMs: NOW, resolved: false, futures: false }, NOW), NOW)
  // The real rows that were holding Polymarket at 48/48 on 2026-09-12.
  eq('polyus: asc-cfb-missr-kan (kickoff 00:00Z, endDate +14d)', deriveUsCloseTime({ endMs: Date.parse('2026-09-26T00:00:00Z'), gameMs: Date.parse('2026-09-12T00:00:00Z'), resolved: false, futures: false }, Date.parse('2026-09-12T00:50:00Z')), Date.parse('2026-09-12T00:00:00Z'))
  eq('polyus: asc-mlb-cin-mil (kickoff 23:45Z, endDate +14d)', deriveUsCloseTime({ endMs: Date.parse('2026-09-25T23:45:00Z'), gameMs: Date.parse('2026-09-11T23:45:00Z'), resolved: false, futures: false }, Date.parse('2026-09-12T00:50:00Z')), Date.parse('2026-09-11T23:45:00Z'))
  eq('polyus: a daily market keeps endDate', deriveUsCloseTime({ endMs: NOW + 24 * H, gameMs: NOW + 2 * H, resolved: false, futures: false }, NOW), NOW + 24 * H)
  eq('polyus: no gameStart keeps endDate', deriveUsCloseTime({ endMs: NOW + 5 * H, gameMs: undefined, resolved: false, futures: false }, NOW), NOW + 5 * H)
  eq('polyus: futures flag from marketType', isUsFutures({ marketType: 'futures' }), true)
  eq('polyus: futures flag from sportsMarketType', isUsFutures({ marketType: 'moneyline', sportsMarketType: 'futures' }), true)
  eq('polyus: a moneyline is not futures', isUsFutures({ marketType: 'moneyline', sportsMarketType: 'team' }), false)
  eq('polyus: a drawable game is not futures', isUsFutures({ marketType: 'drawable_outcome' }), false)
}

// ---- Open rows adopt the venue's later close time (2026-09-08) ----
// Three PolyUS rows were opened before the futures fix with the NEXT FIXTURE
// as their close: two Solheim Cup micro-maker legs (real close 09-13) and a
// Champions League winner (real close June 2027). They read as "unsettled
// 19h past close" on every scan and never reached the out-of-window exit.
{
  const NOW = Date.parse('2026-09-08T11:00:00Z')
  const H = 3600_000
  const stored = Date.parse('2026-09-07T16:00:00Z')
  eq('closeTime: a later venue close is adopted', refreshedCloseTime(stored, Date.parse('2026-09-13T16:00:00Z')), Date.parse('2026-09-13T16:00:00Z'))
  eq('closeTime: an earlier venue close is ignored', refreshedCloseTime(stored, stored - 3 * H), undefined)
  eq('closeTime: an equal venue close is ignored', refreshedCloseTime(stored, stored), undefined)
  eq('closeTime: a missing venue close keeps the stored one', refreshedCloseTime(stored, undefined), undefined)
  eq('closeTime: a NaN venue close keeps the stored one', refreshedCloseTime(stored, NaN), undefined)
  // Before the refresh the row is stuck; after it, it is simply not due yet.
  eq('closeTime: the stale row trips the stuck-settlement audit', stuckSettlements([{ marketId: 'tec-lpga-solheim-2026-09-13-w-usa', closeTime: stored }], NOW).count, 1)
  eq('closeTime: the refreshed row does not', stuckSettlements([{ marketId: 'tec-lpga-solheim-2026-09-13-w-usa', closeTime: Date.parse('2026-09-13T16:00:00Z') }], NOW).count, 0)
}


// ---- time-of-day: the morning forecast update (2026-09-08) ----
// Kalshi's taker fee is 7% of p(1-p) ceiled to $0.0001, so at an ask of
// 0.20 one contract costs 0.07*0.16 = $0.0112 = 1.12c, and an edge must
// clear it before the arm may fire.
{
  const R = { fromHour: 8, toHour: 11, minEdgeCents: 5, minHoursToClose: 2 }
  const base = { fair: 0.35, bid: 0.18, ask: 0.20, localHour: 9, hoursToClose: 6, feeRate: 0.07 }
  const yes = morningForecastVerdict(base, R)
  eq('morning: buys YES when the forecast is above the ask', yes?.direction, 'YES')
  eq('morning: the edge is net of the taker fee', yes ? Math.round(yes.edgeCents * 100) / 100 : null, 13.88)
  eq('morning: the price paid is the ask', yes?.price, 0.20)
  const no = morningForecastVerdict({ ...base, fair: 0.05 }, R)
  eq('morning: buys NO when the forecast is below the bid', no?.direction, 'NO')
  eq('morning: the NO price recorded is the bid', no?.price, 0.18)
  eq('morning: a fair value inside the spread does not fire', morningForecastVerdict({ ...base, fair: 0.19 }, R), null)
  eq('morning: an edge that only exists before fees does not fire', morningForecastVerdict({ ...base, fair: 0.26 }, R), null)
  eq('morning: before the window it does not fire', morningForecastVerdict({ ...base, localHour: 7 }, R), null)
  eq('morning: at the closing hour it does not fire', morningForecastVerdict({ ...base, localHour: 11 }, R), null)
  eq('morning: too close to close it does not fire', morningForecastVerdict({ ...base, hoursToClose: 1 }, R), null)
  eq('morning: a certain fair value is rejected', morningForecastVerdict({ ...base, fair: 1 }, R), null)
  eq('morning: no ask means no YES entry', morningForecastVerdict({ ...base, ask: undefined }, R), null)
  eq('morning: a 99c ask is out of range', morningForecastVerdict({ ...base, fair: 0.999999, ask: 0.99, bid: 0.98 }, R), null)
  eq('morning: a fee-free series keeps the gross edge', Math.round((morningForecastVerdict({ ...base, feeRate: 0 }, R)?.edgeCents ?? 0) * 100) / 100, 15)
  // Both sides can look attractive only if fair sits outside the whole book;
  // the better one must win rather than both firing.
  eq('morning: the better side wins', morningForecastVerdict({ ...base, fair: 0.9 }, R)?.direction, 'YES')
}


// ---- lead-lag evidence counts filled sweeps only (2026-09-08) ----
// 358 "SWEEP EXECUTED" log lines in eight hours against two venue fills: the
// IOC was marked executed on acceptance, so the ladder credited this arm with
// settlements of markets the sweep never held.
{
  const SINCE = Date.parse('2026-09-08T03:24:58Z')
  const T = '2026-09-08T05:00:00Z'
  eq('leadlag: a filled sweep counts', leadLagRowCounts({ ts: T, kalshiTicker: 'KXBTC15M-26SEP080730-30', executed: true, filledContracts: 2 }, SINCE), true)
  eq('leadlag: a zero-fill sweep does not', leadLagRowCounts({ ts: T, kalshiTicker: 'KXBTC15M-26SEP080730-30', executed: true, filledContracts: 0 }, SINCE), false)
  eq('leadlag: a pre-fix row with no fill count does not', leadLagRowCounts({ ts: T, kalshiTicker: 'KXBTC15M-26SEP080730-30', executed: true }, SINCE), false)
  eq('leadlag: an unexecuted row does not', leadLagRowCounts({ ts: T, kalshiTicker: 'KXBTC15M-26SEP080730-30', executed: false, filledContracts: 2 }, SINCE), false)
  eq('leadlag: a row before the stage start does not', leadLagRowCounts({ ts: '2026-09-08T01:00:00Z', kalshiTicker: 'KXBTC15M-26SEP080730-30', executed: true, filledContracts: 2 }, SINCE), false)
  eq('leadlag: a row with no ticker does not', leadLagRowCounts({ ts: T, executed: true, filledContracts: 2 }, SINCE), false)
  eq('leadlag: an unparsable timestamp does not', leadLagRowCounts({ ts: 'not-a-date', kalshiTicker: 'KXBTC15M-26SEP080730-30', executed: true, filledContracts: 2 }, SINCE), false)
}

// ---- settlement probe: pinned quotes (2026-09-08, two NO-side losers unbooked for a day) ----
eq('pinned: NO price derived from a 0.99 last price', isPinnedQuote(1 - 0.99), true)
eq('pinned: YES at 0.99', isPinnedQuote(0.99), true)
eq('pinned: YES at 0.01', isPinnedQuote(0.01), true)
eq('pinned: 0.02 is live', isPinnedQuote(0.02), false)
eq('pinned: 0.985 is live', isPinnedQuote(0.985), false)
eq('pinned: NaN is not pinned', isPinnedQuote(NaN), false)

// ---- ratchet entry guard (2026-09-09: two "decided" brackets, one a total loss) ----
// KXLOWTBOS-26SEP07-B59.5: read as decided NO, bought NO at 4.2c, resolved YES.
eq('ratchet refuses a NO the market prices at 4c', ratchetEntryBlock('NO', 0.958, 0.02) !== null, true)
// KXLOWTBOS-26SEP08-B62.5: NO bought at 96c on a 12c-wide book (NO mid 90c).
eq('ratchet refuses a 12c-wide book', ratchetEntryBlock('NO', 0.1, 0.12) !== null, true)
// The intended trade: decided, still quoted at 92c on a tight book.
eq('ratchet allows a decided bracket at 92c on a 3c book', ratchetEntryBlock('NO', 0.08, 0.03), null)
eq('ratchet allows the YES mirror', ratchetEntryBlock('YES', 0.9, 0.03), null)
eq('ratchet refuses a YES the market prices at 12c', ratchetEntryBlock('YES', 0.12, 0.02) !== null, true)
eq('ratchet allows an unknown spread when the market agrees', ratchetEntryBlock('NO', 0.05, undefined), null)
eq('ratchet refuses a market with no price', ratchetEntryBlock('NO', 0, 0.02) !== null, true)
eq('ratchet refuses a fully-priced market', ratchetEntryBlock('YES', 1, 0.02) !== null, true)
eq('ratchet boundary: exactly at the agreement floor passes', ratchetEntryBlock('YES', 0.6, 0.02), null)
eq('ratchet boundary: exactly at the spread cap passes', ratchetEntryBlock('YES', 0.9, 0.06), null)

// ---- the mini's daily loss brake (2026-09-09 audit: the venue had no loss-based brake at all) ----
const DAY = '2026-09-09'
eq('brake: disabled at 0 (Manifold play money)', dailyBrakeBlock(0, { date: DAY, realized: -50, tripped: false }, DAY), null)
eq('brake: quiet while the day is green', dailyBrakeBlock(10, { date: DAY, realized: 4.2, tripped: false }, DAY), null)
eq('brake: quiet just inside the limit', dailyBrakeBlock(10, { date: DAY, realized: -9.99, tripped: false }, DAY), null)
eq('brake: trips exactly at the limit', dailyBrakeBlock(10, { date: DAY, realized: -10, tripped: false }, DAY) !== null, true)
eq('brake: trips past the limit', dailyBrakeBlock(10, { date: DAY, realized: -12.5, tripped: true }, DAY) !== null, true)
eq('brake: yesterday does not bind today', dailyBrakeBlock(10, { date: '2026-09-08', realized: -40, tripped: true }, DAY), null)
eq('brake: no ledger yet', dailyBrakeBlock(10, undefined, DAY), null)
eq('brake: a NaN ledger never halts', dailyBrakeBlock(10, { date: DAY, realized: NaN, tripped: false }, DAY), null)

// ---- weather category block covers precipitation (2026-09-09: fade opened KXRAIN 8h before close) ----
eq('weather series: rain', isWeatherSeries({ id: 'KXRAIN-26SEP08-AUS' }), true)
eq('weather series: snow', isWeatherSeries({ id: 'KXSNOW-26DEC01-BOS' }), true)
eq('weather series: high temp still caught', isWeatherSeries({ id: 'KXHIGHTBOS-26SEP09-B76.5' }), true)
eq('weather series: low temp still caught', isWeatherSeries({ id: 'KXLOWTBOS-26SEP09-B62.5' }), true)
eq('weather series: crypto is not weather', isWeatherSeries({ id: 'KXBTCD-26SEP0917-T80499.99' }), false)
// The live miss: no category on the market (cold cache) and a title that says "rain", not "rainfall".
eq('rain inside 48h is blocked with a cold category cache',
  fadeCategoryBlock({ id: 'KXRAIN-26SEP08-AUS', question: 'Will it rain in Austin on Sep 8?' }, 8 * 60), 'weather<48h')
eq('rain beyond 48h is not blocked',
  fadeCategoryBlock({ id: 'KXRAIN-26SEP08-AUS', question: 'Will it rain in Austin on Sep 8?' }, 72 * 60), null)

// ---- weather SEAT block: the generic arms stay out of the ladders entirely ----
// 2026-09-09: mean-reversion, newly on the maker path, rested into three KXLOWT
// brackets hours after the weather arms were retired. The seat there measures
// -1.70c/contract over 801,258 contracts and no generic arm's backtest covers it.
eq('seat block: mean-reversion out of a low-temp bracket',
  weatherSeatBlock('mean-reversion', 'KXLOWTATL-26SEP09-B69.5'),
  'weather series: maker seat measured at -1.70c/contract and no arm evidence in this class')
eq('seat block: volume-spike out of a high-temp bracket',
  weatherSeatBlock('volume-spike', 'KXHIGHTBOS-26SEP09-B76.5'),
  'weather series: maker seat measured at -1.70c/contract and no arm evidence in this class')
eq('seat block: fade out of rain at any horizon',
  weatherSeatBlock('fade', 'KXRAIN-26SEP08-AUS'),
  'weather series: maker seat measured at -1.70c/contract and no arm evidence in this class')
eq('seat block: snow too', weatherSeatBlock('news', 'KXSNOW-26DEC01-BOS') !== null, true)
// The weather-native arms keep their own gate (BACKLOG 25) and are not touched here.
eq('seat block: settlement/ratchet is weather-native', weatherSeatBlock('settlement', 'KXLOWTBOS-26SEP09-B62.5'), null)
eq('seat block: weather-morning is weather-native', weatherSeatBlock('weather-morning', 'KXHIGHTBOS-26SEP09-B76.5'), null)
// Non-weather series are untouched for every arm.
eq('seat block: crypto passes', weatherSeatBlock('mean-reversion', 'KXBTCD-26SEP0917-T80499.99'), null)
eq('seat block: sports passes', weatherSeatBlock('fade', 'KXNFLGAME-26SEP09NESEA-NE'), null)
// KXHIGHLAX is a legacy high-temperature series, not a lacrosse market.
eq('seat block: legacy KXHIGH<city> is weather', weatherSeatBlock('flow-follow', 'KXHIGHLAX-26SEP08-T89') !== null, true)

// ---- mean-reversion horizon ceiling (2026-09-09 throughput: it held 3-day markets) ----
{
  const MR = { minMoveCents: 8, minHoursToClose: 6, minEntryPrice: 0.35, maxHoursToClose: 24 }
  const drop = { prices: [0.60, 0.48], tradedCandles: 5 }
  eq('MR takes a 12h market', meanReversionVerdict({ ...drop, hoursToClose: 12 }, MR)?.direction, 'YES')
  eq('MR takes a market exactly at the ceiling', meanReversionVerdict({ ...drop, hoursToClose: 24 }, MR)?.direction, 'YES')
  eq('MR refuses a 3-day market', meanReversionVerdict({ ...drop, hoursToClose: 72 }, MR), null)
  eq('MR still refuses below the floor', meanReversionVerdict({ ...drop, hoursToClose: 3 }, MR), null)
  eq('MR ceiling of 0 disables the cap', meanReversionVerdict({ ...drop, hoursToClose: 72 }, { ...MR, maxHoursToClose: 0 })?.direction, 'YES')
  eq('MR with no ceiling set is unbounded', meanReversionVerdict({ ...drop, hoursToClose: 72 }, { minMoveCents: 8, minHoursToClose: 6, minEntryPrice: 0.35 })?.direction, 'YES')
}

// ---- PolyUS same-fixture grouping (2026-09-09: 10 fade positions on one NFL game vs a cap of 4) ----
eq('polyus: NFL touchdown props on one game share an underlying',
  underlyingOf('astatc-nfl-ne-sea-2026-09-09-td-machol-g'), 'event:nfl-ne-sea-2026-09-09')
eq('polyus: a different prop on the same game matches',
  underlyingOf('astatc-nfl-ne-sea-2026-09-09-tfg-sea-2pt'), 'event:nfl-ne-sea-2026-09-09')
eq('polyus: a different game does not',
  underlyingOf('astatc-nfl-sf-lar-2026-09-10-rec-colbpar-g'), 'event:nfl-sf-lar-2026-09-10')
eq('polyus: soccer fixture', underlyingOf('atc-lib-pal-lqu-2026-09-09-lqu'), 'event:lib-pal-lqu-2026-09-09')
eq('polyus: tennis fixture', underlyingOf('aec-atp-blaell-maxpur-2026-09-09'), 'event:atp-blaell-maxpur-2026-09-09')
eq('polyus: temperature ladder groups by city-day',
  underlyingOf('tc-temp-miahigh-2026-09-09-gte92lt93f'), 'event:temp-miahigh-2026-09-09')
eq('polyus: a different city does not',
  underlyingOf('tc-temp-sfohigh-2026-09-09-gte70lt71f'), 'event:temp-sfohigh-2026-09-09')
// Kalshi grouping must be untouched by the new branch.
eq('kalshi: same-game props still group', underlyingOf('KXMLBHRR-26SEP012210STLLAD-ABC'), 'game:26SEP012210STLLAD')
eq('kalshi: crypto series still group', underlyingOf('KXSOLD-26SEP0917-T105.9999'), 'crypto:SOL')
eq('kalshi: energy still groups', underlyingOf('KXWTI-26SEP0914-T97.49'), 'energy:oil')

// ---- settlement probe when the cached close is wrong in the late direction (2026-09-10 PolyUS) ----
const PROBE_T0 = 1789000000000
eq('probe: no quote at all is suspicious', settlementProbeDue(undefined, undefined, PROBE_T0), true)
eq('probe: a quote pinned at 1 is suspicious', settlementProbeDue(1, undefined, PROBE_T0), true)
eq('probe: a quote pinned at 0.01 is suspicious', settlementProbeDue(0.01, undefined, PROBE_T0), true)
eq('probe: a live mid-book quote is not', settlementProbeDue(0.42, undefined, PROBE_T0), false)
eq('probe: throttled inside the interval', settlementProbeDue(undefined, PROBE_T0 - 5 * 60_000, PROBE_T0), false)
eq('probe: due again after the interval', settlementProbeDue(undefined, PROBE_T0 - 11 * 60_000, PROBE_T0), true)
eq('probe: a live quote is never due, however long ago', settlementProbeDue(0.42, PROBE_T0 - 86_400_000, PROBE_T0), false)
// The close time must be adoptable in BOTH directions; refreshedCloseTime only ratchets later, which is
// why the NFL props stamped 2026-09-24 against a venue close of 2026-09-09T23:49Z never opened the gate.
eq('close: a later venue close is adopted', refreshedCloseTime(PROBE_T0, PROBE_T0 + 3_600_000), PROBE_T0 + 3_600_000)
eq('close: an earlier venue close is NOT adopted by the ratchet', refreshedCloseTime(PROBE_T0, PROBE_T0 - 3_600_000), undefined)

// ---- awaiting the venue vs stuck in our plumbing (2026-09-10 Manifold) ----
// Manifold's closeTime stops BETTING; resolution is the creator's whim. Four positions sat 87-161h past
// close, all fetching cleanly with isResolved=false, and the review read that as "resolution or ingestion
// lag". A row the venue itself says is pending is the venue's business; a row nobody has confirmed is ours.
const SS_NOW = Date.parse('2026-09-10T06:00:00Z')
const past = Date.parse('2026-09-03T13:31:00Z')
eq('stuck: an unconfirmed row past close still alarms',
  stuckSettlements([{ marketId: 'qRznQRgst5', closeTime: past }], SS_NOW).count, 1)
eq('stuck: a row the venue says is pending does not',
  stuckSettlements([{ marketId: 'qRznQRgst5', closeTime: past, venueUnresolvedAt: SS_NOW - 60_000 }], SS_NOW).count, 0)
eq('stuck: but it is still reported',
  stuckSettlements([{ marketId: 'qRznQRgst5', closeTime: past, venueUnresolvedAt: SS_NOW - 60_000 }], SS_NOW).awaitingVenue, 1)
eq('stuck: no message when everything is awaiting the venue',
  stuckSettlements([{ marketId: 'qRznQRgst5', closeTime: past, venueUnresolvedAt: SS_NOW - 60_000 }], SS_NOW).message, undefined)
// A settlement path that broke AFTER the last confirmation must resurface, so the stamp expires.
eq('stuck: a stale confirmation alarms again',
  stuckSettlements([{ marketId: 'qRznQRgst5', closeTime: past, venueUnresolvedAt: SS_NOW - 7 * 3_600_000 }], SS_NOW).count, 1)
eq('stuck: the message carries both counts',
  /\[1 more awaiting the venue's own resolution\]/.test(
    stuckSettlements(
      [
        { marketId: 'a', closeTime: past },
        { marketId: 'b', closeTime: past, venueUnresolvedAt: SS_NOW - 60_000 }
      ],
      SS_NOW
    ).message ?? ''
  ), true)

// ---- Kalshi universe pass: close-time windows (incident 2026-09-11T22-35) ----
// /markets does not order by close time. At the autoTrader's 72 h horizon the
// exchange held 25,155 open markets on 2026-09-11, the 48-72h inventory filled
// pages 1-20, and every market closing inside 6 h landed on pages 23-26 — so the
// 25-page bound silently dropped the 155 rows closing in 8-23 minutes. The pass
// now walks ascending close-time slices, so the near end is fetched first and a
// truncation can only ever cost the far end.
const UW_NOW = 1_000_000
const H_S = 3600
// 2026-09-18 (incident 2026-09-18T23-20): the slices themselves must be narrow
// enough never to truncate, because inside a slice the API returns its
// NEAREST-dated rows last — the 26-page 48-72h slice dropped 617 rows closing at
// the 48h edge, 190 of them in the scanner's universe. Six-hourly out to 72 h.
eq('windows: 72h horizon slices near-dated first, six-hourly',
  universeWindows(UW_NOW, UW_NOW - H_S, UW_NOW + 72 * H_S).map(([lo, hi]) => [(lo - UW_NOW) / H_S, (hi - UW_NOW) / H_S]),
  [[-1, 1], [1, 6], [6, 12], [12, 18], [18, 24], [24, 30], [30, 36], [36, 42], [42, 48], [48, 54], [54, 60], [60, 66], [66, 72]])
eq('windows: no slice inside the 72h horizon is wider than 6h',
  universeWindows(UW_NOW, UW_NOW - H_S, UW_NOW + 72 * H_S).every(([lo, hi]) => hi - lo <= 6 * H_S), true)
eq('windows: the first slice always starts at the floor',
  universeWindows(UW_NOW, UW_NOW - H_S, UW_NOW + 72 * H_S)[0][0], UW_NOW - H_S)
eq('windows: contiguous, no gap between slices',
  universeWindows(UW_NOW, UW_NOW - H_S, UW_NOW + 72 * H_S).every((w, i, a) => i === 0 || a[i - 1][1] === w[0]), true)
eq('windows: the last slice ends exactly at the horizon',
  universeWindows(UW_NOW, UW_NOW - H_S, UW_NOW + 72 * H_S).slice(-1)[0][1], UW_NOW + 72 * H_S)
eq('windows: a short horizon is one slice, not a ladder past it',
  universeWindows(UW_NOW, UW_NOW, UW_NOW + 2 * H_S).map(([lo, hi]) => [(lo - UW_NOW) / H_S, (hi - UW_NOW) / H_S]),
  [[0, 1], [1, 2]])
eq('windows: a caller floor above an edge drops the edges below it',
  universeWindows(UW_NOW, UW_NOW + 31 * H_S, UW_NOW + 72 * H_S).map(([lo, hi]) => [(lo - UW_NOW) / H_S, (hi - UW_NOW) / H_S]),
  [[31, 36], [36, 42], [42, 48], [48, 54], [54, 60], [60, 66], [66, 72]])
eq('windows: an empty horizon fetches nothing', universeWindows(UW_NOW, UW_NOW, UW_NOW), [])
eq('windows: an inverted horizon fetches nothing', universeWindows(UW_NOW, UW_NOW + H_S, UW_NOW), [])

void anchorSettlementTests().then(async () => {
  // ---- a band is only computable from a COMPLETE sum of squares (2026-09-12) ----
// flow-follow carried clvN=8, clvSum=-81.50, clvSq=96.75 against a floor of n*mean^2 = 830.28 - impossible,
// because clvSq started accumulating later than clvSum and covered only the last three observations.
eq('statsBand: ordinary triple', (() => { const b = statsBand(4, 10, 30, 4); return b ? [b.n, +b.mean.toFixed(2), +b.sd.toFixed(3)] : null })(), [4, 2.5, 1.291])
eq('statsBand: refuses when sqN disagrees with n', statsBand(8, -81.5, 96.75, 3), undefined)
eq('statsBand: refuses an impossible sum of squares even without a count', statsBand(8, -81.5, 96.75, undefined), undefined)
eq('statsBand: accepts a complete one without a count', statsBand(7, -78, 3130, undefined) !== undefined, true)
eq('statsBand: refuses fewer than two observations', statsBand(1, 5, 25, 1), undefined)
eq('statsBand: refuses a missing sum of squares', statsBand(10, 5, undefined, undefined), undefined)
eq('statsBand: zero variance is a band, not a refusal', (() => { const b = statsBand(3, 9, 27, 3); return b ? [b.sd, b.lo, b.hi] : null })(), [0, 3, 3])
// The real fade numbers: the stored triple understated the SE by 1.6x, so the guard must reject it.
eq('statsBand: rejects fade\'s short triple', statsBand(117, -102, 17195, 93), undefined)

// ---- momentum candidate recorder (round 90, §76 / backlog 67) ----
{
  const NOW = 1_800_000_000_000
  const nowSec = Math.floor(NOW / 1000)
  const mk = (closes: (number | undefined)[], opts: { vol?: number[]; bidAsk?: [number, number][] } = {}) =>
    closes.map((close, i) => ({
      endTs: nowSec - (closes.length - 1 - i) * 60,
      close,
      bidClose: opts.bidAsk?.[i]?.[0],
      askClose: opts.bidAsk?.[i]?.[1],
      volume: opts.vol?.[i] ?? 1
    }))
  const market = { venue: 'kalshi' as const, id: 'KXTEST-1', question: 'q', status: 'open' as const, eventTicker: 'KXTEST', seriesTicker: 'KXTEST', category: 'crypto', closeTime: NOW + 3_600_000 }
  const cfg = { windowMin: 10, thr: 0.03 }
  const ramp = (a: number, b: number, n = 10): number[] => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1))
  const near = (name: string, got: number | undefined, want: number, tol = 0.001): void =>
    eq(name, got !== undefined && Math.abs(got - want) < tol, true)
  // The §76 table: a 3c move is 0.543 in log-odds at 4.5c, 0.120 at 50c, 0.947 at 95c.
  near('candidate: 0.045->0.075 is 0.543 log-odds', computeCandidate(market, mk(ramp(0.045, 0.075)), undefined, cfg, NOW)?.moveLogit, 0.5432)
  near('candidate: 0.50->0.53 is 0.120', computeCandidate(market, mk(ramp(0.5, 0.53)), undefined, cfg, NOW)?.moveLogit, 0.1201)
  near('candidate: 0.95->0.98 is 0.947', computeCandidate(market, mk(ramp(0.95, 0.98)), undefined, cfg, NOW)?.moveLogit, 0.9469)
  // The engine comment's own example: a 4.5c->5c tick is 0.111, near-identical to 3c at the money.
  near('candidate: a 4.5c->5c tick is 0.111', computeCandidate(market, mk(ramp(0.045, 0.05)), undefined, cfg, NOW)?.moveLogit, 0.1106)
  const up = computeCandidate(market, mk(ramp(0.5, 0.53), { vol: [1, 0, 0, 1, 0, 0, 1, 0, 0, 0] }), { venue: 'kalshi', marketId: market.id, bids: [{ price: 0.52, size: 10 }], asks: [{ price: 0.54, size: 5 }] }, cfg, NOW)
  eq('candidate: point move, side, threshold, quotes, confirmation facts', up && [up.movePoints, up.side, up.thrPoints, up.yb, up.ya, up.candles, up.volCandles, up.midHeld, up.slot, up.close], [3, 'YES', 3, 0.52, 0.54, 10, 3, true, Math.floor(NOW / 600_000), new Date(NOW + 3_600_000).toISOString()])
  eq('candidate: a falling window buys NO', computeCandidate(market, mk(ramp(0.6, 0.55)), undefined, cfg, NOW)?.side, 'NO')
  eq('candidate: too few candles in the window is no candidate', computeCandidate(market, mk(ramp(0.5, 0.53, 4)), undefined, cfg, NOW), undefined)
  // Ten candles, but six of them older than the window: the live arm sees four and continues.
  const stale = mk(ramp(0.5, 0.53)).map((c, i) => ({ ...c, endTs: i < 6 ? c.endTs - 3600 : c.endTs }))
  eq('candidate: candles outside the window do not count', computeCandidate(market, stale, undefined, cfg, NOW), undefined)
  eq('candidate: no trade close falls back to the bid/ask mid', computeCandidate(market, mk(Array(10).fill(undefined), { bidAsk: Array.from({ length: 10 }, (_, i) => [0.4 + i * 0.005, 0.42 + i * 0.005] as [number, number]) }), undefined, cfg, NOW)?.movePoints, 4.5)
  eq('candidate: direction not held at mid-window is recorded as such', computeCandidate(market, mk([0.5, 0.49, 0.48, 0.47, 0.46, 0.45, 0.48, 0.5, 0.52, 0.53]), undefined, cfg, NOW)?.midHeld, false)
  const edge = computeCandidate(market, mk(ramp(0.97, 1.0)), undefined, cfg, NOW)
  eq('candidate: a price at 1 has no log-odds, and the field is omitted rather than NaN', edge && ['moveLogit' in edge, edge.movePoints], [false, 3])
  // Review round 90b. midOf is the live arm's: both sides averaged, else the one side quoted.
  eq('midOf: both sides average, one side stands alone, none is undefined', [midOf(0.4, 0.44), midOf(0.4, undefined), midOf(undefined, 0.42), midOf(undefined, undefined)].map((v) => (v === undefined ? undefined : Math.round(v * 1000) / 1000)), [0.42, 0.4, 0.42, undefined])
  // The review's reproduction: oldest candle with no trade and only a bid. The live arm priced it at 0.40
  // and evaluated the window; the recorder's first version returned undefined and left no trace.
  const oneSided = mk([undefined, 0.405, 0.41, 0.415, 0.42, 0.425, 0.43, 0.435, 0.44, 0.445]).map((c, i) => (i === 0 ? { ...c, bidClose: 0.4, askClose: undefined } : c))
  eq('candidate: a one-sided candle is priced as the live arm prices it, not dropped', (() => { const r = computeCandidate(market, oneSided, undefined, cfg, NOW); return r && [r.from, r.movePoints] })(), [0.4, 4.5])
  eq('candidate: a NaN close time yields no close, and no throw', (() => { try { const r = computeCandidate({ ...market, closeTime: Number.NaN }, mk(ramp(0.5, 0.53)), undefined, cfg, NOW); return r && ['close' in r, r.movePoints] } catch (e) { return String(e) } })(), [false, 3])
  const flat0 = computeCandidate(market, mk(Array(10).fill(0.5)), undefined, cfg, NOW)
  eq('candidate: a zero move carries the live arm\'s literal labels (NO, not held)', flat0 && [flat0.side, flat0.midHeld, flat0.movePoints], ['NO', false, 0])

  // The recorder: inert without a dir, then floor / per-slot dedup / growth re-record / day cap.
  resetMomentumCandidates()
  const row = (ticker: string, movePoints: number, slot = 1) => ({ ts: NOW, ticker, slot, windowMin: 10, candles: 10, volCandles: 3, from: 0.5, to: 0.5 + movePoints / 100, movePoints, midHeld: true, thrPoints: 3, side: 'YES' as const })
  eq('recorder: inert without a dir', (() => { recordMomentumCandidates([row('A', 3)], 1, 1, NOW); return [momentumCandidatesActive(), momentumCandidateStats().rowsToday] })(), [false, 0])
  const dir = mkdtempSync(joinPath(tmpdir(), 'momrec-'))
  try {
    setMomentumCandidateDir(dir)
    const file = joinPath(dir, `${new Date(NOW).toISOString().slice(0, 10)}.jsonl`)
    const lines = (): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
    recordMomentumCandidates([row('A', 0.5), row('B', -1), row('C', 3)], 3, 3, NOW)
    eq('recorder: a sub-cent move is not a candidate; a one-cent move is', lines().length, 2)
    recordMomentumCandidates([row('B', -1), row('C', 3.5)], 2, 2, NOW)
    eq('recorder: the same slot re-records nothing under a cent of growth', lines().length, 2)
    recordMomentumCandidates([row('C', 4)], 1, 1, NOW)
    eq('recorder: a cent of growth within the slot is re-recorded', lines().length, 3)
    recordMomentumCandidates([row('C', 1, 2)], 1, 1, NOW)
    eq('recorder: a new slot starts fresh for the ticker', lines().length, 4)
    eq('recorder: stats count what was written', [momentumCandidateStats().rowsToday, momentumCandidateStats().droppedToday], [4, 0])
    // Re-review round 90c: a failed write is counted, not claimed, and the row is offered again next scan.
    const blocker = joinPath(dir, 'not-a-dir')
    writeFileSync(blocker, 'x')
    setMomentumCandidateDir(joinPath(blocker, 'child'))
    recordMomentumCandidates([row('W', 3, 7)], 1, 1, NOW)
    const failed = momentumCandidateStats()
    setMomentumCandidateDir(dir)
    recordMomentumCandidates([row('W', 3, 7)], 1, 1, NOW)
    eq('recorder: a failed write counts as failed, claims nothing, and the row lands on the next scan', [failed.rowsToday, failed.writeFailedToday, momentumCandidateStats().rowsToday, lines().length], [4, 1, 5, 5])
    const flood = Array.from({ length: MAX_ROWS_PER_DAY + 5 }, (_, i) => row(`F${i}`, 2, 3))
    recordMomentumCandidates(flood, flood.length, flood.length, NOW)
    // Five rows are on disk by now (the failed-write case above landed its retry), so the flood gets 39,995 slots.
    eq('recorder: the day cap holds and drops are counted, not hidden', [lines().length, momentumCandidateStats().droppedToday], [MAX_ROWS_PER_DAY, 10])
    recordMomentumCandidates([row('A', 3, 4)], 1, 1, NOW + 86_400_000)
    eq('recorder: a new UTC day resets the cap', [momentumCandidateStats().rowsToday, momentumCandidateStats().droppedToday], [1, 0])
    // The log is hourly with the hour's totals, not a line per scan with a fresh row.
    resetMomentumCandidates()
    setMomentumCandidateDir(dir)
    const logged: string[] = []
    const realLog = console.log
    console.log = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }
    try {
      recordMomentumCandidates([row('H1', 3, 9)], 5, 4, NOW + 2 * 86_400_000)
      recordMomentumCandidates([row('H2', 3, 9)], 5, 4, NOW + 2 * 86_400_000 + 30_000)
      recordMomentumCandidates([row('H3', 3, 9)], 5, 0, NOW + 2 * 86_400_000 + 60_000)
      const afterThree = logged.filter((l) => l.includes('[momentum-rec]')).length
      recordMomentumCandidates([], 5, 0, NOW + 2 * 86_400_000 + 3_600_000 + 1)
      const afterHour = logged.filter((l) => l.includes('[momentum-rec]'))
      eq('recorder: one line at start, none per scan, one at the hour with totals', [afterThree, afterHour.length, /last 3 scans: 2 recorded/.test(afterHour[1] ?? '')], [1, 2, true])
      eq('recorder: the hourly line carries the failed-write count', /0 failed to write/.test(afterHour[1] ?? ''), true)
    } finally {
      console.log = realLog
    }
  } finally {
    resetMomentumCandidates()
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- lead-lag speed and breadth (round 91, backlog 84) ----
{
  const pairs = leadLagPairs(1789290000)
  // A maker reprice forfeits queue position on Kalshi, and this account's own settled markets show amended maker
  // orders at -2.17c/contract against +0.33c for never-amended ones. Chase only a move worth the lost slot.
  eq('maker reprice: 1c and 2c moves hold the queue slot, 3c repriced',
    [shouldRepriceMaker(0.41, 0.40), shouldRepriceMaker(0.42, 0.40), shouldRepriceMaker(0.43, 0.40), shouldRepriceMaker(0.37, 0.40)],
    [false, false, true, true])
  eq('leadlag: book top is best YES bid and 1 - best NO bid, unsorted levels and empty sizes ignored',
    [kalshiBookTop({ orderbook_fp: { yes_dollars: [['0.7900', '5'], ['0.8000', '3'], ['0.8100', '0']], no_dollars: [['0.1900', '4'], ['0.1800', '9']] } }),
      kalshiBookTop({ orderbook_fp: { yes_dollars: [['0.5', '1']], no_dollars: [] } }), kalshiBookTop(null)],
    [{ bid: 0.8, ask: 0.81 }, undefined, undefined])
  eq('leadlag: eight pairs, one per coin on both venues', [pairs.length, LEADLAG_COINS.length, pairs.map((p) => p.coin)], [8, 8, ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'ZEC']])
  eq('leadlag: ZEC slug and series', [pairs[7].pmSlug, pairs[7].kSeries], ['zec-updown-15m-1789290000', 'KXZEC15M'])
  eq('leadlag: configured universe can run the baseline pair plus one selected coin', leadLagPairs(1789290000, ['BTC', 'ETH', 'HYPE']).map((p) => p.coin), ['BTC', 'ETH', 'HYPE'])
  eq('leadlag: slug and series shapes', [pairs[2].pmSlug, pairs[2].kSeries, pairs[6].pmSlug, pairs[6].kSeries], ['sol-updown-15m-1789290000', 'KXSOL15M', 'hype-updown-15m-1789290000', 'KXHYPE15M'])
  eq('leadlag: a tight two-sided book may be compared', polyBookTradeable({ source: 'clob-book', bid: 0.5, ask: 0.52 }, 5).ok, true)
  eq('leadlag: a book at exactly the cap may be compared', polyBookTradeable({ source: 'clob-book', bid: 0.5, ask: 0.55 }, 5).ok, true)
  eq('leadlag: a wide book is refused with the width', polyBookTradeable({ source: 'clob-book', bid: 0.4, ask: 0.5 }, 5), { ok: false, why: 'book 10.0c wide (max 5c)' })
  eq('leadlag: the midpoint fallback is refused (it used to trade)', polyBookTradeable({ source: 'clob-mid' }, 5), { ok: false, why: 'no book' })
  eq('leadlag: slug epoch parses', [slugEpoch('btc-updown-15m-1789290000'), slugEpoch('nonsense')], [1789290000, undefined])
  const c = new SlugTokenCache()
  c.set('btc-updown-15m-1789288200', { upToken: 'a', marketId: '1' })
  c.set('btc-updown-15m-1789289100', { upToken: 'b', marketId: '2' })
  c.set('btc-updown-15m-1789290000', { upToken: 'c', marketId: '3' })
  c.prune(1789290000)
  eq('leadlag: the cache keeps the current and previous window only', [c.size, c.get('btc-updown-15m-1789288200'), c.get('btc-updown-15m-1789289100')?.upToken, c.get('btc-updown-15m-1789290000')?.upToken], [2, undefined, 'b', 'c'])
  // Round 91b: window caps on FILLED exposure.
  const wcfg = { leadLagMaxContractsPerWindow: 24, leadLagMaxSpendPerWindow: 60 }
  const fills = new Map([['KXBTC15M-1', { contracts: 16, spend: 8 }]])
  eq('window: room for a sweep under both caps', windowRoom(fills, 30, 'KXBTC15M-1', 8, 0.5, wcfg).ok, true)
  eq('window: the per-ticker contract cap binds', windowRoom(fills, 30, 'KXBTC15M-1', 9, 0.5, wcfg).ok, false)
  eq('window: another ticker has its own contract room', windowRoom(fills, 30, 'KXETH15M-1', 24, 0.5, wcfg).ok, true)
  eq('window: the shared spend cap binds across tickers', windowRoom(fills, 55, 'KXETH15M-1', 8, 0.9, wcfg), { ok: false, why: '$55.00 of $60.00 already spent this window' })
  // Round 93: proven coins at the ladder's size, the rest at micro size; the pool counts proven rows only.
  const scfg = { leadLagMaxContractsPerOrder: 8, leadLagProvenCoins: LEADLAG_PROVEN_DEFAULT, leadLagNewCoinContracts: 2 }
  eq('size: BTC and ETH sweep at the ladder size, the rest at two', [sweepSizeFor('BTC', scfg), sweepSizeFor('ETH', scfg), sweepSizeFor('SOL', scfg), sweepSizeFor('HYPE', scfg)], [8, 8, 2, 2])
  eq('size: a promoted coin takes the ladder size; the micro size never exceeds it', [sweepSizeFor('SOL', { ...scfg, leadLagProvenCoins: ['BTC', 'ETH', 'SOL'] }), sweepSizeFor('DOGE', { ...scfg, leadLagMaxContractsPerOrder: 1 })], [8, 1])
  const lrow = (u?: string) => ({ ts: new Date().toISOString(), kalshiTicker: 'KXX15M-1', executed: true, filledContracts: 2, underlying: u })
  eq('pool: proven, unproven and pre-expansion rows', [leadLagRowCounts(lrow('BTC'), 0), leadLagRowCounts(lrow('SOL'), 0), leadLagRowCounts(lrow(undefined), 0), leadLagRowCounts(lrow('SOL'), 0, ['BTC', 'ETH', 'SOL'])], [true, false, true, true])
}

// ---- scan phase timing (round 92, backlog 87) ----
eq('phases: cumulative marks become per-phase durations in order', phaseDurations([['exits', 2100], ['universe', 43400], ['data', 49400], ['sports', 61800], ['signals', 62700], ['gate', 92900], ['review', 108000], ['execute', 108700]]), { exits: 2100, universe: 41300, data: 6000, sports: 12400, signals: 900, gate: 30200, review: 15100, execute: 700 })
eq('phases: an empty scan has no phases', phaseDurations([]), {})
eq('phases: a clock that goes backwards never yields a negative phase', phaseDurations([['a', 100], ['b', 90]]), { a: 100, b: 0 })
eq('phases: a repeated name sums its slices', phaseDurations([['a', 100], ['b', 150], ['a', 400]]), { a: 350, b: 50 })

killStateTests()
dnsFallbackTests()
crossVenueBatchTests()
cullCacheTests()

await leadLagContainmentTests()
await cancelOrderTests()
await activityPacingTests()
consensusTests()
console.log(`review-fixes: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
})

// ---- Polymarket US cancels carry the market slug (2026-09-12) ----
// An empty body is HTTP 400 {"code":3} INVALID_ARGUMENT, and nineteen rests of two
// switched-off strategies stayed live on the venue because every cancel was refused.
/**
 * Round 91b regression, from the review's own reproduction: the REAL engine with fetch mocked. BTC's Kalshi
 * body is malformed on the first call while ETH shows a fee-clearing dislocation whose response arrives
 * late. Before the fix the malformed body rejected the whole batch, the summary note was replaced by
 * "scan failed", the running guard was released with ETH still in flight, and an immediately following cycle
 * swept the same edge again. After: one sweep per cycle, the note intact and adding up, the guard held
 * until every pair settled, and the per-ticker window cap holding the third cycle.
 */
async function leadLagContainmentTests(): Promise<void> {
  const windowStartEpoch = Math.floor(Date.now() / 900_000) * 900
  const closeTimeIso = new Date((windowStartEpoch + 900) * 1000).toISOString()
  const kalshiCalls = new Map<string, number>()
  const orders: string[] = []
  const logs: string[] = []
  const coinOf = (u: string): string => (/(?:series_ticker=KX|slug=|token_id=)([A-Z0-9]+)/i.exec(u)?.[1] ?? '').toUpperCase().replace('_TOKEN', '').replace('15M', '')
  // The list only resolves the ticker; the quote the engine trades on comes from that ticker's orderbook. The list
  // carries a deliberately wrong quote so a regression to list pricing changes every result below.
  const lastQuote = new Map<string, [number, number]>()
  const payload = (yb: number, ya: number, ticker: string) => { lastQuote.set(ticker, [yb, ya]); return { markets: [{ ticker, close_time: closeTimeIso, yes_bid_dollars: '0.01', yes_ask_dollars: '0.99' }] } }
  const bookFor = (u: string): Response => {
    const q = lastQuote.get(decodeURIComponent(/markets\/([^/?]+)\/orderbook/.exec(u)?.[1] ?? ''))
    return { ok: true, json: async () => ({ orderbook_fp: q ? { yes_dollars: [[String(q[0]), '100']], no_dollars: [[(1 - q[1]).toFixed(2), '100']] } : {} }) } as unknown as Response
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
    const u = String(url)
    if (u.includes('gamma-api.polymarket.com/events')) {
      const coin = (/slug=([a-z0-9]+)-updown/i.exec(u)?.[1] ?? 'x').toUpperCase()
      return { ok: true, json: async () => [{ markets: [{ id: `${coin}_MARKET`, clobTokenIds: JSON.stringify([`${coin}_TOKEN`]) }] }] } as unknown as Response
    }
    if (u.includes('clob.polymarket.com/book')) return { ok: true, json: async () => ({ bids: [{ price: '0.59', size: '100' }], asks: [{ price: '0.61', size: '100' }] }) } as unknown as Response
    if (u.includes('/orderbook')) return bookFor(u)
    if (u.includes('kalshi.com/trade-api/v2/markets')) {
      const coin = coinOf(u)
      const n = (kalshiCalls.get(coin) ?? 0) + 1
      kalshiCalls.set(coin, n)
      if (coin === 'BTC' && n === 1) return { ok: true, json: async () => { throw new Error('malformed body') } } as unknown as Response
      // A 200 whose body is the JSON literal null: parses fine, then throws PAST the fetch guard on `.markets`.
      if (coin === 'SOL' && n === 1) return { ok: true, json: async () => null } as unknown as Response
      if (coin === 'ETH') {
        if (n === 1) await new Promise((r) => setTimeout(r, 80))
        return { ok: true, json: async () => payload(0.49, 0.5, `KXETH15M-${windowStartEpoch}`) } as unknown as Response
      }
      return { ok: true, json: async () => payload(0.59, 0.61, `KX${coin}15M-${windowStartEpoch}`) } as unknown as Response
    }
    throw new Error('unmocked fetch: ' + u)
  }) as typeof fetch
  const adapter = { placeOrder: async (o: { marketId: string }) => { orders.push(o.marketId); return { shares: 1, avgPrice: 0.5 } } } as unknown as VenueAdapter
  const cfg = { leadLagEnabled: true, leadLagLiveEnabled: true, leadLagMinDislocationCents: 4, leadLagMaxSpreadCents: 5, leadLagMaxContractsPerOrder: 1, leadLagMaxCapitalSpend: 20, leadLagMaxContractsPerWindow: 2, leadLagMaxSpendPerWindow: 60, leadLagProvenCoins: LEADLAG_PROVEN_DEFAULT, leadLagNewCoinContracts: 2, leadLagMaxCoinsPerDirectionPerWindow: 7, pollIntervalMs: 10_000 }
  const dir = mkdtempSync(joinPath(tmpdir(), 'leadlag-'))
  try {
    const engine = new LeadLagEngine(joinPath(dir, 'state.json'), (s) => { logs.push(s) })
    await engine.scanAndSweep(adapter, cfg, 'live', true, false, false)
    const s1 = engine.status(cfg)
    eq('leadlag: a malformed body costs one coin its turn, not the batch (note is a summary that adds up)', [s1.note.startsWith('scanned 8 15m crypto pairs (6 live CLOB books), found 1 dislocations'), /1 Kalshi fetch failed/.test(s1.note), /1 errors/.test(s1.note)], [true, true, true])
    eq('leadlag: a throw past the fetch guard reaches the per-pair catch, is logged once, and the rest still sweep', [logs.filter((l) => /SOL pair error \(contained\)/.test(l)).length, s1.foundLast], [1, 1])
    eq('leadlag: the late pair settled INSIDE its own cycle - one sweep, guard released after', [orders.length, s1.tradesExecuted, s1.active], [1, 1, false])
    await engine.scanAndSweep(adapter, cfg, 'live', true, false, false)
    await engine.scanAndSweep(adapter, cfg, 'live', true, false, false)
    const s3 = engine.status(cfg)
    eq('leadlag: the per-ticker window cap holds the third sweep of a persistent edge', [orders.length, s3.tradesExecuted, logs.some((l) => /sweep held on KXETH15M.*window cap/.test(l))], [2, 2, true])
    eq('leadlag: the same dislocation is recorded once a minute, not once a cycle', s3.dislocationsLogged, 1)
    const cadence = readFileSync(joinPath(dir, 'state-cadence-shadow.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x))
    const cadenceMinutes = new Set(cadence.map((x) => Math.floor(Date.parse(x.ts) / 60_000))).size
    eq('leadlag: cadence shadow records every clearing observation but samples one scan per minute for 60 s', [cadence.length, cadence.filter((x) => x.sample60).length, cadence.every((x) => x.pollIntervalMs === 10_000)], [3, cadenceMinutes, true])
  } finally {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  }
  // The shared window spend cap under CONCURRENT sweeps: every pair dislocates at once, placeOrder is slow.
  // Before 91c each pair read the untouched total and all seven orders went out past the cap.
  const orders2: string[] = []
  const fetch2 = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
    const u = String(url)
    if (u.includes('gamma-api.polymarket.com/events')) {
      const coin = (/slug=([a-z0-9]+)-updown/i.exec(u)?.[1] ?? 'x').toUpperCase()
      return { ok: true, json: async () => [{ markets: [{ id: `${coin}_MARKET`, clobTokenIds: JSON.stringify([`${coin}_TOKEN`]) }] }] } as unknown as Response
    }
    if (u.includes('clob.polymarket.com/book')) return { ok: true, json: async () => ({ bids: [{ price: '0.59', size: '100' }], asks: [{ price: '0.61', size: '100' }] }) } as unknown as Response
    if (u.includes('/orderbook')) return bookFor(u)
    if (u.includes('kalshi.com/trade-api/v2/markets')) return { ok: true, json: async () => payload(0.49, 0.5, `KX${coinOf(u)}15M-${windowStartEpoch}`) } as unknown as Response
    throw new Error('unmocked fetch: ' + u)
  }) as typeof fetch
  const slowAdapter = { placeOrder: async (o: { marketId: string }) => { await new Promise((r) => setTimeout(r, 20)); orders2.push(o.marketId); return { shares: 8, avgPrice: 0.5 } } } as unknown as VenueAdapter
  const dir2 = mkdtempSync(joinPath(tmpdir(), 'leadlag2-'))
  try {
    const engine2 = new LeadLagEngine(joinPath(dir2, 'state.json'), () => undefined)
    await engine2.scanAndSweep(slowAdapter, { ...cfg, leadLagMaxContractsPerOrder: 8, leadLagMaxContractsPerWindow: 24, leadLagMaxSpendPerWindow: 10 }, 'live', true, false, false)
    // BTC and ETH reserve 8 x $0.51 = $4.08 each before their awaits, SOL 2 x $0.51 = $1.02 (micro size);
    // the $10 cap admits those three and holds the other four.
    eq('leadlag: the shared window spend cap holds under seven concurrent sweeps', [orders2.length, engine2.status(cfg).tradesExecuted], [3, 3])
    eq('leadlag: unproven coins swept at micro size', orders2.filter((t) => !/KX(BTC|ETH)15M/.test(t)).length, 1)
  } finally {
    globalThis.fetch = fetch2
    rmSync(dir2, { recursive: true, force: true })
  }
  // Round 94: the direction cap, ONE seat. ETH dislocates YES on its first look only and fills zero; SOL
  // dislocates YES every cycle. Cycle 1: ETH takes the seat before its await, SOL is held, ETH fills nothing
  // and gives the seat back. Cycle 2: ETH is quiet, so the seat can only be SOL's - and only if the release
  // happened. Without the release ETH squats the seat and SOL is held again (the review showed the earlier
  // version of this test passed with the release removed, because the zero-fill coin re-took its own seat).
  const orders3: string[] = []
  let call3 = 0
  const kcalls3 = new Map<string, number>()
  const fetch3 = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
    const u = String(url)
    if (u.includes('gamma-api.polymarket.com/events')) {
      const coin = (/slug=([a-z0-9]+)-updown/i.exec(u)?.[1] ?? 'x').toUpperCase()
      return { ok: true, json: async () => [{ markets: [{ id: `${coin}_MARKET`, clobTokenIds: JSON.stringify([`${coin}_TOKEN`]) }] }] } as unknown as Response
    }
    if (u.includes('clob.polymarket.com/book')) return { ok: true, json: async () => ({ bids: [{ price: '0.59', size: '100' }], asks: [{ price: '0.61', size: '100' }] }) } as unknown as Response
    if (u.includes('/orderbook')) return bookFor(u)
    if (u.includes('kalshi.com/trade-api/v2/markets')) {
      const coin = coinOf(u)
      const n = (kcalls3.get(coin) ?? 0) + 1
      kcalls3.set(coin, n)
      const dislocated = coin === 'SOL' || (coin === 'ETH' && n === 1)
      return { ok: true, json: async () => (dislocated ? payload(0.49, 0.5, `KX${coin}15M-${windowStartEpoch}`) : payload(0.59, 0.61, `KX${coin}15M-${windowStartEpoch}`)) } as unknown as Response
    }
    throw new Error('unmocked fetch: ' + u)
  }) as typeof fetch
  const dirAdapter = { placeOrder: async (o: { marketId: string }) => { call3++; orders3.push(o.marketId); return { shares: call3 === 1 ? 0 : 1, avgPrice: 0.5 } } } as unknown as VenueAdapter
  const dir3 = mkdtempSync(joinPath(tmpdir(), 'leadlag3-'))
  const logs3: string[] = []
  try {
    const engine3 = new LeadLagEngine(joinPath(dir3, 'state.json'), (s) => { logs3.push(s) })
    const dcfg = { ...cfg, leadLagMaxContractsPerWindow: 24, leadLagMaxSpendPerWindow: 100, leadLagMaxCoinsPerDirectionPerWindow: 1 }
    await engine3.scanAndSweep(dirAdapter, dcfg, 'live', true, false, false)
    const afterOne = [...orders3]
    await engine3.scanAndSweep(dirAdapter, dcfg, 'live', true, false, false)
    eq('leadlag: one seat per direction; the seat a zero fill gives back goes to the OTHER coin next cycle', [afterOne.map((t) => t.slice(0, 5)), orders3.map((t) => t.slice(0, 5)), engine3.status(dcfg).tradesExecuted, logs3.some((l) => /sweep held on KXSOL15M.*1 coins already YES/.test(l))], [['KXETH'], ['KXETH', 'KXSOL'], 1, true])
  } finally {
    globalThis.fetch = fetch3
    rmSync(dir3, { recursive: true, force: true })
  }
}

async function cancelOrderTests(): Promise<void> {
  const a = new PolymarketUsAdapter()
  await a.init({ apiKeyId: 'test-key', privateKey: Buffer.alloc(32, 7).toString('base64') })
  const sent: { path: string; body: unknown }[] = []
  ;(a as unknown as { api: { post: (path: string, body?: unknown) => Promise<unknown> } }).api = {
    post: async (path: string, body?: unknown) => {
      sent.push({ path, body })
      return {}
    }
  }
  await a.cancelOrder('CE2F1QE44TMX', 'asc-lg1-aja-ogc-2026-09-12-neg-2pt5')
  eq('polyus cancel: path', sent[0]?.path, '/v1/order/CE2F1QE44TMX/cancel')
  eq('polyus cancel: body carries the slug', sent[0]?.body, { marketSlug: 'asc-lg1-aja-ogc-2026-09-12-neg-2pt5' })
  await a.cancelOrder('CE2F1QE44TMX')
  eq('polyus cancel: no slug, no invented one', sent[1]?.body, {})
}

// ---- the activity feed is paginated at a pace the venue tolerates (2026-09-12) ----
// Unpaced, the ~20-page burst 429s and the 3 HTTP retries (~4 s) cannot clear a per-minute
// window: on 2026-09-12 71 of 80 reconciler runs failed over 5 h 50 m and 12 fills went
// unpublished. Assert the loop actually waits between pages.
async function activityPacingTests(): Promise<void> {
  const a = new PolymarketUsAdapter()
  await a.init({ apiKeyId: 'test-key', privateKey: Buffer.alloc(32, 7).toString('base64') })
  const at: number[] = []
  const row = { activityType: 'ACTIVITY_TYPE_TRADE' }
  ;(a as unknown as { api: { get: (path: string) => Promise<unknown> } }).api = {
    get: async () => {
      at.push(Date.now())
      return at.length < 3
        ? { activities: [row], nextCursor: `c${at.length}`, eof: false }
        : { activities: [row], eof: true }
    }
  }
  await a.getFills(1000)
  eq('polyus activities: paged to the feed end', at.length, 3)
  const gaps = at.slice(1).map((t, i) => t - at[i])
  eq('polyus activities: every page after the first waits', gaps.every((g) => g >= ACTIVITY_PAGE_PACE_MS - 50), true)
  eq('polyus activities: the first page does not wait', ACTIVITY_PAGE_PACE_MS > 0, true)
// ---- capacity vetoes are now priced, not argued about (round 81) ----
// Every capacity veto in entryBlocked was ungraded: watchVeto was called at exactly two sites (the LLM gate
// and the fade category filter), so we had no data at all on what the caps cost. capacityKey decides both
// WHETHER a block is gradeable and WHICH bucket it lands in, so both halves need cover.
// These strings are copied from entryBlocked's actual return statements - if one is edited without updating
// the classifier, this test still holds the old text and fails. That is the drift alarm.
eq('capacity: max open positions', capacityKey('max open positions'), 'max-open')
eq('capacity: unsettled backlog', capacityKey('unsettled backlog too large'), 'unsettled-backlog')
eq('capacity: daily trade cap', capacityKey('daily trade cap'), 'daily-cap')
eq('capacity: event exposed', capacityKey('event already exposed'), 'event-exposed')
eq('capacity: event resting', capacityKey('event already resting'), 'event-exposed')
eq('capacity: per-market entry cap', capacityKey('per-market entry cap (2 per day)'), 'per-market-cap')
eq('capacity: re-entry lockout', capacityKey('re-entry lockout (exited 12m ago)'), 're-entry-lockout')
eq('capacity: momentum one per day', capacityKey('momentum: one entry per market per day'), 'momentum-one-per-day')
// Live counts must NOT reach the ledger key, or the cap's record shatters into one bucket per underlying.
eq('capacity: underlying full normalises away the ticker', capacityKey('underlying KXBTC full (4/4)'), 'underlying-full')
eq('capacity: a different underlying shares the bucket', capacityKey('underlying KXETH full (4/4)'), 'underlying-full')
eq('capacity: long-horizon normalises away the count', capacityKey('long-horizon slots full (4/4)'), 'long-horizon')
// Global safety states block everything indiscriminately - their counterfactual says nothing about a cap.
eq('capacity: stop-entry is not a capacity veto', capacityKey('stop-entry engaged (exits still managed)'), undefined)
eq('capacity: paused exchange is not', capacityKey('exchange trading paused'), undefined)
eq('capacity: stale ledger is not', capacityKey('venue ledger stale - entries held until the settlement feed refreshes'), undefined)
eq('capacity: awaiting reconcile is not', capacityKey('awaiting venue reconcile'), undefined)
eq('capacity: an unfunded shard is not', capacityKey('shard 2 unfunded ($0.00) - allocate collateral to it on Kalshi'), undefined)
eq('capacity: insufficient balance is not', capacityKey('insufficient balance'), undefined)
// Dedup reasons mean we HAVE the position - there is nothing to counterfactual.
eq('capacity: market already open is not', capacityKey('market already open'), undefined)
eq('capacity: order already resting is not', capacityKey('order already resting'), undefined)

}

/**
 * Polymarket smart-money consensus arm (build-queue item 13, pre-registered
 * 2026-09-13 in docs/PREREGISTERED-polymarket-consensus.md). Every gate below
 * is a line of that document; if one of these tests is changed the document
 * has to be changed first, which is the point of writing it before the arm.
 */
function consensusTests(): void {
  const R = CONSENSUS_RULE
  const ok = { market: 'KXX-Y', ask: 0.69, polyPrice: 0.66, ageHours: 3, hoursToClose: 30 }
  eq('consensus: a fresh, matched, mid-priced signal is taken', consensusRefusal(ok), null)
  eq('consensus: no Kalshi market matched', consensusRefusal({ ...ok, market: null }), 'no-match')
  // Round 96: the horizon ceiling. A 202-day NCAA market took a slot on day 0 and could never settle
  // inside the test; the rule now refuses anything beyond maxHoursToClose (21 days) and takes the boundary.
  eq('consensus: beyond the horizon ceiling is refused', consensusRefusal({ ...ok, hoursToClose: R.maxHoursToClose + 1 }), 'too-far')
  eq('consensus: the ceiling itself is taken', consensusRefusal({ ...ok, hoursToClose: R.maxHoursToClose }), null)
  eq('consensus: the ceiling is 21 days', R.maxHoursToClose, 504)
  eq('consensus: too-close still wins below the floor', consensusRefusal({ ...ok, hoursToClose: 5 }), 'too-close')
  // Round 96: reserved long-horizon slots. Other arms keep the shared cap; consensus gets the extra on top.
  eq('long-horizon cap: other arms see the shared cap', longHorizonCapFor('fade', { maxLongHorizonPositions: 4, consensusExtraLongSlots: 2 }), 4)
  eq('long-horizon cap: consensus gets the reserved extra', longHorizonCapFor('consensus', { maxLongHorizonPositions: 4, consensusExtraLongSlots: 2 }), 6)
  eq('long-horizon cap: extra defaults to 2', longHorizonCapFor('consensus', { maxLongHorizonPositions: 4 }), 6)
  eq('long-horizon cap: extra clamps to 4', longHorizonCapFor('consensus', { maxLongHorizonPositions: 4, consensusExtraLongSlots: 9 }), 8)
  eq('long-horizon cap: extra cannot go negative', longHorizonCapFor('consensus', { maxLongHorizonPositions: 4, consensusExtraLongSlots: -3 }), 4)
  eq('long-horizon cap: zero base means zero for other arms even with extra', longHorizonCapFor('volume-spike', { maxLongHorizonPositions: 0, consensusExtraLongSlots: 2 }), 0)
  // Round 97: consensus holds to settlement, as pre-registered. On 2026-09-14 the arm was missing from the
  // hold list, so the default take-profit / stop-loss sold nine of its positions minutes after entry.
  eq('hold-to-settle: consensus holds', holdsToSettlement('consensus', { fadeExitEnabled: false }), true)
  eq('hold-to-settle: every arm that held before still holds', ['dutch', 'settlement', 'momentum', 'mean-reversion', 'weather-morning'].every((s) => holdsToSettlement(s, {})), true)
  eq('hold-to-settle: fade holds unless its exits are enabled', [holdsToSettlement('fade', {}), holdsToSettlement('fade', { fadeExitEnabled: true })], [true, false])
  eq('hold-to-settle: the TP/SL arms still exit', ['volume-spike', 'sports-anchor', 'news', 'convergence'].some((s) => holdsToSettlement(s, {})), false)
  eq('consensus: the event matched but not a market', consensusRefusal({ ...ok, market: '' }), 'no-match')
  eq('consensus: no live ask to pay', consensusRefusal({ ...ok, ask: undefined }), 'no-ask')
  eq('consensus: a null ask is not a zero ask', consensusRefusal({ ...ok, ask: null }), 'no-ask')
  eq('consensus: NaN is not an ask', consensusRefusal({ ...ok, ask: Number.NaN }), 'no-ask')
  // Freshness: the graded edge is a lead-time effect, so 24 h is the boundary and it is inclusive.
  eq('consensus: 24 h old is still fresh', consensusRefusal({ ...ok, ageHours: R.maxSignalAgeHours }), null)
  eq('consensus: older than 24 h is stale', consensusRefusal({ ...ok, ageHours: R.maxSignalAgeHours + 0.01 }), 'stale-signal')
  // Horizon: 6 h is the floor and it is inclusive.
  eq('consensus: exactly 6 h to close is allowed', consensusRefusal({ ...ok, hoursToClose: R.minHoursToClose }), null)
  eq('consensus: under 6 h to close is refused', consensusRefusal({ ...ok, hoursToClose: R.minHoursToClose - 0.01 }), 'too-close')
  eq('consensus: a closed market is refused, never traded at hours 0', consensusRefusal({ ...ok, hoursToClose: 0 }), 'too-close')
  // Price band: refuse ABOVE 0.90 and BELOW 0.10, so both ends are themselves allowed.
  eq('consensus: 0.90 is allowed', consensusRefusal({ ...ok, ask: 0.9, polyPrice: 0.9 }), null)
  eq('consensus: above 0.90 is refused', consensusRefusal({ ...ok, ask: 0.91, polyPrice: 0.91 }), 'price-high')
  eq('consensus: 0.10 is allowed', consensusRefusal({ ...ok, ask: 0.1, polyPrice: 0.1 }), null)
  eq('consensus: below 0.10 is refused', consensusRefusal({ ...ok, ask: 0.09, polyPrice: 0.09 }), 'price-low')
  // Drift is SIGNED. Kalshi having run past the Polymarket price is the case the
  // pre-registration refuses; Kalshi being cheaper than the wallets paid is not.
  eq('consensus: exactly 10c of run-up is allowed', consensusRefusal({ ...ok, ask: 0.7, polyPrice: 0.6 }), null)
  eq('consensus: more than 10c of run-up is refused', consensusRefusal({ ...ok, ask: 0.705, polyPrice: 0.6 }), 'drifted')
  eq('consensus: Kalshi far CHEAPER than Polymarket is not drift', consensusRefusal({ ...ok, ask: 0.4, polyPrice: 0.8 }), null)
  eq('consensus: a signal with no Polymarket price skips the drift gate only', consensusRefusal({ ...ok, polyPrice: null }), null)
  // The order of gates matters for the refusal counters: an unmatched signal must
  // not be reported as a price refusal.
  eq('consensus: no-match wins over every later gate', consensusRefusal({ market: null, ask: 0.99, polyPrice: 0.1, ageHours: 999, hoursToClose: 0 }), 'no-match')

  const cnow = Date.parse('2026-09-14T12:00:00Z')
  const sig = (o: Record<string, unknown>): string =>
    JSON.stringify({ ts: '2026-09-14T09:00:00+00:00', conditionId: '0xaa', title: 't', outcome: 'Yes', n_wallets: 4, poly_price: 0.6, kalshi: { market: 'KXA-Y', yes_ask: 0.62 }, ...o })
  eq('consensus parse: a good row survives', parseConsensusSignals(sig({}), cnow).length, 1)
  eq('consensus parse: a torn last line is skipped, not thrown', parseConsensusSignals(sig({}) + '\n{"ts":"2026-09', cnow).length, 1)
  eq('consensus parse: blank lines are skipped', parseConsensusSignals('\n' + sig({}) + '\n\n', cnow).length, 1)
  eq('consensus parse: an event-only match is dropped', parseConsensusSignals(sig({ kalshi: { market: null, yes_ask: 0.6 } }), cnow).length, 0)
  eq('consensus parse: a missing kalshi block is dropped', parseConsensusSignals(sig({ kalshi: null }), cnow).length, 0)
  eq('consensus parse: a match with no ask is dropped', parseConsensusSignals(sig({ kalshi: { market: 'KXA-Y', yes_ask: null } }), cnow).length, 0)
  eq('consensus parse: an unparseable ts is dropped', parseConsensusSignals(sig({ ts: 'never' }), cnow).length, 0)
  eq('consensus parse: a signal older than the window is dropped', parseConsensusSignals(sig({ ts: '2026-09-13T11:00:00+00:00' }), cnow).length, 0)
  // The shadow's `seen` state has been reset before, so the same market can appear
  // twice. The NEWEST row must win: the older one carries a stale ask and a stale
  // Polymarket price, and the drift gate is computed against that price.
  const dup = sig({ ts: '2026-09-14T08:00:00+00:00', poly_price: 0.5 }) + '\n' + sig({ ts: '2026-09-14T10:00:00+00:00', poly_price: 0.7 })
  eq('consensus parse: one row per Kalshi market', parseConsensusSignals(dup, cnow).length, 1)
  eq('consensus parse: and it is the newest one', parseConsensusSignals(dup, cnow)[0]?.poly_price, 0.7)
  const two = sig({ ts: '2026-09-14T08:00:00+00:00' }) + '\n' + sig({ ts: '2026-09-14T10:00:00+00:00', kalshi: { market: 'KXB-Y', yes_ask: 0.3 } })
  eq('consensus parse: newest market first', parseConsensusSignals(two, cnow).map((r) => r.kalshi?.market), ['KXB-Y', 'KXA-Y'])

  eq('consensus age: hours since the signal', consensusAgeHours({ ts: '2026-09-14T09:00:00+00:00' } as never, cnow), 3)
  eq('consensus age: an unparseable ts is infinitely old, never zero', consensusAgeHours({ ts: 'x' } as never, cnow), Number.POSITIVE_INFINITY)

  // The feed caches on mtime+size. A cache that never re-checked freshness would
  // let a signal outlive its 24 h window whenever the shadow stopped writing.
  const dir = mkdtempSync(joinPath(tmpdir(), 'consensus-'))
  const path = joinPath(dir, 'signals.jsonl')
  try {
    const missing = new ConsensusFeed(joinPath(dir, 'nope.jsonl'))
    eq('consensus feed: a missing file yields nothing', missing.read(cnow).length, 0)
    eq('consensus feed: and says so rather than reporting a clean zero', (missing.error() ?? '').startsWith('signals file unreadable'), true)
    writeFileSync(path, sig({}) + '\n')
    const feed = new ConsensusFeed(path)
    eq('consensus feed: reads the file', feed.read(cnow).length, 1)
    eq('consensus feed: a good read clears the error', feed.error(), undefined)
    // Same file, 25 h later: the cache must re-filter, not re-serve.
    eq('consensus feed: the cache re-filters for freshness', feed.read(cnow + 25 * 3600_000).length, 0)
    // Appending changes the size, so the next read re-parses even inside one mtime tick.
    writeFileSync(path, sig({}) + '\n' + sig({ kalshi: { market: 'KXB-Y', yes_ask: 0.4 } }) + '\n')
    eq('consensus feed: a grown file is re-read', feed.read(cnow).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // The arm is on the ladder like every other, at micro size through GENERIC_STRATEGIES.
  const spec = GENERIC_STRATEGIES.find((g) => g.id === 'kalshi-consensus')
  eq('consensus ladder: the arm is registered', spec !== undefined, true)
  eq('consensus ladder: Kalshi, its own perf key, its own flag', [spec?.venue, spec?.key, spec?.flag], ['kalshi', 'consensus', 'consensusEnabled'])
  // Sized in dollars, not contracts: a `contracts` arm bypasses the stake multiplier.
  eq('consensus ladder: sized by the stake multiplier', spec?.contracts, undefined)
}

// ---- the daily report must be able to SEE the kill switch (2026-09-15) ----
// trade-quality.mjs read `state.daily.tripped`. The trip lives on `state.dailyPnl`;
// `state.daily` is the trade counter. The report therefore printed "kill clear" on
// 2026-09-15 while the switch had been TRIPPED since ~08:43Z and every entry was
// halted — a monitoring blindness, not a trading bug, and the daily maintenance
// run is the only reader of that line.
function killStateTests(): void {
  const T = '2026-09-15'
  // The exact shape of the bug: the counter has no `tripped` field at all.
  eq('kill: the trade counter is not the kill switch', killState({ daily: { date: T, count: 13 }, dailyPnl: { date: T, realized: -1.12, tripped: true }, venueDay: { date: T, realized: -24.18 } }, T).tripped, true)
  eq('kill: and it names the worse ledger and the figure', killState({ dailyPnl: { date: T, realized: -1.12, tripped: true }, venueDay: { date: T, realized: -24.18 } }, T).text, 'TRIPPED (venue day -24.18) — new entries halted until the next UTC day')
  // Local worse than the venue: the local ledger governs and is reported.
  eq('kill: the local ledger governs when it is worse', killState({ dailyPnl: { date: T, realized: -30, tripped: true }, venueDay: { date: T, realized: -2 } }, T).text, 'TRIPPED (local day -30.00) — new entries halted until the next UTC day')
  // A stale venueDay must not be quoted as today's reason.
  eq('kill: yesterday\'s venue row is not today\'s reason', killState({ dailyPnl: { date: T, realized: -9, tripped: true }, venueDay: { date: '2026-09-14', realized: -99 } }, T).text, 'TRIPPED (local day -9.00) — new entries halted until the next UTC day')
  // The trip is scoped to its own UTC day; the app clears it on the roll.
  eq('kill: a trip dated yesterday reads clear', killState({ dailyPnl: { date: '2026-09-14', realized: -24, tripped: true } }, T), { tripped: false, text: 'clear' })
  eq('kill: an untripped day reads clear', killState({ dailyPnl: { date: T, realized: -1.12, tripped: false } }, T), { tripped: false, text: 'clear' })
  eq('kill: a missing record reads clear and does not throw', killState({}, T), { tripped: false, text: 'clear' })
  eq('kill: no state at all reads clear', killState(undefined, T), { tripped: false, text: 'clear' })
}

// ---- a broken LAN resolver must not silently stop a shadow (2026-09-17) ----
// The router answered NXDOMAIN for api.open-meteo.com only; every station fetch threw
// inside hrrr-shadow's per-station try, the task still exited 0, and three hours of
// forecasts were lost with nothing in the log. The fallback is deliberately narrow:
// a DNS failure retries through a public resolver, anything else keeps its own error.
function dnsFallbackTests(): void {
  // fetch() wraps the cause; node:https throws the code bare. Both are the same failure.
  eq('dns: fetch wraps ENOTFOUND in cause', isDnsFailure({ cause: { code: 'ENOTFOUND' } }), true)
  eq('dns: a bare EAI_AGAIN is a DNS failure too', isDnsFailure({ code: 'EAI_AGAIN' }), true)
  // The point of the guard: a refused connection or a bad certificate is NOT a name
  // failure, and retrying it against another resolver would hide a real fault.
  eq('dns: a refused connection is not a name failure', isDnsFailure({ cause: { code: 'ECONNREFUSED' } }), false)
  eq('dns: a TLS error is not a name failure', isDnsFailure({ code: 'CERT_HAS_EXPIRED' }), false)
  eq('dns: an undefined error does not throw', isDnsFailure(undefined), false)

  // The lookup has to speak net.connect's callback protocol, or https never connects.
  const servers: string[] = []
  const answers = new Map<string, string[]>([['api.open-meteo.com', ['188.40.99.226', '188.40.99.227']]])
  const stub = {
    setServers: (list: string[]) => servers.push(...list),
    resolve4: (host: string, cb: (e: Error | null, a?: string[]) => void) => {
      if (host === 'nx.invalid') return cb(new Error('queryA ENOTFOUND nx.invalid'))
      cb(null, answers.get(host) ?? [])
    }
  }
  const lookup = makeResolverLookup(PUBLIC_RESOLVERS, stub as unknown as import('node:dns').Resolver)
  eq('dns: the public resolvers are installed on the resolver, not on the process', servers, ['1.1.1.1', '8.8.8.8'])

  let single: unknown[] = []
  lookup('api.open-meteo.com', {}, (e: Error | null, address?: string, family?: number) => { single = [e, address, family] })
  eq('dns: a single-address lookup answers (err, address, family)', single, [null, '188.40.99.226', 4])

  let all: unknown = null
  lookup('api.open-meteo.com', { all: true }, (e: Error | null, addrs?: unknown) => { all = e ?? addrs })
  eq('dns: all:true answers the array shape node expects', all, [{ address: '188.40.99.226', family: 4 }, { address: '188.40.99.227', family: 4 }])

  // options may be omitted entirely — then the second argument IS the callback.
  let positional: unknown[] = []
  lookup('api.open-meteo.com', (e: Error | null, address?: string, family?: number) => { positional = [e, address, family] })
  eq('dns: the callback may arrive in the options position', positional, [null, '188.40.99.226', 4])

  // An empty answer is a failure, not an undefined address handed to net.connect.
  let empty = ''
  lookup('unknown.example', {}, (e: Error | null) => { empty = e ? e.message : 'no error' })
  eq('dns: an empty answer names the host and the servers', empty, 'no A record for unknown.example at 1.1.1.1, 8.8.8.8')

  let failed = ''
  lookup('nx.invalid', {}, (e: Error | null) => { failed = e ? e.message : 'no error' })
  eq('dns: a resolver error propagates unchanged', failed, 'queryA ENOTFOUND nx.invalid')
}

// ---- the cross-venue arm could not see the universe (2026-09-17, backlog 123) ----
// Enabled and "tiny-live" since 2026-09-06 with ONE signal lifetime: it compared
// `markets.slice(0, 12)` — the same head of the list every scan — to Polymarket, so
// a dislocation on the 13th market onward was unobservable. The budget is the same
// twelve Gamma searches; the window now rotates and only searchable markets spend it.
function crossVenueBatchTests(): void {
  const all = Array.from({ length: 40 }, (_, i) => `m${i}`)
  const yes = (): boolean => true
  // The rotation is tested at the old cap of twelve so the assertions below do not
  // move every time the shipped budget is retuned for cadence; the shipped value is
  // checked separately, because a zero or negative budget would silence the arm again.
  const BUDGET = 12
  eq('cross-venue: the shipped budget is positive and small', CROSS_VENUE_SEARCH_BUDGET > 0 && CROSS_VENUE_SEARCH_BUDGET <= 12, true)

  // The old behaviour, stated as the thing that must NOT happen any more.
  const first = crossVenueBatch(all, 0, BUDGET, yes)
  const second = crossVenueBatch(all, first.cursor, BUDGET, yes)
  eq('cross-venue: the first scan takes the head', first.batch, all.slice(0, 12))
  eq('cross-venue: the second scan does NOT repeat it', second.batch, all.slice(12, 24))

  // Four scans of twelve cover all forty, each market exactly once.
  let cursor = 0
  const seen: string[] = []
  for (let scan = 0; scan < 4; scan++) {
    const r = crossVenueBatch(all, cursor, BUDGET, yes)
    cursor = r.cursor
    seen.push(...r.batch)
  }
  // 4 x 12 = 48 visits over 40 markets: every market is reached, and the fourth
  // scan wraps past the end rather than stopping there.
  eq('cross-venue: four scans reach every market in the universe', [new Set(seen).size, seen.length], [40, 48])
  eq('cross-venue: the window keeps advancing across the wrap', crossVenueBatch(all, cursor, 3, yes).batch, ['m8', 'm9', 'm10'])

  // The budget is SEARCHES, not markets looked at: unsearchable rows are free.
  const mixed = ['skip', 'skip', 'take1', 'skip', 'take2', 'take3']
  const only = crossVenueBatch(mixed, 0, 2, (m) => m !== 'skip')
  eq('cross-venue: skipped markets do not spend the search budget', only.batch, ['take1', 'take2'])
  eq('cross-venue: the skipped ones are counted, not hidden', only.skipped, 3)
  eq('cross-venue: the cursor resumes after everything examined', only.cursor, 5)

  // A universe with nothing searchable must terminate and move on, not spin.
  const none = crossVenueBatch(mixed, 0, 4, () => false)
  eq('cross-venue: an all-unsearchable universe yields nothing and wraps once', [none.batch.length, none.skipped, none.cursor], [0, 6, 0])

  // Degenerate inputs the scan can really hand it.
  eq('cross-venue: an empty universe is not an error', crossVenueBatch([], 7, 12, yes), { batch: [], start: 0, cursor: 0, skipped: 0 })
  eq('cross-venue: a zero budget searches nothing', crossVenueBatch(all, 0, 0, yes), { batch: [], start: 0, cursor: 0, skipped: 0 })
  eq('cross-venue: a cursor past the end is normalised, never out of range', crossVenueBatch(all, 97, 2, yes).batch, ['m17', 'm18'])
  eq('cross-venue: a negative cursor is normalised too', crossVenueBatch(all, -3, 2, yes).batch, ['m37', 'm38'])
  eq('cross-venue: a budget wider than the universe takes each market once', crossVenueBatch(['a', 'b'], 1, 12, yes).batch, ['b', 'a'])
}

/**
 * cull-gate's settle cache (2026-09-19). The weekly run graded 41k culled markets one HTTP request at a
 * time and was killed by the task's own 2 h limit at 97%, below the single cache write at the bottom of the
 * loop - so no run ever produced a verdict and every run started from zero. The read is now batched and the
 * cache is written per chunk; these are the rules that decide what goes in it.
 */
function cullCacheTests(): void {
  const now = Date.UTC(2026, 8, 19, 12, 0, 0)
  eq('cull-cache: an unseen ticker needs a request', needsSettleFetch(undefined, now), true)
  eq('cull-cache: a settled result is never re-fetched', needsSettleFetch('yes', now), false)
  eq('cull-cache: a fresh blank rests for 24 h', needsSettleFetch({ blankAt: now - 3600_000 }, now), false)
  eq('cull-cache: a blank older than 24 h is re-checked', needsSettleFetch({ blankAt: now - 25 * 3600_000 }, now), true)

  eq('cull-cache: a finalized YES caches the result', settledCacheEntry({ status: 'finalized', result: 'yes' }, now), 'yes')
  eq('cull-cache: a settled NO caches the result', settledCacheEntry({ status: 'settled', result: 'no' }, now), 'no')
  // The open case is the one that matters: caching "no answer" would freeze the row out of every later run.
  eq('cull-cache: an open market caches nothing', settledCacheEntry({ status: 'active', result: '' }, now), undefined)
  eq('cull-cache: a settled market with no result parks as a blank', settledCacheEntry({ status: 'settled', result: '' }, now), { blankAt: now })
  eq('cull-cache: a row with no status caches nothing', settledCacheEntry({}, now), undefined)
  eq('cull-cache: a missing row is not an error', settledCacheEntry(undefined, now), undefined)
}
