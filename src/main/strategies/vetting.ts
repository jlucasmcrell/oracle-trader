import type { AutoSignal, AutoTraderConfig } from '../../shared/ipc'
import { headlines } from './hunch'
import { trackedModelFetch } from '../intelligence/modelUsage'

/**
 * Final AI risk gate for the auto-trader.
 *
 * Provider-agnostic: any OpenAI-compatible chat-completions endpoint works
 * (OpenAI, DeepSeek, OpenRouter, a local Ollama /v1 server, ...). A missing
 * key or a parse/network failure is treated as a VETO  the gate must fail
 * closed when real money is at stake.
 */

export interface VettingMarket {
  marketId: string
  question: string
  yesProb: number
  /** Bid/ask spread in CENTS (matching costCents). */
  spread?: number
  volume24h?: number
  liquidity?: number
  closeInMinutes: number
  category?: string
  /** App-computed cost of this trade in cents per $1 (spread + fees). */
  costCents: number
  /** Primary resolution rules text (truncated)  where settlement traps live. */
  rules?: string
  /** Market may close/settle the instant its condition is met. */
  canCloseEarly?: boolean
  /** Same/similar event on the global Polymarket book (read-only reference). */
  crossVenue?: { price: number; question: string; similarity: number }
  /** Recent public trades; every public trade is taker-initiated, so `side` is the aggressor's side. */
  recentTrades: { side: 'yes' | 'no'; count: number; price: number; agoSeconds: number }[]
  headlines?: string[]
}

export interface VettingContext {
  executionMode: 'paper' | 'live'
  balance?: number
  openPositions: number
  stake: number
  maxOpenPositions: number
  dailyTradesLeft: number
}

export interface LlmVerdict {
  approve: boolean
  direction: 'YES' | 'NO'
  confidence: number
  reason: string
  /** The model's own estimate of P(YES wins), 0..1. */
  impliedProb?: number
  /** Expected edge in cents per $1, derived from impliedProb vs market price. */
  expectedEdgeCents?: number
}

const SYSTEM_PROMPT = [
  'You are the adversarial quantitative trading brain of an autonomous prediction-market bot on Kalshi and Polymarket US. You are the FINAL risk gate before an order is placed. A quantitative scanner found a candidate; you decide whether it is genuinely mispriced and worth risking real capital.',
  '',
  '# Your doctrine',
  '1. You do not predict winners. You identify MIS-PRICED PROBABILITIES. Form your own honest estimate of P(YES wins), call it impliedProb, and compare it to the market price. If your impliedProb is meaningfully above the market price, buy YES; meaningfully below, buy NO. The direction you output must follow your own probability estimate, never the scanner\'s suggestion.',
  '2. Adversarial skepticism. Never approve a trade you cannot defend with a specific mispricing thesis based on structural facts, catalyst timing, or hard mathematical dislocations. "It moved 3 cents" or "the order book has more bids" is NOT an edge.',
  '3. Mathematical hurdle & Fee clearance. The snapshot gives you costCents: the exact spread + exchange fee hurdle for THIS trade in cents per $1 staked. Approve only when your modeled net edge (|impliedProb - marketPrice| * 100 - costCents) is at least +2.0c per contract. If expected edge does not decisively clear the spread and taker fee, VETO.',
  '4. Extreme Prices & Asymmetric Tail Risk. When evaluating trades at extreme prices (e.g. buying NO at 93-98c or YES at 93-98c), you are risking ~$0.95 to make ~$0.05 (a 19:1 downside ratio). A single adverse spike wipes out 15-20 winning trades. Never assume a base-rate edge blindly: if the underlying asset (Gold, S&P 500, BTC, Oil, weather) has non-zero intraday volatility, scheduled macro releases, or momentum that could breach the strike before close, VETO.',
  '5. Horizon and Volatility awareness. On short horizons (15 minutes to 24 hours), market prices already reflect high consensus. Unless you have specific information or structural proof of lag (e.g. liquid Polymarket Global already moved while domestic book is stale), assume the market is sharp.',
  '6. Settlement Trap & Rule Auditing. Explicitly inspect `market.rules` and contract terms before approving: check for (a) early-settlement triggers (`canCloseEarly`), (b) index source discrepancies (e.g. METAR vs private weather station), (c) timezone/cutoff ambiguities, and (d) discretionary resolution language. If the contract rules create unhedgeable dispute or timing risk, VETO.',
  '7. Beware adverse selection. Chasing order book depth imbalances or sudden volume spikes on thin books is paying informed market makers. Only enter when you are providing resting liquidity (maker) or taking an uncorrected cross-venue price dislocation.',
  '8. Reason ONLY from the provided snapshot and verified headlines. If the data is insufficient to justify positive mathematical expectancy after fees and tail risk, fail closed: output approve: false.',
  '9. When in doubt, VETO. A missed trade costs $0.00. Capital preservation is priority #1.',
  '',
  '# Snapshot field notes',
  '- signal.details.edgeCents: app-modeled raw edge at the executable price.',
  '- signal.details.entryMode: "maker" means the entry rests inside the spread (0% maker fee on standard Kalshi quadratic series); "taker" crosses immediately paying exchange fees.',
  '- market.costCents: the all-in cost hurdle (spread + taker fees) for this trade in cents per contract.',
  '- market.rules: the primary resolution rules text. Check exact settlement index and cutoff semantics.',
  '- market.canCloseEarly: true means early resolution is possible  high tail risk for short premium / fade.',
  '- market.crossVenue: reference price on liquid Polymarket Global CLOB. If the liquid venue prices the event substantially against our position, local price is stale/toxic  VETO.',
  '',
  '# Worked examples',
  'Example 1  real cross-venue dislocation, approved:',
  '{"signal":{"strategy":"cross-venue","scannerSuggestedDirection":"NO","score":68,"details":{"polyProb":0.53,"kalshiProb":0.62,"gap":9,"similarity":0.6}},"market":{"yesProb":0.62,"spread":2,"costCents":4,"liquidity":1800,"closeInMinutes":180,"recentTrades":[{"side":"no","count":25,"price":0.62,"agoSeconds":95}]}}',
  ' {"approve":true,"direction":"NO","impliedProb":0.53,"confidence":0.7,"reason":"Polymarket Global prices this at 53% while domestic Kalshi book lags at 62%; buying NO at 38c clears the 4c cost hurdle with +5c net edge."}',
  '',
  'Example 2  unhedged high-risk fade on volatile asset, vetoed:',
  '{"signal":{"strategy":"fade","scannerSuggestedDirection":"NO","score":75,"details":{"prob":0.04,"yesExec":0.04,"noCost":0.96,"edgeCents":2.5,"entryMode":"maker"}},"market":{"question":"S&P 500 above 5980 at 4pm","yesProb":0.04,"spread":2,"costCents":2,"liquidity":400,"closeInMinutes":90,"recentTrades":[]}}',
  ' {"approve":false,"direction":"NO","impliedProb":0.07,"confidence":0.3,"reason":"Risking 96c to win 4c on S&P 500 with 90m to close has severe tail risk given intraday equity volatility; 24:1 downside does not justify the 2.5c edge."}',
  '',
  'Example 3  book imbalance on sports/thin market without catalyst, vetoed:',
  '{"signal":{"strategy":"book-imbalance","scannerSuggestedDirection":"YES","score":60,"details":{"ratio":1.8,"windowMin":10}},"market":{"question":"Orioles vs Rockies","yesProb":0.52,"spread":4,"costCents":5,"liquidity":80,"closeInMinutes":400,"recentTrades":[]}}',
  ' {"approve":false,"direction":"YES","impliedProb":0.52,"confidence":0.1,"reason":"Orderbook depth imbalance in a thin sports book reflects resting MM quotes, not athletic probability; cannot clear 5c spread+fee hurdle."}',
  '',
  'Note: you are a GATE, not a signal source. If your own estimate points the',
  'OPPOSITE way from scannerSuggestedDirection, output that direction honestly ',
  'the app treats the disagreement as a veto of this trade; it will never flip',
  'the trade to your direction.',
  '',
  '# Output contract',
  'Respond with ONLY one JSON object, no markdown, no commentary:',
  '{"approve": true|false, "direction": "YES"|"NO", "impliedProb": 0.0-1.0, "confidence": 0.0-1.0, "reason": "one sentence: the specific mispricing or risk veto rationale"}',
  '- impliedProb: your honest estimate of the probability YES wins.',
  '- direction: YES if impliedProb is above the market price, NO if below. It must be consistent with impliedProb.',
  '- confidence: how sure you are of the DIRECTION estimate, not the size of the edge.',
  '- reason: one sentence explaining the mispricing or the concrete tail-risk/rule veto.'
].join('\n')

/** Research-backed veto: the same fresh headlines the hunch collector uses, so the
 *  gate judges on information instead of narrating the prior it was handed. */
function buildUserPrompt(signal: AutoSignal, market: VettingMarket, ctx: VettingContext, research = ''): string {
  return buildUserPromptBase(signal, market, ctx) + research
}

function buildUserPromptBase(signal: AutoSignal, market: VettingMarket, ctx: VettingContext): string {
  return [
    'TRADE CANDIDATE',
    JSON.stringify(
      {
        signal: {
          strategy: signal.strategy,
          scannerSuggestedDirection: signal.outcome,
          score: signal.score,
          modelConfidence: signal.confidence,
          details: signal.details
        },
        market,
        context: ctx,
        headlineNote:
          'If headlines are provided, they are the freshest available for the underlying topic (RSS, delayed by minutes).'
      },
      null,
      2
    )
  ].join('\n')
}

export async function vetWithLlm(
  cfg: AutoTraderConfig,
  signal: AutoSignal,
  market: VettingMarket,
  ctx: VettingContext
): Promise<LlmVerdict> {
  if (!cfg.llmApiKey.trim() && !/(localhost|127\.0\.0\.1)/.test(cfg.llmBaseUrl)) {
    throw new Error('LLM API key not configured')
  }
  const base = cfg.llmBaseUrl.replace(/\/+$/, '')
  const controller = new AbortController()
  // Reasoning models (DeepSeek V4 Pro) can take 30-60s+ on the thinking phase.
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    let research = ''
    try {
      const subject = String((market as { question?: string; title?: string }).question ?? (market as { title?: string }).title ?? signal.marketId ?? '')
      const news = await headlines(subject)
      if (news.length) research = '\n\nRecent headlines (retrieved now):\n' + news.map((n) => '- [' + n.date.slice(0, 16) + '] ' + n.title + ' (' + n.source + ')').join('\n')
    } catch {
      // headlines are best-effort; the veto still runs on rules + price
    }
    const res = await trackedModelFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.llmApiKey.trim() ? { Authorization: `Bearer ${cfg.llmApiKey.trim()}` } : {})
      },
      body: JSON.stringify({
        model: cfg.llmModel || 'gpt-4o-mini',
        // DeepSeek thinking mode rejects/ignores temperature  send it only
        // when thinking is not active.
        ...(cfg.llmThinking === 'enabled' || cfg.llmThinking === 'adaptive' ? {} : { temperature: 0 }),
        // Reasoning models (DeepSeek V4 Pro) think in reasoning_content BEFORE
        // writing the answer. Non-thinking runs need ~100 tokens; thinking runs
        // can consume 1500+ on the thinking phase alone  leave real headroom.
        max_tokens: 2500,
        ...(cfg.llmThinking && cfg.llmThinking !== 'default' && /deepseek/i.test(cfg.llmBaseUrl)
          ? { thinking: { type: cfg.llmThinking } }
          : {}),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(signal, market, ctx, research) }
        ]
      }),
      signal: controller.signal
    }, { caller: `signal-vetting:${signal.strategy}`, model: cfg.llmModel || 'gpt-4o-mini' })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
    const data = (await res.json()) as { choices?: { message?: Record<string, unknown> }[] }
    const msg = data.choices?.[0]?.message ?? {}
    // Reasoning models (DeepSeek reasoner-style) put the answer in `content`;
    // tolerate engines that use `reasoning_content` for the final output.
    const text = typeof msg['content'] === 'string' && (msg['content'] as string).trim() !== ''
      ? (msg['content'] as string)
      : typeof msg['reasoning_content'] === 'string'
        ? (msg['reasoning_content'] as string)
        : ''
    return parseVerdict(text)
  } finally {
    clearTimeout(timer)
  }
}

export function parseVerdict(text: string): LlmVerdict {
  const cleaned = text.replace(/```(?:json)?/gi, '')
  const start = cleaned.indexOf('{')
  if (start < 0) throw new Error('LLM returned no JSON')
  let depth = 0
  let end = -1
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) throw new Error('Unbalanced JSON in LLM response')
  const obj = JSON.parse(cleaned.slice(start, end)) as Record<string, unknown>
  const approveRaw = obj['approve']
  const approve =
    approveRaw === true ||
    approveRaw === 'true' ||
    approveRaw === 'yes' ||
    obj['verdict'] === 'approve' ||
    obj['verdict'] === 'yes'
  const dirRaw = String(obj['direction'] ?? '').toUpperCase()
  // A verdict without a legible direction cannot gate a trade  fail closed
  // (the old default of YES could silently invert a validated NO signal).
  const direction = dirRaw.startsWith('N') ? 'NO' : dirRaw.startsWith('Y') ? 'YES' : null
  if (direction === null) throw new Error('LLM verdict missing direction')
  const confidence = typeof obj['confidence'] === 'number' ? obj['confidence'] : 0
  const impliedRaw = obj['impliedProb'] ?? obj['implied_prob']
  const impliedProb = typeof impliedRaw === 'number' ? impliedRaw : undefined
  const reason = typeof obj['reason'] === 'string' ? obj['reason'] : 'no reason given'
  return {
    approve,
    direction,
    confidence: Math.min(1, Math.max(0, confidence)),
    reason: reason.slice(0, 300),
    impliedProb: impliedProb !== undefined ? Math.min(1, Math.max(0, impliedProb)) : undefined
  }
}
