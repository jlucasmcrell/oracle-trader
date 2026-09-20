/**
 * Nightly strategy review by the built-in LLM.
 *
 * Once a day the app assembles the evidence it has (venue-settled P&L by
 * family, each strategy's ladder stage and gate progress, the shadow meter,
 * the counterfactual veto ledger, operational errors, and a non-secret
 * config snapshot), asks the configured model for a structured review, and
 * files it under <userData>/reviews/. The model's parameter proposals are
 * applied ONLY when the parameter is in the bounded allow-list below AND the
 * strategy that owns it is not live; everything else (code proposals,
 * experiment designs, proposals on live strategies) is recorded for the
 * operator or a maintenance session to act on.
 *
 * Division of labor, deliberately: the model reasons at review time; the
 * ladder's deterministic gates decide what trades. The model never touches
 * arms, sizes, loss limits, or keys.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from '../store/json'
import { trackedModelFetch } from './modelUsage'
import { join } from 'node:path'
import type { TradingEngine } from '../engine/engine'
import type { AutoTrader } from '../strategies/autoTrader'
import type { MiniAuto } from '../strategies/miniAuto'
import type { Ladder } from '../ladder/ladder'
import type { AutoTraderConfig, MiniAutoConfig } from '../../shared/ipc'
import type { VenueId } from '../../shared/types'
import { sendAlert } from '../util/alert'
import { GEMINI, geminiKey } from './gemini'

export interface ParameterProposal {
  /** The model names the target; anything without a config is recorded as not eligible. */
  target: string
  key: string
  value: number | boolean | string
  rationale?: string
}

export interface ReviewRecord {
  at: number
  date: string
  model?: string
  summary: string
  healthFlags: string[]
  findings: { topic: string; evidence: string; severity: 'info' | 'warn' | 'high' }[]
  parameterProposals: ParameterProposal[]
  experimentProposals: { title: string; hypothesis: string; design: string; metric: string; stopRule: string }[]
  codeProposals: { title: string; whereToLook: string; rationale: string }[]
  applied: { target: string; key: string; from: unknown; to: unknown }[]
  skipped: { target: string; key: string; reason: string }[]
  error?: string
  latencyMs?: number
  /** Attempts made for this date (failed attempts retry, up to three). */
  attempts?: number
}

interface Bound {
  min: number
  max: number
  /** True when the strategy that owns this parameter is live (then the change is recorded, not applied). */
  live: (k: AutoTraderConfig, m?: MiniAutoConfig) => boolean
}

/**
 * Parameters the review may change on its own, with hard bounds. Nothing else is ever applied.
 *
 * SIZE KNOBS ARE NOT IN HERE. `quoterMaxMarkets` and `convergenceMaxDailyTrades` were, and the ladder's
 * `sizesFor` sets both - so the review was moving a live arm's size against the ladder's own decision,
 * which the handbook promises it never does (audit 2026-09-19, B-46). Removed 2026-09-20.
 */
export const PARAM_BOUNDS: Record<'kalshi' | 'polymarket-us', Record<string, Bound>> = {
  kalshi: {
    quoterMinSpreadCents: { min: 2, max: 10, live: (k) => !!k.quoterEnabled },
    quoterMaxSpreadCents: { min: 5, max: 30, live: (k) => !!k.quoterEnabled },
    quoterMaxTouchDepth: { min: 10, max: 200, live: (k) => !!k.quoterEnabled },
    quoterGuardF: { min: 1, max: 4, live: (k) => !!k.quoterEnabled },
    quoterNearF: { min: 0.5, max: 3, live: (k) => !!k.quoterEnabled },
    quoterMinHoursToClose: { min: 1, max: 12, live: (k) => !!k.quoterEnabled },
    quoterMaxHoursToClose: { min: 12, max: 72, live: (k) => !!k.quoterEnabled },
    settleMinMarginPct: { min: 1, max: 5, live: (k) => !!k.settleLiveEnabled },
    settleMaxMinutesToClose: { min: 10, max: 1440, live: (k) => !!k.settleLiveEnabled },
    fadeMinEdgeCents: { min: 1, max: 5, live: (k) => !!k.fadeEnabled },
    fadeMinHorizonMinutes: { min: 30, max: 720, live: (k) => !!k.fadeEnabled },
    maxLlmPerScan: { min: 1, max: 20, live: () => false }
  },
  'polymarket-us': {
    microMakerMinSpreadCents: { min: 1, max: 5, live: (_k, m) => !!m?.microMakerEnabled },
    microMakerMaxSpreadCents: { min: 2, max: 10, live: (_k, m) => !!m?.microMakerEnabled },
    microMakerMinSideDollars: { min: 5, max: 50, live: (_k, m) => !!m?.microMakerEnabled },
    microMakerMinMidPrice: { min: 0.1, max: 0.4, live: (_k, m) => !!m?.microMakerEnabled },
    microMakerMaxMidPrice: { min: 0.6, max: 0.9, live: (_k, m) => !!m?.microMakerEnabled },
    microMakerMinHoursToClose: { min: 0.5, max: 24, live: (_k, m) => !!m?.microMakerEnabled }
  }
}

/** Pure: which proposals get applied, which are recorded with a reason. Exported for tests. */
export function planParameterChanges(
  proposals: ParameterProposal[],
  kalshi: AutoTraderConfig,
  minis: Partial<Record<'polymarket-us', MiniAutoConfig>>,
  autoApply: boolean,
  autoApplyLive = false
): { apply: { target: 'kalshi' | 'polymarket-us'; key: string; from: unknown; to: number }[]; skipped: { target: string; key: string; reason: string }[] } {
  const apply: { target: 'kalshi' | 'polymarket-us'; key: string; from: unknown; to: number }[] = []
  const skipped: { target: string; key: string; reason: string }[] = []
  for (const p of proposals) {
    if (!autoApply) {
      skipped.push({ target: p.target, key: p.key, reason: 'auto-apply disabled' })
      continue
    }
    if (p.target !== 'kalshi' && p.target !== 'polymarket-us') {
      skipped.push({ target: p.target, key: p.key, reason: 'target not eligible' })
      continue
    }
    // A plain lookup makes `constructor`, `__proto__`, `toString`, `hasOwnProperty` and `valueOf` truthy
    // bounds with undefined min/max, which then get written onto the config as junk (audit B-47).
    const table = PARAM_BOUNDS[p.target]
    const bound = Object.prototype.hasOwnProperty.call(table, p.key) ? table[p.key] : undefined
    if (!bound) {
      skipped.push({ target: p.target, key: p.key, reason: 'not in the allow-list' })
      continue
    }
    const v = typeof p.value === 'number' ? p.value : Number(p.value)
    if (!Number.isFinite(v)) {
      skipped.push({ target: p.target, key: p.key, reason: 'not numeric' })
      continue
    }
    if (v < bound.min || v > bound.max) {
      skipped.push({ target: p.target, key: p.key, reason: `outside bounds [${bound.min}, ${bound.max}]` })
      continue
    }
    const mini = p.target === 'polymarket-us' ? minis['polymarket-us'] : undefined
    if (!autoApplyLive && bound.live(kalshi, mini)) {
      skipped.push({ target: p.target, key: p.key, reason: 'strategy is live; recorded for the operator' })
      continue
    }
    const from = p.target === 'kalshi' ? (kalshi as unknown as Record<string, unknown>)[p.key] : (mini as unknown as Record<string, unknown> | undefined)?.[p.key]
    if (from === v) {
      skipped.push({ target: p.target, key: p.key, reason: 'unchanged' })
      continue
    }
    apply.push({ target: p.target, key: p.key, from, to: v })
  }
  return { apply, skipped }
}

export interface ReviewModelPlan {
  base: string
  key: string
  model: string
  /** Ask for JSON mode (every listed endpoint honours it; the free tier is checked against OpenRouter's supported_parameters). */
  json: boolean
}
/** OpenRouter's free tier, JSON-mode capable as of 2026-09-07: the last resort when the paid balance is gone. */
export const REVIEW_FREE_MODELS = ['minimax/minimax-m3:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-31b-it:free']
/** First router fallback for the nightly review: the flash tier ($0.045/M in, $0.09/M out on 2026-09-19), never a frontier model. */
export const REVIEW_CHEAP_MODEL = 'deepseek/deepseek-v4-flash'
/**
 * The free-first provider. Was the local Ollama instance until 2026-09-12; its models turned out to be
 * cloud-backed, metered and weekly-limited, and served 0 of 1,025 critic calls while the paid router
 * quietly absorbed the lot. Gemini through Google's OpenAI-compatible endpoint replaces it.
 */
export const REVIEW_GEMINI = GEMINI
/**
 * Where the review may ask, in order: the configured OpenRouter models, Gemini, the app's own endpoint
 * (the DeepSeek or local server the trader already pays per token for), then OpenRouter's free tier.
 * 2026-09-07: the router balance hit zero and the review failed outright with three working fallbacks
 * available. Each provider drops out of the chain when its key is missing, so either one alone still runs
 * the review.
 */
export function reviewModelPlans(
  cfg: { llmBaseUrl: string; llmApiKey: string; llmModel: string; intelligencePrimaryModel?: string; intelligenceSecondaryModel?: string; intelligenceFallbackModel?: string },
  routerKey: string,
  gemini: { base: string; models: string[] } = REVIEW_GEMINI
): ReviewModelPlan[] {
  const router = 'https://openrouter.ai/api/v1'
  const direct = (cfg.llmBaseUrl || '').replace(/\/+$/, '')
  const directIsRouter = /openrouter/i.test(direct)
  const useRouter = Boolean(routerKey) || directIsRouter
  const routerAuth = routerKey || cfg.llmApiKey.trim()
  const plans: ReviewModelPlan[] = []
  const add = (p: ReviewModelPlan): void => {
    if (!plans.some((q) => q.base === p.base && q.model === p.model)) plans.push(p)
  }
  // The operator's own keyed endpoint and model lead the chain. Until 2026-09-19 it came FIFTH behind the
  // OpenRouter intelligence chain whenever a router key existed, so the review ran on gpt-5.6-sol every night
  // (model-usage 09-16..09-19) while the app was set to deepseek-flash. A failure there falls through to the
  // cheapest router model, then the intelligence chain, Gemini, and the free tier. A local endpoint without a
  // key still sits after Gemini.
  const directKeyed = Boolean(direct && !directIsRouter && cfg.llmModel && !/(localhost|127\.0\.0\.1)/.test(direct) && cfg.llmApiKey.trim())
  if (directKeyed) add({ base: direct, key: cfg.llmApiKey.trim(), model: cfg.llmModel, json: true })
  if (useRouter && routerAuth) {
    add({ base: router, key: routerAuth, model: REVIEW_CHEAP_MODEL, json: true })
    for (const model of new Set([cfg.intelligencePrimaryModel || 'openai/gpt-5.6-sol', cfg.intelligenceSecondaryModel || 'deepseek/deepseek-v4-pro', cfg.intelligenceFallbackModel || 'z-ai/glm-5.3'])) {
      add({ base: router, key: routerAuth, model, json: true })
    }
  }
  // Gemini needs its key; with none configured it contributes nothing and OpenRouter carries the chain.
  const gkey = geminiKey()
  if (gkey) for (const model of gemini.models) add({ base: gemini.base.replace(/\/+$/, ''), key: gkey, model, json: true })
  if (direct && !directIsRouter && cfg.llmModel && (cfg.llmApiKey.trim() || /(localhost|127\.0\.0\.1)/.test(direct))) {
    add({ base: direct, key: cfg.llmApiKey.trim(), model: cfg.llmModel, json: true })
  }
  if (useRouter && routerAuth) for (const model of REVIEW_FREE_MODELS) add({ base: router, key: routerAuth, model, json: true })
  return plans
}

/**
 * Periods the record must not be read as evidence; the prose copy with the rationale is
 * docs/DEGRADED-WINDOWS.md and the read scripts use scripts/backtests/degraded.py. Keep the three in step.
 */
export const DEGRADED_WINDOWS = [
  {
    id: 1,
    scope: 'execution',
    from: '2026-09-12T12:46Z',
    to: '2026-09-17T08:07Z',
    what: 'Kalshi order path slow (account reads before every order) and lead-lag sized for seven independent coins on one 15-minute window; -$31.28 in 90 minutes on 09-13, daily kill switch tripped',
    ended: 'round 115: read/write rate lanes, cached position count, reserve-inside/submit-outside'
  },
  {
    id: 2,
    scope: 'calibration',
    from: null,
    to: '2026-09-18T13:34Z',
    what: 'netCentsOf divided an already-per-contract fee by the contract count again, so calibration readings before the fix understated fees (dollar P&L unaffected)',
    ended: 'v27 migration cleared the calibration accumulators (CALIB_CLEARED_AT)'
  }
] as const

const SYSTEM = `You are the nightly strategy review analyst for Oracle Trader, a small prediction-market auto-trader (Kalshi real money, Polymarket US real money, IBKR ForecastEx paper). You reason over the evidence packet you are given and nothing else. You cannot place orders, change arms, sizes, loss limits, or keys; the app applies numeric parameter proposals that fall inside its published bounds; whether it also applies them to strategies that are currently LIVE is an operator switch whose state is in the packet ('autoApplyLive') — everything else you propose is filed for the operator.
Some periods of the record are marked 'degradedWindows': real money, but the configuration under test was later judged broken. Never read a strategy's edge from settlements inside one; say the evidence is confined to a degraded window and, if it matters, ask for the read to be split.
Principles: win rate is a base-rate trap on 90c contracts; net cents per contract after fees with clustered confidence intervals is the number; small samples deserve "insufficient evidence", not narratives; a strategy is dead when its fee-inclusive clustered interval excludes zero on the wrong side; venue-settled P&L outranks any app ledger. Be specific: cite the packet's numbers.
Output ONLY a JSON object with exactly these fields:
{"summary": string (<= 120 words), "healthFlags": string[], "findings": [{"topic": string, "evidence": string, "severity": "info"|"warn"|"high"}], "parameterProposals": [{"target": "kalshi"|"polymarket-us", "key": string, "value": number, "rationale": string}], "experimentProposals": [{"title": string, "hypothesis": string, "design": string, "metric": string, "stopRule": string}], "codeProposals": [{"title": string, "whereToLook": string, "rationale": string}], "confidence": number}`

export class NightlyReview {
  private running = false
  private last: ReviewRecord | undefined

  constructor(
    private readonly engine: TradingEngine,
    private readonly autoTrader: AutoTrader,
    private readonly minis: Map<VenueId, MiniAuto>,
    private readonly ladder: Ladder,
    private readonly userData: string,
    private readonly log: (s: string) => void = console.log
  ) {
    try {
      const p = join(this.dir(), 'latest.json')
      if (existsSync(p)) this.last = JSON.parse(readFileSync(p, 'utf8')) as ReviewRecord
    } catch {
      // none yet
    }
  }

  private dir(): string {
    return join(this.userData, 'reviews')
  }

  status(): { at?: number; date?: string; summary?: string; applied?: number; skipped?: number; error?: string; model?: string } {
    if (!this.last) return {}
    return { at: this.last.at, date: this.last.date, summary: this.last.summary, applied: this.last.applied.length, skipped: this.last.skipped.length, error: this.last.error, model: this.last.model }
  }

  /** Run when the configured UTC hour has passed today and no review exists for today. */
  async runIfDue(): Promise<void> {
    const cfg = this.autoTrader.getConfig()
    if (!(cfg.nightlyReviewEnabled ?? true)) return
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    if (now.getUTCHours() < (cfg.nightlyReviewHourUtc ?? 6)) return
    if (this.last?.date === today) {
      // A failed attempt (model down, key missing) retries every 2 hours, at
      // most three attempts per day; a successful review is final for the day.
      if (!this.last.error) return
      if (Date.now() - this.last.at < 2 * 3600_000) return
      if ((this.last.attempts ?? 1) >= 3) return
    }
    await this.run()
  }

  private async digest(): Promise<Record<string, unknown>> {
    const cfg = this.autoTrader.getConfig()
    const st = this.autoTrader.getStatus()
    const q = this.autoTrader.getQuantStatus()
    const live = await this.engine.getLivePnl('kalshi').catch(() => null)
    const fam = (t: string): string => (/^KX(HIGH|LOW)/.test(t) ? 'weather' : /^KX(BTC|ETH|SOL|XRP|DOGE)/.test(t) ? 'crypto' : 'other')
    const byFamily: Record<string, { n: number; wins: number; net: number }> = {}
    // Was yesterday 00:00Z, so the field summed 24 h PLUS the hours since midnight - 30 h at the 06:00Z
    // run - and was reported as "last 24h" (audit B-49; a distinct cause from BACKLOG 134).
    const dayStart = Date.now() - 86400_000
    let last24h = 0
    // What the family buckets actually sum to, before they are each rounded to the cent.
    let settlementsNet = 0
    for (const d of live?.details ?? []) {
      const f = (byFamily[fam(d.marketId)] ??= { n: 0, wins: 0, net: 0 })
      f.n++
      if (d.realizedPnl > 0) f.wins++
      f.net += d.realizedPnl
      settlementsNet += d.realizedPnl
      if (d.timestamp >= dayStart) last24h += d.realizedPnl
    }
    for (const f of Object.values(byFamily)) f.net = Math.round(f.net * 100) / 100
    const minis: Record<string, unknown> = {}
    for (const [venue, m] of this.minis) {
      const ms = m.getStatus()
      const mc = m.getConfig()
      minis[venue] = { enabled: mc.enabled, liveArmed: mc.liveArmed, microMakerEnabled: mc.microMakerEnabled, fadeEnabled: mc.fadeEnabled, perf: ms.perf, perfByStrategy: ms.perfByStrategy, open: ms.openTrades.length, pending: (ms.pendingOrders ?? []).length, lastError: ms.lastError }
    }
    // Errors and WARNINGS were counted together into one opaque number, and on 2026-09-10 that reported
    // "54 errors in 24h" - a high_errors_24h health flag and a code proposal - when the truth was 3 errors
    // and 51 warnings, 49 of the warnings being one `[ratchet] refused` signature adjudicated NOT-A-DEFECT
    // in incident 2026-09-09T00-20 and suppressed in the sentinel until 2026-12-02. Counting them together
    // both cries wolf and hides the three real errors (renderer crashes) inside the noise. Split, with the
    // top signatures attached so the reviewer can see what it is actually looking at.
    let errors24h = 0
    let warns24h = 0
    let topLogSignatures24h: { signature: string; level: string; count: number }[] = []
    try {
      const logPath = join(this.userData, 'logs', 'main.log')
      if (existsSync(logPath)) {
        const cutoff = Date.now() - 86400_000
        const sigs = new Map<string, { level: string; count: number }>()
        for (const line of readFileSync(logPath, 'utf8').split('\n')) {
          const m = /^\[([^\]]+)\]\s+\[(error|warn)\]\s*(.*)$/.exec(line)
          if (!m) continue
          const ts = Date.parse(m[1])
          if (!Number.isFinite(ts) || ts < cutoff) continue
          if (m[2] === 'error') errors24h++
          else warns24h++
          // Digits collapsed so one signature does not become one row per ticker or price.
          const signature = m[3].replace(/\d+/g, 'N').slice(0, 100)
          const rec = sigs.get(signature) ?? { level: m[2], count: 0 }
          rec.count++
          if (m[2] === 'error') rec.level = 'error'
          sigs.set(signature, rec)
        }
        topLogSignatures24h = [...sigs.entries()]
          .map(([signature, r]) => ({ signature, level: r.level, count: r.count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 8)
      }
    } catch {
      // best effort
    }
    const cfgSnapshot: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(cfg)) {
      if (/key|secret|url/i.test(k)) continue
      cfgSnapshot[k] = v
    }
    return {
      generatedAt: new Date().toISOString(),
      // Periods the record must not be read as evidence (docs/DEGRADED-WINDOWS.md). The 2026-09-20 review
      // tightened a live arm off a two-day calibration window that was one correlated crypto settlement (§140).
      degradedWindows: DEGRADED_WINDOWS,
      // The prompt used to promise that live strategies are never auto-applied. That is an operator switch, and
      // it is on: the same review's fade proposal, which the model itself marked "for operator review", was
      // applied (§141, BACKLOG 185).
      // Must match the APPLIER's own default below (`reviewAutoApplyLive ?? true`). It read `?? false` here, so
      // the packet told the model live arms were protected while the applier was in fact applying to them - the
      // §141 fix replaced one false promise in the prompt with a false value in the packet (audit B-46).
      autoApplyLive: cfg.reviewAutoApplyLive ?? true,
      // `flat`, `byFamilyNet` and `unsettledMarketFees` exist so this block reconciles without guesswork:
      // wins + losses + flat === settlements, and byFamilyNet - unsettledMarketFees === realizedPnl. The
      // 2026-09-10 review spent a finding on both gaps because the packet withheld the closing terms.
      venueSettled: live
        ? {
            available: live.available,
            settlements: live.settlements,
            realizedPnl: Math.round(live.realizedPnl * 100) / 100,
            wins: live.wins,
            losses: live.losses,
            flat: live.flat,
            byFamily,
            byFamilyNet: Math.round(settlementsNet * 100) / 100,
            unsettledMarketFees: Math.round((settlementsNet - live.realizedPnl) * 100) / 100,
            detailsTruncated: live.settlements > (live.details?.length ?? 0),
            last24h: Math.round(last24h * 100) / 100
          }
        : null,
      venueDay: { realized: st.venueDailyRealized, settlements: st.venueDailySettlements, killSource: st.killSource, killTripped: st.killSwitchTripped, exchangePaused: st.exchangePaused },
      ladder: this.ladder.status().strategies.map((s) => ({ id: s.id, stage: s.stage, since: new Date(s.since).toISOString(), lastVerdict: s.lastVerdict })),
      kalshiTrader: { perf: st.perf, perfByStrategy: st.perfByStrategy, calib: st.calib?.byStrategy, vetoesByReason: st.calib?.vetoesByReason, openTrades: st.openTrades.length, pendingOrders: st.pendingOrders?.length ?? 0, lastError: st.lastError, scans: st.scans },
      quoter: q.quoter,
      convergence: q.convergence,
      leadLag: { dislocationsLogged: q.leadLag.dislocationsLogged, tradesExecuted: q.leadLag.tradesExecuted, last: q.leadLag.lastDislocation },
      dutch: { opportunitiesFound: q.dutch.opportunitiesFound, executedBaskets: q.dutch.executedBaskets },
      sportsShadow: st.sportsShadow ? { n: st.sportsShadow.n, meanGapCents: st.sportsShadow.n ? +(st.sportsShadow.sumGapCents / st.sportsShadow.n).toFixed(2) : null, meanAbsGapCents: st.sportsShadow.n ? +(st.sportsShadow.sumAbsGapCents / st.sportsShadow.n).toFixed(2) : null } : null,
      wsAgreement: st.wsStats ? { compared: st.wsStats.compared, agreed: st.wsStats.agreed, reconnects: st.wsStats.reconnects } : null,
      minis,
      errors24h,
      warns24h,
      topLogSignatures24h,
      config: cfgSnapshot,
      parameterBounds: PARAM_BOUNDS
    }
  }

  private async askModel(packet: Record<string, unknown>): Promise<{ text: string; model: string; ms: number }> {
    const plans = reviewModelPlans(this.autoTrader.getConfig(), process.env.OPENROUTER_API_KEY?.trim() ?? '')
    if (plans.length === 0) throw new Error('no LLM key configured')
    const t0 = Date.now()
    // Every plan's failure is kept and logged as it happens: on 2026-09-08 the
    // record showed only the last (free-tier) model's 429 while nine earlier
    // plans had failed unseen, so the cause could not be read from the record.
    const failures: string[] = []
    const fail = (s: string): void => {
      failures.push(s)
      this.log(`[review] model failed (${failures.length}/${plans.length}): ${s.slice(0, 220)}`)
    }
    for (const { base, key, model, json } of plans) {
      try {
        const res = await trackedModelFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            // Reasoning models spend this budget thinking before the JSON;
            // 2,500 left several of them with an empty or truncated answer.
            max_tokens: 8000,
            ...(json ? { response_format: { type: 'json_object' } } : {}),
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: JSON.stringify(packet) }
            ]
          }),
          signal: AbortSignal.timeout(180_000)
        }, { caller: 'nightly-review', model })
        if (!res.ok) {
          fail(`${model}: HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
          continue
        }
        const j = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] }
        const finish = j.choices?.[0]?.finish_reason ?? '?'
        const text = (j.choices?.[0]?.message?.content ?? '').trim()
        if (!text) {
          fail(`${model}: empty response (finish=${finish})`)
          continue
        }
        // A malformed answer must fall through to the next model, not end the
        // review (2026-09-07: one retry died on a truncated array at char 5565).
        const body = text.match(/\{[\s\S]*\}/)?.[0] ?? text
        try {
          JSON.parse(body)
        } catch (e) {
          fail(`${model}: unparseable JSON (${e instanceof Error ? e.message.slice(0, 60) : 'error'}; finish=${finish}; ${text.length} chars)`)
          continue
        }
        return { text: body, model, ms: Date.now() - t0 }
      } catch (e) {
        fail(`${model}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    throw new Error(failures.join(' | ') || 'no model attempted')
  }

  async run(): Promise<ReviewRecord | undefined> {
    if (this.running) return this.last
    this.running = true
    const at = Date.now()
    const date = new Date(at).toISOString().slice(0, 10)
    const rec: ReviewRecord = {
      at,
      date,
      summary: '',
      healthFlags: [],
      findings: [],
      parameterProposals: [],
      experimentProposals: [],
      codeProposals: [],
      applied: [],
      skipped: [],
      attempts: (this.last?.date === date ? this.last.attempts ?? 1 : 0) + 1
    }
    try {
      const packet = await this.digest()
      const { text, model, ms } = await this.askModel(packet)
      rec.model = model
      rec.latencyMs = ms
      const m = text.match(/\{[\s\S]*\}/)
      const parsed = JSON.parse(m ? m[0] : text) as Partial<ReviewRecord> & { confidence?: number }
      rec.summary = String(parsed.summary ?? '').slice(0, 1200)
      rec.healthFlags = Array.isArray(parsed.healthFlags) ? parsed.healthFlags.map(String).slice(0, 20) : []
      rec.findings = Array.isArray(parsed.findings) ? parsed.findings.slice(0, 30) : []
      rec.parameterProposals = Array.isArray(parsed.parameterProposals) ? parsed.parameterProposals.slice(0, 20) : []
      rec.experimentProposals = Array.isArray(parsed.experimentProposals) ? parsed.experimentProposals.slice(0, 10) : []
      rec.codeProposals = Array.isArray(parsed.codeProposals) ? parsed.codeProposals.slice(0, 10) : []

      const kalshiCfg = this.autoTrader.getConfig()
      const polyCfg = this.minis.get('polymarket-us')?.getConfig()
      const plan = planParameterChanges(rec.parameterProposals, kalshiCfg, { 'polymarket-us': polyCfg }, kalshiCfg.reviewAutoApplyParams ?? true, kalshiCfg.reviewAutoApplyLive ?? true)
      rec.skipped = plan.skipped
      for (const a of plan.apply) {
        if (a.target === 'kalshi') this.autoTrader.setConfig({ [a.key]: a.to } as Partial<AutoTraderConfig>)
        else this.minis.get('polymarket-us')?.setConfig({ [a.key]: a.to } as Partial<MiniAutoConfig>)
        rec.applied.push({ target: a.target, key: a.key, from: a.from, to: a.to })
        this.log(`[review] applied ${a.target}.${a.key}: ${String(a.from)} → ${a.to}`)
      }
      this.log(`[review] ${date} via ${model} (${ms} ms): ${rec.summary.slice(0, 200)} | applied ${rec.applied.length}, filed ${rec.skipped.length + rec.codeProposals.length + rec.experimentProposals.length}`)
      const url = kalshiCfg.alertWebhookUrl
      if (url) void sendAlert(url, `Oracle Trader — nightly review ${date}`, `${rec.summary}\nflags: ${rec.healthFlags.join('; ') || 'none'}\napplied: ${rec.applied.length} parameter change(s)`)
    } catch (e) {
      rec.error = e instanceof Error ? e.message : String(e)
      this.log('[review] failed: ' + rec.error)
    } finally {
      try {
        mkdirSync(this.dir(), { recursive: true })
        writeFileAtomic(join(this.dir(), `${date}.json`), JSON.stringify(rec, null, 2))
        writeFileAtomic(join(this.dir(), 'latest.json'), JSON.stringify(rec, null, 2))
        writeFileAtomic(join(this.dir(), `${date}.md`), renderMarkdown(rec))
      } catch (e) {
        this.log('[review] could not write review file: ' + (e instanceof Error ? e.message : String(e)))
      }
      this.last = rec
      this.running = false
    }
    return rec
  }
}

function renderMarkdown(r: ReviewRecord): string {
  const lines: string[] = [`# Nightly review — ${r.date}`, '', r.error ? `**Error:** ${r.error}` : r.summary, '']
  if (r.model) lines.push(`Model: ${r.model} (${r.latencyMs ?? 0} ms)`, '')
  if (r.healthFlags.length) lines.push('## Health flags', ...r.healthFlags.map((f) => `- ${f}`), '')
  if (r.findings.length) lines.push('## Findings', ...r.findings.map((f) => `- [${f.severity}] **${f.topic}** — ${f.evidence}`), '')
  if (r.applied.length) lines.push('## Parameter changes applied', ...r.applied.map((a) => `- ${a.target}.${a.key}: ${String(a.from)} → ${String(a.to)}`), '')
  if (r.skipped.length) lines.push('## Proposals filed (not applied)', ...r.skipped.map((s) => `- ${s.target}.${s.key}: ${s.reason}`), '')
  if (r.experimentProposals.length) lines.push('## Experiments proposed', ...r.experimentProposals.map((e) => `- **${e.title}** — ${e.hypothesis}; design: ${e.design}; metric: ${e.metric}; stop: ${e.stopRule}`), '')
  if (r.codeProposals.length) lines.push('## Code proposals (for a maintenance session)', ...r.codeProposals.map((c) => `- **${c.title}** — ${c.whereToLook}: ${c.rationale}`), '')
  return lines.join('\n')
}
