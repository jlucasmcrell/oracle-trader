import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export interface ModelUsage {
  requestId: string
  timestamp: number
  caller: string
  requestedModel: string
  returnedModel?: string
  providerHost: string
  generationId?: string
  status: number | null
  durationMs: number
  promptTokens: number | null
  completionTokens: number | null
  reportedCostUsd: number | null
}

const nonnegative = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null

function appendUsage(row: ModelUsage): void {
  const dir = join(app.getPath('userData'), 'model-usage')
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, new Date(row.timestamp).toISOString().slice(0, 10) + '.jsonl'), JSON.stringify(row) + '\n', { flush: true })
}

/** Observe existing non-streaming calls. No retries, prompt changes or extra provider requests. */
export async function trackedModelFetch(
  url: string, init: RequestInit, context: { caller: string; model: string },
  record: (row: ModelUsage) => void = appendUsage
): Promise<Response> {
  const timestamp = Date.now(), started = performance.now(), providerHost = new URL(url).hostname
  let response: Response | undefined, data: any
  try {
    response = await fetch(url, init)
    // Keep the original body available, including unsuccessful/malformed responses.
    try { data = await response.clone().json() } catch { /* charge remains unknown */ }
    return response
  } finally {
    const usage = data?.usage
    const row: ModelUsage = {
      requestId: randomUUID(), timestamp, caller: context.caller, requestedModel: context.model,
      returnedModel: typeof data?.model === 'string' ? data.model : undefined,
      providerHost, generationId: typeof data?.id === 'string' ? data.id : undefined,
      status: response?.status ?? null, durationMs: Math.round(performance.now() - started),
      promptTokens: nonnegative(usage?.prompt_tokens), completionTokens: nonnegative(usage?.completion_tokens),
      // Only OpenRouter's documented account charge is interpreted as USD.
      // Missing prices, direct-provider calls and network errors are never zero-cost claims.
      reportedCostUsd: providerHost === 'openrouter.ai' ? nonnegative(usage?.cost) : null
    }
    try { record(row) } catch { console.warn('[model-usage] could not persist usage; cost coverage is incomplete') }
  }
}

export function summarizeModelUsage(rows: ModelUsage[]) {
  const seen = new Map<string, string>()
  const groups = new Map<string, { day: string; caller: string; model: string; provider: string; calls: number; failures: number; pricedCalls: number; unknownCostCalls: number; reportedCostUsd: number; promptTokens: number; completionTokens: number }>()
  for (const row of rows) {
    if (!row.requestId || !Number.isFinite(row.timestamp)) throw new Error('Invalid usage identity/timestamp')
    const encoded = JSON.stringify(row), previous = seen.get(row.requestId)
    if (previous) { if (previous !== encoded) throw new Error('Conflicting usage identity'); continue }
    seen.set(row.requestId, encoded)
    const day = new Date(row.timestamp).toISOString().slice(0, 10), model = row.returnedModel ?? row.requestedModel
    const key = JSON.stringify([day, row.caller, model, row.providerHost])
    const group = groups.get(key) ?? { day, caller: row.caller, model, provider: row.providerHost, calls: 0, failures: 0, pricedCalls: 0, unknownCostCalls: 0, reportedCostUsd: 0, promptTokens: 0, completionTokens: 0 }
    group.calls++; if (row.status === null || row.status < 200 || row.status >= 300) group.failures++
    const cost = nonnegative(row.reportedCostUsd)
    if (cost === null) group.unknownCostCalls++
    else { group.pricedCalls++; group.reportedCostUsd += cost }
    group.promptTokens += nonnegative(row.promptTokens) ?? 0
    group.completionTokens += nonnegative(row.completionTokens) ?? 0
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => a.day.localeCompare(b.day) || b.reportedCostUsd - a.reportedCostUsd)
}
