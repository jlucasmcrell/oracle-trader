/**
 * LLM "hunch" collector — the forward test registered in
 * docs/PREREGISTERED-llm-hunch.md. Runs inside the app so it can reuse the
 * configured LLM endpoint and key. It TRADES NOTHING: each pass asks the model
 * for a calibrated P(YES) on low-attention, news-driven Kalshi markets, given the
 * market's rules text plus fresh public headlines fetched at decision time, and
 * appends one JSONL line per hunch under <userData>/hunches/. The standalone
 * scripts/hunch-gate.mjs grades those lines at settlement.
 *
 * Public production data only (the demo toggle is irrelevant here).
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { writeFileAtomic } from '../store/json'
import { trackedModelFetch } from '../intelligence/modelUsage'
import { join } from 'node:path'
import { GEMINI, geminiKey } from '../intelligence/gemini'

export interface HunchLlmConfig {
  llmBaseUrl: string
  llmApiKey: string
  llmModel: string
  llmThinking?: string
  /**
   * Frontier-model challenger. Asked the IDENTICAL prompt for the same market at the same moment, written to
   * a separate ledger, and graded by the same pre-registered gate. The incumbent hunches came from mid-tier
   * models (deepseek-v4-pro 497, gemini-3.8-flash 444) and beat the market on calibration; whether a
   * frontier model forecasts better is untested.
   */
  hunchChallengerEnabled?: boolean
  hunchChallengerModel?: string
  hunchChallengerMaxPerDay?: number
}

export interface HunchPassSummary {
  scanned: number
  eligible: number
  hunched: number
  skippedSeen: number
  errors: number
  ms: number
  /** Distinct series in the pre-filtered set, and how many of them we have a category for. `eligible 0`
   * with `seriesKnown` well under `seriesSeen` is a STARVED pass, not an empty one - a distinction that was
   * invisible for days while the category cache lived only in memory. */
  seriesSeen?: number
  seriesKnown?: number
  seriesLookupsLeft?: number
}

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2'
const NEWS_CATEGORIES = /Politics|World|Elections|Entertainment|Climate|Science|Companies|Health|Social|Culture/i
const SKIP_CATEGORIES = /Sports|Crypto|Commodities|Financials/i
// Numeric ladders priced off a futures/index reference — not news markets.
const LADDER = /^KX(SOFRD|AAAGAS|NATGAS|SILVER|GOLD|COPPER|BRENT|WTI|DIESEL|USD|EUR|GBP|JPY|CPI|PAYROLL|UE-|FED|GDP|TRUEV|TRUF|MORTGAGE|TBILL)/
const MAX_PER_PASS = 100
const SEEN_TTL_MS = 20 * 3600_000
const MIN_HORIZON_MS = 12 * 3600_000
const MAX_HORIZON_MS = 30 * 86400_000
const MAX_SERIES_LOOKUPS = 60

// KXRAIN city codes -> coordinates for the NWS point forecast (best effort; unknown codes get headlines only).
const RAIN_COORDS: Record<string, [number, number]> = {
  NYC: [40.78, -73.97], SFO: [37.62, -122.38], SEA: [47.45, -122.31], CHI: [41.79, -87.75], MIA: [25.79, -80.29],
  LAX: [33.94, -118.41], DEN: [39.86, -104.67], TTN: [40.28, -74.81], BOS: [42.36, -71.01], DC: [38.85, -77.04],
  ATL: [33.64, -84.43], DFW: [32.9, -97.04], PHL: [39.87, -75.24], HOU: [29.98, -95.34], PHX: [33.43, -112.01],
  AUS: [30.19, -97.67], MSP: [44.88, -93.22], DTW: [42.21, -83.35], PDX: [45.59, -122.6], LAS: [36.08, -115.15]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : undefined
}

async function getJson<T>(url: string, init?: RequestInit, tries = 3): Promise<T> {
  for (let a = 0; a < tries; a++) {
    let res: Response
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
    } catch (e) {
      if (a === tries - 1) throw e
      await sleep(500)
      continue
    }
    if (res.ok) return (await res.json()) as T
    if (res.status === 429 || res.status >= 500) {
      await sleep(600 * Math.pow(1.8, a))
      continue
    }
    throw new Error(`HTTP ${res.status} ${url.slice(0, 80)}`)
  }
  throw new Error('exhausted ' + url.slice(0, 80))
}

interface RawMarket {
  ticker: string
  event_ticker?: string
  title?: string
  subtitle?: string
  rules_primary?: string
  close_time?: string
  yes_bid_dollars?: string
  yes_ask_dollars?: string
  volume_24h?: number
  open_interest?: number
  floor_strike?: number | string | null
  cap_strike?: number | string | null
  strike_type?: string | null
}

const seriesCategory = new Map<string, string>()

async function categoryOf(series: string, budget: { left: number }): Promise<string | undefined> {
  const cached = seriesCategory.get(series)
  if (cached !== undefined) return cached
  if (budget.left <= 0) return undefined
  budget.left--
  try {
    const j = await getJson<{ series?: { category?: string } }>(`${KALSHI}/series/${encodeURIComponent(series)}`)
    const c = j.series?.category ?? '?'
    seriesCategory.set(series, c)
    return c
  } catch {
    return undefined
  }
}

const headlineCache = new Map<string, { at: number; items: { title: string; source: string; date: string }[] }>()
const HEADLINE_TTL_MS = 10 * 60_000

/**
 * Google News RSS (keyless). Returns up to n headlines with source and date.
 * Cached for ten minutes per query: the LLM gate re-vets the same ~15 markets
 * every scan, which re-fetched the same feeds ~40 times a minute.
 */
export async function headlines(query: string, n = 8): Promise<{ title: string; source: string; date: string }[]> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 120)
  const hit = headlineCache.get(q)
  if (hit && Date.now() - hit.at < HEADLINE_TTL_MS) return hit.items.slice(0, n)
  const items = await headlinesUncached(q, n)
  headlineCache.set(q, { at: Date.now(), items })
  if (headlineCache.size > 500) { const oldest = [...headlineCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]; if (oldest) headlineCache.delete(oldest[0]) }
  return items
}

async function headlinesUncached(q: string, n: number): Promise<{ title: string; source: string; date: string }[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`news HTTP ${res.status}`)
  const xml = await res.text()
  const out: { title: string; source: string; date: string }[] = []
  const items = xml.split('<item>').slice(1)
  for (const it of items) {
    const title = (it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim()
    const source = (it.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? '').trim()
    const date = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? '').trim()
    if (title) out.push({ title, source, date })
    if (out.length >= n) break
  }
  return out
}

/** NWS point forecast text for rain markets (keyless; User-Agent required). */
async function nwsForecast(lat: number, lon: number): Promise<string | undefined> {
  const ua = { headers: { 'User-Agent': 'oracle-trader-hunch (research; contact via github)' } }
  const p = await getJson<{ properties?: { forecast?: string } }>(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, ua)
  const fUrl = p.properties?.forecast
  if (!fUrl) return undefined
  const f = await getJson<{ properties?: { periods?: { name?: string; detailedForecast?: string; probabilityOfPrecipitation?: { value?: number | null } }[] } }>(fUrl, ua)
  const periods = (f.properties?.periods ?? []).slice(0, 6)
  return periods.map((x) => `${x.name}: PoP ${x.probabilityOfPrecipitation?.value ?? 'n/a'}% — ${x.detailedForecast ?? ''}`).join('\n')
}

/** Subject line for the news query: strip the boilerplate question framing. */
function subjectOf(m: RawMarket): string {
  const t = (m.title ?? '').replace(/^Will\s+/i, '').replace(/\?$/, '').replace(/\bon\s+[A-Z][a-z]{2}\s+\d{1,2},\s*\d{4}\b/g, '').replace(/\bbefore\s+[A-Z][a-z]{2}\s+\d{1,2},\s*\d{4}\b/g, '')
  return t.trim() || m.ticker
}

/** Where a hunch may ask, in order: the router's fast models (or the app's own endpoint), then the local Ollama instance. */
export function hunchModelPlans(cfg: { llmBaseUrl: string; llmApiKey: string; llmModel: string }, routerKey: string): { base: string; key: string; model: string; local: boolean }[] {
  const useRouter = Boolean(routerKey) || /openrouter/i.test(cfg.llmBaseUrl)
  const base = (useRouter ? 'https://openrouter.ai/api/v1' : cfg.llmBaseUrl).replace(/\/+$/, '')
  const key = routerKey || cfg.llmApiKey.trim()
  const models = useRouter ? ['google/gemini-3.8-flash', 'deepseek/deepseek-v4-pro', 'z-ai/glm-5.3-flash'] : [cfg.llmModel]
  const plans = models.map((model) => ({ base, key, model, local: false }))
  // When OpenRouter is out of credit, Gemini carries it (the forecaster failed 30+ times an hour overnight
  // with no fallback). Gemini replaced Ollama on 2026-09-12: Ollama's models were metered and weekly-limited,
  // so the "free" tail never actually served. This caller sends no json_schema, so Gemini fences its output -
  // parseP pulls the object out with a regex, which is why that still works.
  const gkey = geminiKey()
  if (gkey) for (const model of GEMINI.models) plans.push({ base: GEMINI.base, key: gkey, model, local: false })
  return plans
}

async function askModel(cfg: HunchLlmConfig, system: string, user: string): Promise<{ text: string; ms: number; model: string }> {
  const useRouter = Boolean(process.env.OPENROUTER_API_KEY?.trim()) || /openrouter/i.test(cfg.llmBaseUrl)
  const t0 = Date.now()
  let last = 'no model attempted'
  for (const { base, key, model, local } of hunchModelPlans(cfg, process.env.OPENROUTER_API_KEY?.trim() ?? '')) {
    try {
      const res = await trackedModelFetch(`${base}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          ...(!useRouter && !local && cfg.llmThinking && cfg.llmThinking !== 'default' && /deepseek/i.test(cfg.llmBaseUrl) ? { thinking: { type: cfg.llmThinking } } : {}),
          ...(cfg.llmThinking === 'enabled' || cfg.llmThinking === 'adaptive' ? {} : { temperature: 0 }),
          max_tokens: 800, response_format: { type: 'json_object' } }), signal: AbortSignal.timeout(90_000) }, { caller: 'hunch-incumbent', model })
      if (!res.ok) { last = `${model}: HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`; continue }
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const text = (j.choices?.[0]?.message?.content ?? '').trim()
      if (!text) { last = `${model}: empty response`; continue }
      return { text, ms: Date.now() - t0, model }
    } catch (e) { last = `${model}: ${e instanceof Error ? e.message : String(e)}` }
  }
  throw new Error(last)
}

const SYSTEM = `You are a calibrated probabilistic forecaster. You will be given a prediction-market question, its exact resolution rules, the current market price, and recent headlines retrieved just now. Estimate the probability that the question resolves YES. Be honest about uncertainty: if the evidence is thin, stay near the base rate implied by the rules rather than the market price. Do not anchor on the market price; it is provided only so you can say whether you disagree. Respond with ONLY a JSON object: {"p_yes": number between 0.01 and 0.99, "confidence": "low"|"medium"|"high", "key_evidence": "one sentence"}.`

/**
 * Every TOP-LEVEL brace-balanced object in the text, last first, each with where it ends. Top-level only:
 * a nested value starts later than its parent and a naive collector then ranks it as "the later answer" -
 * {"p_yes": 0.2, "meta": {"p_yes": 0.9}} returned 0.9 that way. Strings are skipped so a brace inside
 * key_evidence cannot open or close anything.
 */
function balancedObjects(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = []
  let depth = 0
  let inStr = false
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      if (depth > 0) inStr = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        out.push({ start, end: i + 1, text: text.slice(start, i + 1) })
        start = -1
      }
    }
  }
  return out.reverse()
}

/** Does this text open a '{' outside a string that never closes? That is what a max_tokens cut looks like. */
function hasUnclosedBrace(text: string): boolean {
  let depth = 0
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"' && depth > 0) inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && depth > 0) depth--
  }
  return depth > 0
}

function parseP(text: string): { p: number; confidence?: string; evidence?: string } | undefined {
  const objs = balancedObjects(text)
  // The tail after the last COMPLETE top-level object. If it opens an object that never closes, the model's
  // final answer was cut off at max_tokens; an earlier complete object is then a decoy, and the salvage
  // reader is pointed at the tail alone so the decoy is out of scope by construction.
  const tail = objs.length ? text.slice(objs[0].end) : text
  if (hasUnclosedBrace(tail)) return salvageP(tail)
  for (const { text: cand } of objs) {
    try {
      const j = JSON.parse(cand) as { p_yes?: unknown; confidence?: unknown; key_evidence?: unknown }
      const p = num(j.p_yes)
      if (p === undefined) continue
      if (p <= 0 || p >= 1) return undefined
      return { p: Math.min(0.99, Math.max(0.01, p)), confidence: typeof j.confidence === 'string' ? j.confidence : undefined, evidence: typeof j.key_evidence === 'string' ? j.key_evidence.slice(0, 240) : undefined }
    } catch {
      /* not this one */
    }
  }
  return salvageP(text)
}

/**
 * Last resort for a response cut off mid-object: read the fields straight out of the raw text. Takes the
 * LAST p_yes, matching JSON's last-key-wins, so a truncated decoy-then-answer still yields the answer.
 */
function salvageP(text: string): { p: number; confidence?: string; evidence?: string } | undefined {
  const pms = [...text.matchAll(/"p_yes"\s*:\s*([0-9]*\.?[0-9]+)/g)]
  const pm = pms[pms.length - 1]
  if (!pm) return undefined
  const p = num(pm[1])
  if (p === undefined || p <= 0 || p >= 1) return undefined
  const cms = [...text.matchAll(/"confidence"\s*:\s*"(low|medium|high)"/g)]
  const cm = cms[cms.length - 1]
  const ems = [...text.matchAll(/"key_evidence"\s*:\s*"((?:[^"\\]|\\.)*)/g)]
  const em = ems[ems.length - 1]
  let evidence: string | undefined
  if (em) {
    // Decode the fragment as a JSON string so every escape is handled the way JSON.parse would have.
    try {
      evidence = (JSON.parse('"' + em[1] + '"') as string).slice(0, 240)
    } catch {
      evidence = em[1].replace(/\\"/g, '"').slice(0, 240)
    }
  }
  return { p: Math.min(0.99, Math.max(0.01, p)), confidence: cm ? cm[1] : undefined, evidence }
}

/** One pass. Never throws: every market is isolated; failures are counted and logged. */
export async function runHunchPass(cfg: HunchLlmConfig, dir: string, log: (s: string) => void = console.log): Promise<HunchPassSummary> {
  const t0 = Date.now()
  mkdirSync(dir, { recursive: true })
  // A series' category never changes, so re-paying for it after every restart is not just waste - it is
  // fatal. The per-pass budget is 60 lookups and the first 60 distinct series in catalog order are all
  // Sports, which this collector skips, so a cold pass spends everything before reaching a single news
  // series and reports `eligible 0`. That is what it did from 2026-09-11 onward, across ~15 restarts.
  const catPath = join(dir, 'series-categories.json')
  try {
    if (existsSync(catPath)) {
      const disk = JSON.parse(readFileSync(catPath, 'utf8')) as Record<string, string>
      for (const [k, v] of Object.entries(disk)) if (typeof v === 'string' && !seriesCategory.has(k)) seriesCategory.set(k, v)
    }
  } catch {
    // a corrupt cache is not worth failing a pass over; it refills from the API
  }
  const seenPath = join(dir, 'seen.json')
  let seen: Record<string, number> = {}
  try { if (existsSync(seenPath)) seen = JSON.parse(readFileSync(seenPath, 'utf8')) as Record<string, number> } catch { seen = {} }
  // Computed at each write, not at pass start: a pass that straddles UTC midnight filed the rest of the
  // day's rows under the previous day.
  const outPath = (): string => join(dir, new Date().toISOString().slice(0, 10) + '.jsonl')
  // A separate directory so the pre-registered test is never contaminated: the same grader reads it via
  // HUNCH_DIR, giving a like-for-like Brier and trading comparison with no change to the grader at all.
  const challengerDir = join(dir, '..', 'hunches-challenger')
  mkdirSync(challengerDir, { recursive: true })
  const challengerPath = (): string => join(challengerDir, new Date().toISOString().slice(0, 10) + '.jsonl')
  // Per DAY, not per pass. As a plain local this reset to the full cap on every pass, so a config key named
  // `MaxPerDay` actually bought `40 x passes` — and passes run hourly. Today that only reached 42 because
  // the 20h seen-TTL starved the later passes; the moment a TTL expiry hands one pass 100 fresh markets and
  // another pass follows it, the same code spends the frontier-model budget twice over. Paid-model budgets
  // that reset silently are how $198 went last time, so the day's ledger is the source of truth.
  let challengerLeft = cfg.hunchChallengerEnabled === false ? 0 : (cfg.hunchChallengerMaxPerDay ?? 40)
  try {
    if (existsSync(challengerPath())) {
      const spent = readFileSync(challengerPath(), 'utf8').split('\n').filter((l) => l.trim()).length
      challengerLeft = Math.max(0, challengerLeft - spent)
    }
  } catch {
    // Unreadable ledger: assume the budget is gone rather than risk spending it twice.
    challengerLeft = 0
  }
  const challengerModel = cfg.hunchChallengerModel ?? 'openai/gpt-5.6-sol'
  const routerKey = process.env.OPENROUTER_API_KEY?.trim() ?? ''
  const sum: HunchPassSummary = { scanned: 0, eligible: 0, hunched: 0, skippedSeen: 0, errors: 0, ms: 0 }
  if (!cfg.llmApiKey.trim() && !process.env.OPENROUTER_API_KEY?.trim() && !/(localhost|127\.0\.0\.1)/.test(cfg.llmBaseUrl)) {
    log('[hunch] no LLM key configured; pass skipped')
    return sum
  }

  // 1) universe
  const all: RawMarket[] = []
  let cursor: string | undefined
  for (let p = 0; p < 12; p++) {
    const j = await getJson<{ markets?: RawMarket[]; cursor?: string }>(`${KALSHI}/markets?status=open&limit=1000&mve_filter=exclude${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    all.push(...(j.markets ?? []))
    cursor = j.cursor
    if (!cursor) break
    await sleep(120)
  }
  sum.scanned = all.length
  const now = Date.now()
  const pre = all.filter((m) => {
    const close = m.close_time ? Date.parse(m.close_time) : NaN
    if (!Number.isFinite(close) || close - now < MIN_HORIZON_MS || close - now > MAX_HORIZON_MS) return false
    const yb = num(m.yes_bid_dollars), ya = num(m.yes_ask_dollars)
    if (yb === undefined || ya === undefined) return false
    const mid = (yb + ya) / 2
    if (!(mid > 0.05 && mid < 0.95)) return false
    // Numeric buckets (temperature ladders, index/approval ranges) are not news questions:
    // the model cannot reason about a range bucket, and the market prices them off data.
    if (m.floor_strike !== undefined && m.floor_strike !== null) return false
    if (m.cap_strike !== undefined && m.cap_strike !== null) return false
    return !LADDER.test(m.ticker)
  })
  const budget = { left: MAX_SERIES_LOOKUPS }
  const eligible: RawMarket[] = []
  for (const m of pre) {
    const cat = await categoryOf(m.ticker.split('-')[0], budget)
    if (!cat || SKIP_CATEGORIES.test(cat) || !NEWS_CATEGORIES.test(cat)) continue
    eligible.push(m)
  }
  try {
    // '?' means the venue returned no category; keep it for this pass so the series is not re-fetched
    // sixty times, but never write it to disk, or one blank response would be believed forever.
    writeFileAtomic(catPath, JSON.stringify(Object.fromEntries([...seriesCategory].filter(([, v]) => v !== '?'))))
  } catch {
    // best effort - the pass still works from the in-memory map
  }
  const preSeries = new Set(pre.map((m) => m.ticker.split('-')[0]))
  sum.seriesSeen = preSeries.size
  // Of THIS pass's series, how many have a category. The lifetime cache size was reported here before,
  // giving ratios like 250/184 that could not distinguish a starved pass from a full one.
  sum.seriesKnown = [...preSeries].filter((x) => seriesCategory.has(x)).length
  sum.seriesLookupsLeft = budget.left
  eligible.sort((a, b) => Date.parse(a.close_time ?? '') - Date.parse(b.close_time ?? ''))
  sum.eligible = eligible.length

  // 2) hunch, soonest first, capped
  let done = 0
  for (const m of eligible) {
    if (done >= MAX_PER_PASS) break
    if (seen[m.ticker] && now - seen[m.ticker] < SEEN_TTL_MS) { sum.skippedSeen++; continue }
    const yb = num(m.yes_bid_dollars) ?? 0, ya = num(m.yes_ask_dollars) ?? 0
    const mid = (yb + ya) / 2
    const cat = seriesCategory.get(m.ticker.split('-')[0]) ?? '?'
    try {
      const subject = subjectOf(m)
      let news: { title: string; source: string; date: string }[] = []
      try { news = await headlines(subject) } catch (e) { log(`[hunch] news failed for ${m.ticker}: ${e instanceof Error ? e.message : String(e)}`) }
      let extra = ''
      if (/^KXRAIN-/.test(m.ticker)) {
        const code = m.ticker.split('-').pop() ?? ''
        const c = RAIN_COORDS[code]
        if (c) { try { const f = await nwsForecast(c[0], c[1]); if (f) extra = `\n\nNWS point forecast for the city (retrieved now):\n${f}` } catch { /* headlines only */ } }
      }
      const user = `Question: ${m.title ?? m.ticker}${m.subtitle ? `\nDetail: ${m.subtitle}` : ''}\nResolution rules: ${(m.rules_primary ?? '').slice(0, 900)}\nCloses: ${m.close_time}\nCurrent market: yes bid ${yb.toFixed(2)}, yes ask ${ya.toFixed(2)} (mid ${mid.toFixed(2)})\nToday: ${new Date(now).toISOString().slice(0, 10)}\n\nRecent headlines for "${subject}" (retrieved now):\n${news.length ? news.map((h) => `- [${h.date.slice(0, 16)}] ${h.title} (${h.source})`).join('\n') : '(none found)'}${extra}\n\nReturn the JSON object only.`
      let { text, ms, model } = await askModel(cfg, SYSTEM, user)
      let parsed = parseP(text)
      if (!parsed) {
        const again = await askModel(cfg, SYSTEM, user + String.fromCharCode(10, 10) + 'Output ONLY the JSON object now, nothing else.')
        text = again.text; ms += again.ms; model = again.model; parsed = parseP(text)
      }
      if (!parsed) throw new Error('unparseable model output: ' + text.slice(0, 120))
      const line = {
        ts: new Date().toISOString(), t: m.ticker, ev: m.event_ticker ?? m.ticker, series: m.ticker.split('-')[0], category: cat,
        title: (m.title ?? '').slice(0, 160), close: m.close_time, hoursToClose: +(((Date.parse(m.close_time ?? '') - now) / 3600e3).toFixed(1)),
        yb, ya, mid: +mid.toFixed(4), vol24: m.volume_24h ?? null, oi: m.open_interest ?? null,
        model, p: parsed.p, confidence: parsed.confidence ?? null, evidence: parsed.evidence ?? null,
        headlines: news.length, rainForecast: !!extra, llmMs: ms, first: !seen[m.ticker]
      }
      appendFileSync(outPath(), JSON.stringify(line) + '\n')
      // Same prompt, same market, same moment - the only difference is the model. Budget spent in market
      // order rather than on the markets where the incumbent looks uncertain, because sampling on
      // disagreement would bias the very comparison this is making.
      if (challengerLeft > 0 && routerKey) {
        challengerLeft--
        try {
          const c0 = Date.now()
          const res = await trackedModelFetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${routerKey}` },
            body: JSON.stringify({ model: challengerModel, temperature: 0, max_tokens: 1500, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] }),
            signal: AbortSignal.timeout(120_000)
          }, { caller: 'hunch-challenger', model: challengerModel })
          if (res.ok) {
            const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
            const cp = parseP(j.choices?.[0]?.message?.content ?? '')
            if (cp) {
              appendFileSync(
                challengerPath(),
                JSON.stringify({ ...line, model: challengerModel, p: cp.p, confidence: cp.confidence ?? null, evidence: cp.evidence ?? null, llmMs: Date.now() - c0, incumbentP: parsed.p }) + '\n'
              )
            }
          } else {
            log(`[hunch] challenger HTTP ${res.status}`)
          }
        } catch (e) {
          log(`[hunch] challenger failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      seen[m.ticker] = now
      sum.hunched++
      done++
    } catch (e) {
      sum.errors++
      log(`[hunch] ${m.ticker}: ${e instanceof Error ? e.message : String(e)}`)
    }
    await sleep(250)
  }
  try { writeFileAtomic(seenPath, JSON.stringify(seen)) } catch { /* best effort */ }
  sum.ms = Date.now() - t0
  log(`[hunch] pass: scanned ${sum.scanned}, eligible ${sum.eligible}, hunched ${sum.hunched}, skipped(seen) ${sum.skippedSeen}, errors ${sum.errors}, series ${sum.seriesKnown}/${sum.seriesSeen} categorized (budget left ${sum.seriesLookupsLeft}), challenger left today ${challengerLeft}, ${(sum.ms / 1000).toFixed(0)}s`)
  return sum
}
