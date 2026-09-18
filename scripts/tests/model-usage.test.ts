import assert from 'node:assert/strict'
import { trackedModelFetch, summarizeModelUsage, type ModelUsage } from '../../src/main/intelligence/modelUsage'
const original = globalThis.fetch
const rows: ModelUsage[] = []
const record = (r: ModelUsage) => rows.push(r)
async function main() {
  let calls = 0
  const init = { method: 'POST', headers: { Authorization: 'secret-key' }, body: 'secret-prompt' }
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    calls++; assert.equal(options, init); assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions')
    return new Response(JSON.stringify({ id: 'gen-1', model: 'actual-model', choices: [{ message: { content: 'private-output' } }], usage: { cost: 0.0123, prompt_tokens: 20, completion_tokens: 5, cost_details: { upstream_inference_cost: 4 } } }))
  }) as any
  const response = await trackedModelFetch('https://openrouter.ai/api/v1/chat/completions', init, { caller: 'hunch-challenger', model: 'requested-model' }, record)
  assert.equal((await response.json()).choices[0].message.content, 'private-output'); assert.equal(calls, 1)
  assert.equal(rows[0].reportedCostUsd, 0.0123); assert.equal(rows[0].returnedModel, 'actual-model')
  assert.equal(rows[0].promptTokens, 20); assert.equal(rows[0].completionTokens, 5)
  assert.ok(!JSON.stringify(rows).match(/secret-key|secret-prompt|private-output|upstream_inference_cost/))
  globalThis.fetch = async () => new Response(JSON.stringify({ usage: { cost: 7 } }), { status: 429 })
  await trackedModelFetch('https://example.org/api', init, { caller: 'signal-vetting', model: 'direct' }, record)
  assert.equal(rows[1].reportedCostUsd, null); assert.equal(rows[1].status, 429)
  globalThis.fetch = async () => new Response('not JSON', { status: 502 })
  assert.equal(await (await trackedModelFetch('https://openrouter.ai/api/v1/chat/completions', init, { caller: 'nightly-review', model: 'm' }, record)).text(), 'not JSON')
  assert.equal(rows[2].reportedCostUsd, null)
  const failure = new Error('network failure')
  globalThis.fetch = async () => { throw failure }
  await assert.rejects(trackedModelFetch('https://openrouter.ai/api/v1/chat/completions', init, { caller: 'intelligence-critic', model: 'm' }, record), e => e === failure)
  assert.equal(rows[3].status, null); assert.equal(rows[3].reportedCostUsd, null)
  globalThis.fetch = async () => new Response('{"usage":{"cost":0}}')
  const warn = console.warn; console.warn = () => {}
  try { assert.equal((await trackedModelFetch('https://openrouter.ai/api/v1/chat/completions', init, { caller: 'hunch-incumbent', model: 'm' }, () => { throw new Error('disk full') })).status, 200) }
  finally { console.warn = warn }
  await trackedModelFetch('https://openrouter.ai/api/v1/chat/completions', init, { caller: 'hunch-incumbent', model: 'm' }, record)
  const groups = summarizeModelUsage([...rows, rows[0]])
  assert.equal(groups.reduce((s, g) => s + g.calls, 0), 5)
  assert.equal(groups.reduce((s, g) => s + g.reportedCostUsd, 0), 0.0123)
  assert.equal(groups.reduce((s, g) => s + g.unknownCostCalls, 0), 3)
  assert.equal(groups.reduce((s, g) => s + g.failures, 0), 3)
  assert.throws(() => summarizeModelUsage([...rows, { ...rows[0], reportedCostUsd: 8 }]), /Conflicting/)
  assert.throws(() => summarizeModelUsage([{ ...rows[0], timestamp: NaN }]), /Invalid/)
  console.log('model usage: response preservation, no retries, privacy, pricing coverage, failure isolation and identity checks passed')
}
main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => { globalThis.fetch = original })
