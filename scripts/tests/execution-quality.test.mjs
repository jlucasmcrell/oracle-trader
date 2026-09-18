import assert from 'node:assert/strict'
import { executionQuality } from '../execution-quality-report.mjs'
const one = { clientOrderId: 'one', venue: 'kalshi', marketId: 'M', requestedAt: 100, submittedAt: 110, acknowledgedAt: 160, orderId: 'order', state: 'acknowledged', ref: 'leadlag', version: 'v1' }
const two = { ...one, clientOrderId: 'two', orderId: 'other', requestedAt: 200, submittedAt: 220, acknowledgedAt: 300 }
const fill = { id: 'a', orderId: 'order', venue: 'kalshi', shares: 0.5 }
const report = executionQuality([{ ...one, state: 'pending' }, one, two], [fill, fill, { ...fill, id: 'b', shares: 0.25 }])
assert.equal(report.journalOrders, 2); assert.equal(report.archivedExecutions, 2)
const g = report.groups[0]
assert.equal(g.ordersWithRecordedFills, 1); assert.equal(g.matchedShares, 0.75)
assert.equal(g.intentToSubmitRequest.medianMs, 15)
assert.equal(g.submitRequestToAcknowledgementOrRecovery.medianMs, 65)
assert.equal(g.submitRequestToAcknowledgementOrRecovery.p95Ms, 80)
const anomaly = executionQuality([{ ...one, submittedAt: 99 }], []).groups[0]
assert.equal(anomaly.timingAnomalies, 1); assert.equal(anomaly.intentToSubmitRequest.n, 0)
assert.throws(() => executionQuality([one, { ...one, marketId: 'conflict' }], []), /Conflicting order/)
assert.throws(() => executionQuality([one], [fill, { ...fill, shares: 9 }]), /Conflicting execution/)
assert.throws(() => executionQuality([one, { ...two, orderId: one.orderId }], [fill]), /Ambiguous exchange order/)
assert.equal(executionQuality([{ ...one, submittedAt: undefined, acknowledgedAt: undefined, state: 'pending' }], []).groups[0].pending, 1)
console.log('execution quality: partial fills, identity conflicts, pending orders, timing summaries and clock anomalies passed')
