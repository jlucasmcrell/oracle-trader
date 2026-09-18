// Diagnose DeepSeek V4 Pro response shape for the vetting prompt.
// Run: node scripts/diag-deepseek.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appData = process.env.APPDATA
const cfg = JSON.parse(readFileSync(join(appData, 'oracle-trader', 'kalshi-auto.json'), 'utf-8'))
const key = cfg.config.llmApiKey
const base = cfg.config.llmBaseUrl.replace(/\/+$/, '')
const model = cfg.config.llmModel
console.log('testing model:', model, 'base:', base, 'key len:', key.length)

// extract the real system prompt from the source
const src = readFileSync('src/main/strategies/vetting.ts', 'utf-8')
const m = src.match(/const SYSTEM_PROMPT = \[([\s\S]*?)\]\.join\('\\n'\)/)
if (!m) {
  console.error('could not extract SYSTEM_PROMPT')
  process.exit(1)
}
const prompt = eval('[' + m[1] + ']').join('\n')
console.log('system prompt chars:', prompt.length)

const user = [
  'TRADE CANDIDATE',
  JSON.stringify({
    signal: {
      strategy: 'cross-venue',
      scannerSuggestedDirection: 'NO',
      score: 68,
      modelConfidence: 0.55,
      details: { polyProb: 0.53, kalshiProb: 0.62, gap: 9, similarity: 0.6 }
    },
    market: {
      marketId: 'TEST',
      question: 'Will Bitcoin be above $85,000 at 5:00 PM ET today?',
      yesProb: 0.62,
      spread: 0.02,
      volume24h: 42000,
      liquidity: 1800,
      closeInMinutes: 180,
      costCents: 4,
      recentTrades: [
        { side: 'no', aggressive: true, count: 25, price: 0.62, agoSeconds: 95 },
        { side: 'yes', aggressive: false, count: 6, price: 0.63, agoSeconds: 160 }
      ],
      headlines: ['Bitcoin dips below $84,000 as traders trim risk ahead of Fed decision']
    },
    context: {
      executionMode: 'paper',
      balance: 1000,
      openPositions: 1,
      stake: 5,
      maxOpenPositions: 6,
      dailyTradesLeft: 20
    }
  }, null, 2)
].join('\n')

const res = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model,
    temperature: 0,
    max_tokens: 1500,
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: user }
    ]
  })
})
console.log('HTTP', res.status)
const data = await res.json()
console.log('top-level keys:', Object.keys(data).join(', '))
console.log('usage:', JSON.stringify(data.usage))
console.log('finish_reason:', JSON.stringify(data.choices?.[0]?.finish_reason))
const msg = data.choices?.[0]?.message ?? {}
console.log('message keys:', Object.keys(msg).join(', '))
console.log('content:', JSON.stringify(msg.content).slice(0, 600))
console.log('reasoning_content:', JSON.stringify(msg.reasoning_content ?? null).slice(0, 400))
console.log('--- full message (truncated):', JSON.stringify(msg).slice(0, 1500))
