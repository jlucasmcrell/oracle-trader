import assert from 'node:assert/strict'

// Captured shape: 14 YES + 13 NO contracts, with only the final net payout
// in settlement revenue. The 13 automatically paired contracts return $13.
const row = {
  yes_count_fp: '14', no_count_fp: '13',
  yes_total_cost_dollars: '8.40', no_total_cost_dollars: '5.20',
  revenue: 100, fee_cost: '0.01'
}
const n = (v) => Number(v ?? 0)
const yes = n(row.yes_count_fp), no = n(row.no_count_fp)
const cost = n(row.yes_total_cost_dollars) + n(row.no_total_cost_dollars)
const settlementRevenue = n(row.revenue) / 100
const pairedRevenue = Math.min(yes, no)
const pnl = settlementRevenue + pairedRevenue - cost - n(row.fee_cost)
assert.equal(pairedRevenue, 13)
assert.ok(Math.abs(pnl - 0.39) < 1e-9, `expected $0.39, got $${pnl}`)
console.log('settlement accounting regression: PASS')
