/**
 * Promotion-ladder and nightly-review decision tests (pure functions).
 * Run: npm run test:ladder
 */
import { clusterT, clusteredMean, CONFIDENCE_Z, COOLDOWN_MS, LONG_COOLDOWN_MS, cooldownAfter, dayClusteredSe, decideConvergence, decideQuoter, decideSettlement, decideStage, isPromotion, meanCi, QUOTER_GATE, tradeSmallEntry } from '../../src/main/ladder/ladder'
import { planParameterChanges, REVIEW_FREE_MODELS, REVIEW_GEMINI, reviewModelPlans } from '../../src/main/intelligence/nightlyReview'
import type { AutoTraderConfig, MiniAutoConfig } from '../../src/shared/ipc'

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

// ---- quoter entry ----
eq('quoter stays shadow without gate', decideQuoter('shadow', null), null)
eq('quoter stays shadow below sample', decideQuoter('shadow', { n: 10, events: 50, mean: 3, lo: 1 }), null)
eq('quoter stays shadow below events', decideQuoter('shadow', { n: 50, events: 10, mean: 3, lo: 1 }), null)
eq('quoter stays shadow when CI includes zero', decideQuoter('shadow', { n: 50, events: 50, mean: 1, lo: -0.5 }), null)
eq('quoter promotes on a passing gate', decideQuoter('shadow', { n: QUOTER_GATE.minFills, events: QUOTER_GATE.minEvents, mean: 2.1, lo: 0.4 })?.to, 'tiny-live')
eq('quoter blocked can promote', decideQuoter('blocked', { n: 40, events: 45, mean: 2, lo: 0.2 })?.to, 'tiny-live')
eq('quoter live stages are judged by the stage rule', decideQuoter('tiny-live', { n: 100, events: 100, mean: 5, lo: 2 }), null)

// ---- convergence entry ----
eq('convergence promotes on PASS', decideConvergence('shadow', { pass: true, events: 210, lb: 1.3 })?.to, 'tiny-live')
eq('convergence holds on FAIL', decideConvergence('shadow', { pass: false, events: 120, lb: 0.2 }), null)
eq('convergence live ignores the gate', decideConvergence('live', { pass: true, events: 210, lb: 1.3 }), null)

// ---- settlement entry ----
eq('settlement promotes on paper CI', decideSettlement('paper', { netN: 40, netCiLo: 0.2, netCents: 3 })?.to, 'tiny-live')
eq('settlement holds on small n', decideSettlement('paper', { netN: 39, netCiLo: 2, netCents: 3 }), null)
eq('settlement holds on CI', decideSettlement('paper', { netN: 80, netCiLo: -0.1, netCents: 1 }), null)

// ---- live-stage rule (net profit after fees; checkpoints every 20 trades) ----
const S = (n: number, netDollars: number, mean: number, se: number) => ({ n, netDollars, mean, se })
// A confidence STOP requires MIN_STOP_CLUSTERS day-clusters (round 79). Tests that are about some OTHER
// rule's stop have to supply that evidence; `xC` says "and this arm traded on enough separate days".
const xC = <T,>(ev: T, clusters = 6): T & { clusters: number } => ({ ...ev, clusters })
eq('stage: hard stop at -$5 x1', decideStage(S(3, -5, -1.7, 1), 1, 0).kind, 'stop')
eq('stage: stop scales with size', decideStage(S(3, -6, -2, 1), 2, 0).kind, 'hold')
eq('stage: stop at -$10 x2', decideStage(S(3, -10, -3, 1), 2, 0).kind, 'stop')
eq('stage: stop scales with the stake (3 x $5)', decideStage({ ...S(3, -12, -4, 1), stake: 5 }, 1, 0).kind, 'hold')
eq('stage: stop at three stakes', decideStage({ ...S(3, -15, -5, 1), stake: 5 }, 1, 0).kind, 'stop')
eq('stage: before the first checkpoint', decideStage(S(19, 1, 5, 1), 1, 0), { kind: 'hold', checkpoint: 0, reason: '19 settled since stage start, net $1.00; next checkpoint at 20' })
eq('stage: checkpoint win scales up', decideStage(S(20, 1, 5, 2), 1, 0).kind, 'scale-up')
eq('stage: checkpoint records itself', decideStage(S(20, 1, 5, 2), 1, 0).checkpoint, 1)
eq('stage: same checkpoint not re-judged', decideStage(S(25, -1, -3, 1), 1, 1).kind, 'hold')
eq('stage: checkpoint loss stops', decideStage(xC(S(20, -1, -3, 1)), 1, 0).kind, 'stop')
eq('stage: inconclusive keeps testing', decideStage(S(20, 0.5, 1, 2), 1, 0).kind, 'hold')
eq('stage: positive net but unproven holds', decideStage(S(40, 0.4, 0.5, 1), 1, 1).kind, 'hold')
eq('stage: 100 trades and net positive wins', decideStage(S(100, 0.4, 0.2, 1), 1, 4).kind, 'scale-up')
eq('stage: 100 trades and net zero stops', decideStage(S(100, 0, 0, 1), 1, 4).kind, 'stop')
eq('stage: max size holds on a win', decideStage(S(20, 3, 5, 1), 4, 0).kind, 'hold')
eq('stage: win needs net positive too', decideStage(S(20, -0.2, 1, 0.5), 1, 0).kind, 'hold')
// ---- trade-small entry ----
const T = Date.now()
eq('trade-small off in prove-first', tradeSmallEntry('prove-first', 'shadow', 0, 2, undefined, false, T), null)
eq('trade-small off when mode unset', tradeSmallEntry(undefined, 'shadow', 0, 2, undefined, false, T), null)
eq('trade-small promotes shadow', tradeSmallEntry('trade-small', 'shadow', 0, 2, undefined, false, T)?.to, 'tiny-live')
eq('trade-small promotes paper', tradeSmallEntry('trade-small', 'paper', 0, 2, undefined, false, T)?.to, 'tiny-live')
eq('trade-small promotes blocked', tradeSmallEntry('trade-small', 'blocked', 1, 2, undefined, false, T)?.reason, 'trade-small mode: real-money micro test 2 (stop -$5)')
eq('trade-small re-enters a disabled micro-maker as live', tradeSmallEntry('trade-small', 'disabled', 0, 2, undefined, false, T, 'live')?.to, 'live')
eq('trade-small never touches tiny-live', tradeSmallEntry('trade-small', 'tiny-live', 0, 2, undefined, false, T), null)
eq('trade-small never touches live', tradeSmallEntry('trade-small', 'live', 0, 2, undefined, false, T), null)
eq('trade-small has no hard cap (the cool-down governs)', tradeSmallEntry('trade-small', 'shadow', 2, 2, undefined, false, T)?.to, 'tiny-live')
eq('cool-down: 3 days before the cap', cooldownAfter(1, 2), COOLDOWN_MS)
eq('cool-down: 14 days at the cap', cooldownAfter(2, 2), LONG_COOLDOWN_MS)
eq('cool-down: doubles per stop', cooldownAfter(3, 2), 2 * LONG_COOLDOWN_MS)
eq('cool-down: caps at 56 days', cooldownAfter(9, 2), 4 * LONG_COOLDOWN_MS)
eq('trade-small respects cool-down', tradeSmallEntry('trade-small', 'shadow', 1, 2, T + 1000, false, T), null)
eq('trade-small after cool-down', tradeSmallEntry('trade-small', 'shadow', 1, 2, T - 1000, false, T)?.to, 'tiny-live')
eq('trade-small respects operator hold', tradeSmallEntry('trade-small', 'shadow', 0, 2, undefined, true, T), null)

// ---- clustered statistics ----
const indep = clusteredMean([1, 2, 3, 4].map((v, i) => ({ v, g: `g${i}` })))
eq('clustered: one per group is the ordinary mean', indep.mean, 2.5)
// With the G/(G-1) finite-cluster correction (round 73) this is now EXACTLY the ordinary SAMPLE SE,
// sqrt(5/3/4) - the old estimator matched the population SE, sqrt(5/4)/... , which understates.
eq('clustered: one per group IS the ordinary sample SE', Math.abs(indep.se - Math.sqrt(5 / 3 / 4)) < 1e-9, true)
const corr = clusteredMean([{ v: 5, g: 'a' }, { v: 5, g: 'a' }, { v: 5, g: 'a' }, { v: -5, g: 'b' }, { v: -5, g: 'b' }, { v: -5, g: 'b' }])
const naive = meanCi([5, 5, 5, -5, -5, -5])
eq('clustered: correlated groups widen the SE', corr.se > naive.se, true)
eq('clustered: groups counted', corr.groups, 2)
const oneDay = clusteredMean(Array.from({ length: 20 }, (_, i) => ({ v: i % 2 === 0 ? -5 : -1, g: 'd1' })))
eq('clustered: a single cluster still has a positive SE', oneDay.se > 0.3, true)
eq('clustered: a single cluster keeps its mean', oneDay.mean, -3)

// The trader-ledger path (per-day buckets + sum of squares) needs the same
// floor: momentum's 20 trades landed in one day bucket and the raw clustered
// SE of 0 made an 80% band of width zero, which stopped it on no evidence.
const oneBucket = [{ n: 20, sum: -58.52 }]
const meanOne = -58.52 / 20
const sqOne = 20 * meanOne * meanOne + 19 * 4 // per-trade variance 4
eq('day-clustered: one bucket is floored above zero', dayClusteredSe(oneBucket, 20, meanOne, sqOne) > 0.4, true)
eq('day-clustered: raw clustered SE of one bucket is zero', Math.abs(-58.52 - 20 * meanOne) < 1e-9, true)
const threeBuckets = [{ n: 10, sum: 50 }, { n: 10, sum: -50 }, { n: 10, sum: 0 }]
eq('day-clustered: three buckets use the clustered SE', dayClusteredSe(threeBuckets, 30, 0, 30 * 4) > 2, true)
eq('day-clustered: buckets that do not account for every trade fall back to the plain SE', dayClusteredSe([{ n: 5, sum: 0 }], 20, 0, 20 * 4), Math.sqrt((20 * 4) / 19 / 20))
eq('day-clustered: a single trade has no SE', dayClusteredSe([{ n: 1, sum: -3 }], 1, -3, 9), 0)

// ---- nightly review model chain ----
const plansAll = reviewModelPlans({ llmBaseUrl: 'https://api.deepseek.com/v1', llmApiKey: 'k', llmModel: 'deepseek-v4-pro' }, 'router')
eq('review plans: router paid, then Gemini, then the app endpoint, then free', plansAll.map((p) => p.model), ['openai/gpt-5.6-sol', 'deepseek/deepseek-v4-pro', 'z-ai/glm-5.3', ...REVIEW_GEMINI.models, 'deepseek-v4-pro', ...REVIEW_FREE_MODELS])
// Assert that a key is PRESENT, never what it is: this ran with a real GEMINI_API_KEY in the environment and
// an `eq` on the value printed the secret into the test output on failure.
eq('review plans: Gemini carries a key and asks for JSON', [plansAll[3].base, plansAll[3].key.length > 0, plansAll[3].json], [REVIEW_GEMINI.base, true, true])
// Found by model, not by index: the chain length moves whenever a provider's model list changes, and an
// index-based assertion silently starts checking a different entry instead of failing honestly.
const appPlan = plansAll.find((p) => p.model === 'deepseek-v4-pro' && !/openrouter/.test(p.base))
eq('review plans: the app endpoint keeps its own base and key', [appPlan?.base, appPlan?.key === 'k'], ['https://api.deepseek.com/v1', true])
const plansDirect = reviewModelPlans({ llmBaseUrl: 'http://localhost:11434/v1', llmApiKey: '', llmModel: 'qwen3' }, '')
eq('review plans: no router key and a local endpoint', plansDirect.map((p) => p.model), [...REVIEW_GEMINI.models, 'qwen3'])
const plansPaid = reviewModelPlans({ llmBaseUrl: 'https://api.deepseek.com/v1', llmApiKey: 'k', llmModel: 'deepseek-v4-pro' }, '')
eq('review plans: no router key and a paid endpoint puts that endpoint first', plansPaid.map((p) => p.model), ['deepseek-v4-pro', ...REVIEW_GEMINI.models])
eq('review plans: nothing configured still has Gemini', reviewModelPlans({ llmBaseUrl: 'https://api.deepseek.com/v1', llmApiKey: '', llmModel: 'x' }, '').map((p) => p.model), REVIEW_GEMINI.models)

// ---- helpers ----
eq('promotion ranking', [isPromotion('shadow', 'tiny-live'), isPromotion('tiny-live', 'shadow'), isPromotion('blocked', 'tiny-live'), isPromotion('live', 'disabled')], [true, false, true, false])
const ci = meanCi([1, 2, 3, 4])
eq('meanCi mean', ci.mean, 2.5)
eq('meanCi n', ci.n, 4)

// ---- nightly review parameter plan ----
const kalshi = { quoterEnabled: false, quoterMaxSpreadCents: 20, quoterGuardF: 2, convergenceLiveEnabled: true, convergenceMaxDailyTrades: 3, fadeEnabled: false, fadeMinEdgeCents: 1.5, maxLlmPerScan: 12 } as unknown as AutoTraderConfig
const poly = { microMakerEnabled: true, microMakerMinSpreadCents: 1 } as unknown as MiniAutoConfig
const plan = planParameterChanges(
  [
    { target: 'kalshi', key: 'quoterMaxSpreadCents', value: 15 },
    { target: 'kalshi', key: 'quoterGuardF', value: 9 },
    { target: 'kalshi', key: 'convergenceMaxDailyTrades', value: 2 },
    { target: 'kalshi', key: 'liveArmed', value: 1 },
    { target: 'kalshi', key: 'maxLlmPerScan', value: 12 },
    { target: 'polymarket-us', key: 'microMakerMinSpreadCents', value: 2 },
    { target: 'manifold', key: 'fadeMinLiquidity', value: 200 }
  ],
  kalshi,
  { 'polymarket-us': poly },
  true
)
eq('review applies in-bounds non-live', plan.apply.map((a) => [a.key, a.to]), [['quoterMaxSpreadCents', 15]])
eq('review skips out of bounds', plan.skipped.find((s) => s.key === 'quoterGuardF')?.reason, 'outside bounds [1, 4]')
eq('review skips live strategy', plan.skipped.find((s) => s.key === 'convergenceMaxDailyTrades')?.reason, 'strategy is live; recorded for the operator')
eq('review never touches arms', plan.skipped.find((s) => s.key === 'liveArmed')?.reason, 'not in the allow-list')
eq('review skips unchanged', plan.skipped.find((s) => s.key === 'maxLlmPerScan')?.reason, 'unchanged')
eq('review skips live mini', plan.skipped.find((s) => s.key === 'microMakerMinSpreadCents')?.reason, 'strategy is live; recorded for the operator')
eq('review skips manifold', plan.skipped.find((s) => s.key === 'fadeMinLiquidity')?.reason, 'target not eligible')
eq('review respects auto-apply off', planParameterChanges([{ target: 'kalshi', key: 'quoterMaxSpreadCents', value: 15 }], kalshi, {}, false).apply.length, 0)
eq('review applies to live strategies when allowed', planParameterChanges([{ target: 'kalshi', key: 'convergenceMaxDailyTrades', value: 2 }], kalshi, {}, true, true).apply.map((a) => [a.key, a.to]), [['convergenceMaxDailyTrades', 2]])

// ---- one-sided samples cannot justify a scale-up (2026-09-09: fade promoted on 19W/0 settlement losses) ----
// The real checkpoint: 20 trades, net $2.65, mean 5.23c/contract, se 0.589 -> band 4.73..5.72. The sample
// was 19 settlement wins, one -$0.01 scratch, and no loss at all; sd 3.1c is the spread of (1 - entry)
// across the WINNERS, not the outcome dispersion.
const SD = (n: number, netDollars: number, mean: number, se: number, sd: number) => ({ n, netDollars, mean, se, sd })
eq('stage: one-sided winning sample holds instead of scaling', decideStage(SD(20, 2.65, 5.23, 0.589, 3.1), 1, 0).kind, 'hold')
eq('stage: and says why', /downside is unsampled/.test(decideStage(SD(20, 2.65, 5.23, 0.589, 3.1), 1, 0).reason), true)
// Deferral, not judgement: the checkpoint stays unjudged so the next run re-tries it the moment a loss lands.
eq('stage: the checkpoint stays unjudged', decideStage(SD(20, 2.65, 5.23, 0.589, 3.1), 1, 0).checkpoint, 0)
eq('stage: and it is retried on the following run', decideStage(SD(21, 2.65, 5.23, 0.589, 3.1), 1, 0).kind, 'hold')
eq('stage: a loss at trade 25 unblocks it without waiting for 40', decideStage(SD(25, 2.65, 3.0, 0.589, 8), 1, 0).kind, 'scale-up')
eq('stage: dispersion above the mean scales up normally', decideStage(SD(20, 2.65, 5.23, 0.589, 6), 1, 0).kind, 'scale-up')
eq('stage: sd exactly at the mean is two-sided enough', decideStage(SD(20, 2.65, 5.23, 0.589, 5.23), 1, 0).kind, 'scale-up')
eq('stage: no sd reported leaves the old behaviour', decideStage(S(20, 1, 5, 2), 1, 0).kind, 'scale-up')
eq('stage: past the thorough review the guard lifts', decideStage(SD(100, 2.65, 5.23, 0.589, 3.1), 1, 0).kind, 'scale-up')
// Asymmetric by design: a one-sided sample must still be allowed to stop and to hard-stop.
eq('stage: one-sided losing sample still stops', decideStage(xC(SD(20, -3.72, -1.8, 0.218, 0.5)), 1, 0).kind, 'stop')
eq('stage: the hard stop ignores the guard', decideStage(SD(3, -5, -1.7, 1, 0.1), 1, 0).kind, 'stop')
// The volume-spike checkpoint the same evening: 12W/14L, sd 7.68c, genuinely two-sided and genuinely losing.
eq('stage: volume-spike checkpoint still stops', decideStage(xC(SD(23, -3.72, -1.8, 0.218, 7.68)), 1, 0).kind, 'stop')
// ---- a confidence stop needs four day-clusters (round 79) ----
// 2026-09-07: momentum's 21 fills all landed on one day, the clustered SE came out exactly zero and the
// "80% band" was -2.93..-2.93. Round 73 floored the SE so it can no longer be zero-width; this guard covers
// the rest of the shape, where one bad day draws a narrow band and reads as proof.
eq('clusters: a losing band on one cluster does not stop', decideStage({ ...SD(21, -0.62, -2.93, 0.31, 4), clusters: 1 }, 1, 0).kind, 'hold')
eq('clusters: two is still not enough', decideStage({ ...SD(21, -0.62, -2.93, 0.31, 4), clusters: 2 }, 1, 0).kind, 'hold')
eq('clusters: three is still not enough', decideStage({ ...SD(21, -0.62, -2.93, 0.31, 4), clusters: 3 }, 1, 0).kind, 'hold')
eq('clusters: four lets the stop through', decideStage({ ...SD(21, -0.62, -2.93, 0.31, 4), clusters: 4 }, 1, 0).kind, 'stop')
// Unverifiable cluster accounting falls back to the PLAIN se, which treats correlated same-day fills as
// independent - the direction that stops too readily. Undefined must fail the guard, not bypass it.
eq('clusters: undefined does not stop either', decideStage(SD(21, -0.62, -2.93, 0.31, 4), 1, 0).kind, 'hold')
// A deferral, not a judgement: the checkpoint stays unjudged so the next run re-tries it the moment a
// fourth day lands, rather than waiting out another twenty trades.
eq('clusters: the checkpoint stays unjudged', decideStage({ ...SD(21, -0.62, -2.93, 0.31, 4), clusters: 1 }, 1, 0).checkpoint, 0)
eq('clusters: and it names the reason', /day-cluster/.test(decideStage({ ...SD(21, -0.62, -2.93, 0.31, 4), clusters: 1 }, 1, 0).reason), true)
// The guard must never become a licence to bleed: the money rules are untouched by it.
eq('clusters: the hard stop ignores the guard', decideStage({ ...SD(3, -5, -1.7, 1, 0.1), clusters: 1 }, 1, 0).kind, 'stop')
// The original assertion here used mean 0, so hi > 0 and the hi<0 branch was never entered - it passed while
// the guard was swallowing the sign rule. These are the cases that actually exercise it.
eq('clusters: the 100-trade sign rule ignores the guard (hi<0, 3 clusters)', decideStage({ ...SD(100, -3, -3, 0.5, 5), clusters: 3 }, 1, 4).kind, 'stop')
eq('clusters: the 100-trade sign rule ignores the guard (hi<0, 1 cluster)', decideStage({ ...SD(100, -3, -3, 0.5, 5), clusters: 1 }, 1, 4).kind, 'stop')
eq('clusters: the 100-trade sign rule ignores the guard (undefined clusters)', decideStage(SD(100, -3, -3, 0.5, 5), 1, 4).kind, 'stop')
eq('clusters: under 100 trades the guard still holds a 3-cluster loser', decideStage({ ...SD(60, -3, -3, 0.5, 5), clusters: 3 }, 1, 2).kind, 'hold')
// And it must not block a WIN: scaling up was never gated on clusters.
eq('clusters: one cluster still scales up a winner', decideStage({ ...SD(20, 2.65, 5.23, 0.589, 6), clusters: 1 }, 1, 0).kind, 'scale-up')

eq('clusteredMean reports the sample sd', Math.round(clusteredMean([{ v: 1, g: 'a' }, { v: 5, g: 'b' }, { v: 3, g: 'c' }]).sd * 1000) / 1000, 2)
eq('clusteredMean sd is zero on one row', clusteredMean([{ v: 4, g: 'a' }]).sd, 0)

// ---- entry quality vetoes a scale-up (2026-09-12: the fast meter the ladder never read) ----
// fade's real numbers: 5-min markout -0.60c, 80% band -0.89..-0.30 over 78 observations. Its settlement
// band is inconclusive, so nothing stopped it - but nothing should be DOUBLING it either.
const ADV = (n, mean, lo, hi) => ({ n, mean, lo, hi })
const withAdv = (ev, adverse) => ({ ...ev, adverse })
eq('adverse: a winning checkpoint is held when the markout band is wholly negative',
  decideStage(withAdv(SD(20, 2.65, 5.23, 0.589, 6), ADV(78, -0.6, -0.89, -0.3)), 1, 0).kind, 'hold')
eq('adverse: and says what it saw',
  /pays the spread to get in/.test(decideStage(withAdv(SD(20, 2.65, 5.23, 0.589, 6), ADV(78, -0.6, -0.89, -0.3)), 1, 0).reason), true)
eq('adverse: it is a deferral, so the checkpoint stays unjudged',
  decideStage(withAdv(SD(20, 2.65, 5.23, 0.589, 6), ADV(78, -0.6, -0.89, -0.3)), 1, 0).checkpoint, 0)
eq('adverse: a band straddling zero does not veto',
  decideStage(withAdv(SD(20, 2.65, 5.23, 0.589, 6), ADV(78, -0.6, -1.4, 0.2)), 1, 0).kind, 'scale-up')
eq('adverse: a positive markout does not veto',
  decideStage(withAdv(SD(20, 2.65, 5.23, 0.589, 6), ADV(78, 0.9, 0.3, 1.5)), 1, 0).kind, 'scale-up')
eq('adverse: too few observations to judge entry quality',
  decideStage(withAdv(SD(20, 2.65, 5.23, 0.589, 6), ADV(14, -2, -3, -1)), 1, 0).kind, 'scale-up')
eq('adverse: exactly at the minimum it does veto',
  decideStage(withAdv(SD(20, 2.65, 5.23, 0.589, 6), ADV(15, -2, -3, -1)), 1, 0).kind, 'hold')
eq('adverse: an arm with no markout history is unaffected',
  decideStage(SD(20, 2.65, 5.23, 0.589, 6), 1, 0).kind, 'scale-up')
eq('adverse: it also holds the 100-trade review',
  decideStage(withAdv(SD(120, 2.65, 0.2, 0.9, 6), ADV(78, -0.6, -0.89, -0.3)), 1, 0).kind, 'hold')
// It must never turn a stop into a hold: an arm that is losing still stops, adversely selected or not.
eq('adverse: a losing arm still stops',
  decideStage(xC(withAdv(SD(23, -3.72, -1.8, 0.218, 7.68), ADV(78, -0.6, -0.89, -0.3))), 1, 0).kind, 'stop')
eq('adverse: the hard stop is untouched',
  decideStage(withAdv(SD(3, -5, -1.7, 1, 0.1), ADV(78, -0.6, -0.89, -0.3)), 1, 0).kind, 'stop')

// ---- the markout band needs adequate COVERAGE before it may veto (round 72) ----
// Exits inside five minutes never get a markout and they are measurably the arm's losers (+$0.041 with,
// -$0.354 without, across 179 exits), so a thin sample runs optimistic - the direction that would let a bad
// arm past a veto built to catch it. momentum sits at 33% coverage; fade at 94%.
const ADVC = (n, mean, lo, hi, coverage) => ({ n, mean, lo, hi, coverage })
eq('coverage: a well-covered adverse band still vetoes',
  decideStage(withAdv(SD(20, 2.65, 5.23, 0.589, 6), ADVC(78, -0.6, -0.89, -0.3, 0.94)), 1, 0).kind, 'hold')
eq('coverage: a thin sample may not veto',
  decideStage(withAdv(SD(20, 2.65, 5.23, 0.589, 6), ADVC(20, -0.6, -0.89, -0.3, 0.33)), 1, 0).kind, 'scale-up')
eq('coverage: exactly at the threshold it vetoes',
  decideStage(withAdv(SD(20, 2.65, 5.23, 0.589, 6), ADVC(20, -0.6, -0.89, -0.3, 0.8)), 1, 0).kind, 'hold')
eq('coverage: just under the threshold it does not',
  decideStage(withAdv(SD(20, 2.65, 5.23, 0.589, 6), ADVC(20, -0.6, -0.89, -0.3, 0.79)), 1, 0).kind, 'scale-up')
eq('coverage: unknown coverage behaves as before',
  decideStage(withAdv(SD(20, 2.65, 5.23, 0.589, 6), ADVC(78, -0.6, -0.89, -0.3, undefined)), 1, 0).kind, 'hold')

// ---- t on G-1 degrees of freedom, not the normal limit (round 73) ----
eq('clusterT: two clusters', clusterT(1), 1.376)
eq('clusterT: three clusters', clusterT(2), 1.061)
eq('clusterT: six clusters', clusterT(5), 0.92)
eq('clusterT: it decays toward the normal quantile', clusterT(200) < 0.85 && clusterT(200) >= CONFIDENCE_Z, true)
eq('clusterT: never below the normal quantile', clusterT(100000) >= CONFIDENCE_Z, true)
eq('clusterT: degenerate df falls back to the widest', clusterT(0), 1.376)
// The same evidence must read as inconclusive at two clusters and conclusive at many.
const EV = (clusters) => ({ n: 20, netDollars: 2, mean: 1.0, se: 0.8, sd: 5, clusters })
eq('stage: two clusters cannot carry a scale-up on this evidence', decideStage(EV(2), 1, 0).kind, 'hold')
eq('stage: the same numbers over twelve clusters can', decideStage(EV(12), 1, 0).kind, 'scale-up')
eq('stage: no cluster count keeps the old normal multiplier', decideStage({ n: 20, netDollars: 2, mean: 1.0, se: 0.8, sd: 5 }, 1, 0).kind, 'scale-up')

console.log(`ladder: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
