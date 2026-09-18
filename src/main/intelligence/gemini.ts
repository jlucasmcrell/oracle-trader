/**
 * Gemini through Google's OpenAI-COMPATIBLE endpoint, as the free-first provider for the nightly review,
 * the pre-trade critic and the hunch forecaster. Replaces the local Ollama instance (operator decision,
 * 2026-09-12).
 *
 * WHY THE SWAP
 * ------------
 * The "local Ollama" path was never local: `deepseek-v4-pro:cloud`, `glm-5.3:cloud` and `kimi-k3:cloud` are
 * cloud-backed and metered, and the account is weekly-limited. It answered `0` of 1,025 critic calls, so
 * every one fell through to a premium OpenRouter model and spent $198 of a $230 grant on a measurement that
 * cannot even act. A free path that silently never serves is worse than no free path, because the fallback
 * absorbs the whole load without anyone noticing.
 *
 * WHY THE COMPAT ENDPOINT
 * -----------------------
 * `callCritic` and the review already speak OpenAI chat-completions with `response_format: json_schema`.
 * Verified 2026-09-12 against this endpoint: Gemini honours the strict schema and returns clean, UNFENCED,
 * parseable JSON. Without the schema it wraps the object in a ```json fence, which is why the hunch
 * forecaster - the one caller that does not send a schema - relies on its `parseP` regex to pull the object
 * out. Both paths therefore work with no change to the client.
 *
 * MODEL CHOICE
 * ------------
 * `gemini-3.8-flash` first: it emitted schema-clean JSON in ~1.4-3.7s. `gemini-3.5-flash-lite` second as a
 * faster, cheaper backstop (~0.4-0.8s). Both need real output headroom - the newer flash models spend
 * tokens on internal reasoning before emitting, so a small `max_tokens` returns an empty or truncated
 * completion rather than an error. The client's 1,800 is comfortable; anything under ~200 is not.
 */
export const GEMINI = {
  base: 'https://generativelanguage.googleapis.com/v1beta/openai',
  models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite']
}

/** The key, or '' when it is not configured - in which case every Gemini plan is skipped and OpenRouter carries the load. */
export function geminiKey(): string {
  return process.env.GEMINI_API_KEY?.trim() ?? ''
}
