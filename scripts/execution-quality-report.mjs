import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function timing(values) {
  const sorted = values.slice().sort((a, b) => a - b), n = sorted.length
  return { n, medianMs: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    p95Ms: n ? sorted[Math.ceil(n * 0.95) - 1] : null, maxMs: n ? sorted[n - 1] : null }
}

export function executionQuality(journal, fills) {
  const orders = new Map(), executions = new Map(), byOrder = new Map()
  for (const row of journal) {
    if (!row.clientOrderId || !row.venue || !row.marketId || !Number.isFinite(row.requestedAt) || !['pending', 'acknowledged', 'rejected'].includes(row.state)) throw new Error('Invalid order journal row')
    const previous = orders.get(row.clientOrderId)
    if (previous && ['venue', 'marketId', 'requestedAt', 'side', 'outcome', 'version'].some(k => previous[k] !== row[k])) throw new Error('Conflicting order identity')
    orders.set(row.clientOrderId, row)
  }
  for (const fill of fills) {
    if (!fill.id || !fill.venue || !Number.isFinite(fill.shares) || fill.shares <= 0) throw new Error('Invalid execution row')
    const key = `${fill.venue}:${fill.id}`, prior = executions.get(key)
    if (prior) { if (JSON.stringify(prior) !== JSON.stringify(fill)) throw new Error('Conflicting execution identity'); continue }
    executions.set(key, fill)
    if (fill.orderId) {
      const key = `${fill.venue}:${fill.orderId}`, list = byOrder.get(key) ?? []
      list.push(fill); byOrder.set(key, list)
    }
  }
  const groups = new Map(), orderOwners = new Map()
  for (const order of orders.values()) {
    if (order.orderId) {
      const exchangeKey = `${order.venue}:${order.orderId}`
      if (orderOwners.has(exchangeKey)) throw new Error('Ambiguous exchange order mapping')
      orderOwners.set(exchangeKey, order.clientOrderId)
    }
    const key = JSON.stringify([order.venue, order.ref ?? 'unattributed', order.version ?? 'unknown'])
    const g = groups.get(key) ?? { venue: order.venue, strategy: order.ref ?? 'unattributed', version: order.version ?? 'unknown',
      orders: 0, acknowledged: 0, pending: 0, rejected: 0, ordersWithRecordedFills: 0, matchedExecutions: 0, matchedShares: 0, timingAnomalies: 0, preparation: [], acknowledgement: [] }
    g.orders++; g[order.state]++
    for (const [from, to, target] of [[order.requestedAt, order.submittedAt, g.preparation], [order.submittedAt, order.acknowledgedAt, g.acknowledgement]]) {
      if (from === undefined || to === undefined) continue
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) { g.timingAnomalies++; continue }
      target.push(to - from)
    }
    const matched = order.orderId ? byOrder.get(`${order.venue}:${order.orderId}`) ?? [] : []
    if (matched.length) g.ordersWithRecordedFills++
    g.matchedExecutions += matched.length
    g.matchedShares += matched.reduce((s, f) => s + f.shares, 0)
    groups.set(key, g)
  }
  return { journalOrders: orders.size, archivedExecutions: executions.size,
    groups: [...groups.values()].map(({ preparation, acknowledgement, ...g }) => ({ ...g,
      intentToSubmitRequest: timing(preparation), submitRequestToAcknowledgementOrRecovery: timing(acknowledgement) })),
    limits: 'Live journal cohort only. Submission time precedes any HTTP queue wait; acknowledgement can be later recovery. No signal/source or actual network-dispatch timestamp is recorded, so these are not end-to-end or network latencies. No matched execution means no fill recorded yet, not proven cancellation. No strategy outcomes or held-out trials are graded.' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--dir')) throw new Error('Usage: node scripts/execution-quality-report.mjs [--dir APP_USER_DATA]')
  if (!args.length && !process.env.APPDATA) throw new Error('Supply --dir for app user data')
  const dir = args[1] ?? join(process.env.APPDATA, 'oracle-trader')
  const read = name => existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').split('\n').filter(s => s.trim()).map(s => JSON.parse(s)) : []
  const archiveFiles = ['kalshi', 'polymarket-us'].map(v => `fill-reconciler-${v}.json.fills.jsonl`)
  console.log(JSON.stringify({ at: new Date().toISOString(),
    missingFiles: ['order-journal.jsonl', ...archiveFiles].filter(n => !existsSync(join(dir, n))),
    ...executionQuality(read('order-journal.jsonl'), archiveFiles.flatMap(read)) }, null, 2))
}
