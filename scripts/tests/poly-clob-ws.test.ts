/**
 * Polymarket CLOB WebSocket frame folding (§131). Pure function, measured message shapes of 2026-09-19.
 * Run: npm run test:polyws
 */
import assert from 'node:assert/strict'
import { applyClobFrame, type PolyTop } from '../../src/main/services/polyClobWs'

const T = '9621762293674278807667061944453282812098972321669142760299674177938146661562'
const U = '1122378672469233552878390081071403655063804332509398717328554802929054467089'
const tops = new Map<string, PolyTop>()

// The first frame is an ARRAY of full books.
let r = applyClobFrame(tops, [{ market: '0x89', asset_id: T, timestamp: '1', hash: 'h', event_type: 'book', bids: [{ price: '0.01', size: '5' }, { price: '0.46', size: '10' }], asks: [{ price: '0.99', size: '1' }, { price: '0.47', size: '3' }] }], 1000)
assert.deepEqual(r, { books: 1, priceChanges: 0 })
assert.deepEqual(tops.get(T), { bid: 0.46, ask: 0.47, at: 1000, changes: 0 }, 'book snapshot sets the top from the best levels')

// price_change frames carry best_bid / best_ask per asset; an unchanged top is not a change.
r = applyClobFrame(tops, { market: '0x89', event_type: 'price_change', timestamp: '2', price_changes: [{ asset_id: T, price: '0.43', size: '595', side: 'BUY', hash: 'x', best_bid: '0.46', best_ask: '0.47' }] }, 2000)
assert.deepEqual(r, { books: 0, priceChanges: 1 })
assert.deepEqual(tops.get(T), { bid: 0.46, ask: 0.47, at: 2000, changes: 0 }, 'same top: refreshed time, no change counted')
r = applyClobFrame(tops, { price_changes: [{ asset_id: T, price: '0.46', size: '0', side: 'BUY', best_bid: '0.45', best_ask: '0.47' }, { asset_id: U, price: '0.5', size: '1', side: 'SELL', best_bid: '0.52', best_ask: '0.54' }] }, 3000)
assert.deepEqual(r, { books: 0, priceChanges: 2 })
assert.deepEqual(tops.get(T), { bid: 0.45, ask: 0.47, at: 3000, changes: 1 }, 'a moved bid counts one change')
assert.deepEqual(tops.get(U), { bid: 0.52, ask: 0.54, at: 3000, changes: 1 }, 'an unseen asset seeded by a price_change counts its first top as a change')

// Garbage is ignored, never thrown.
r = applyClobFrame(tops, 'PONG', 4000)
assert.deepEqual(r, { books: 0, priceChanges: 0 })
r = applyClobFrame(tops, { price_changes: [{ asset_id: T, best_bid: 'x', best_ask: '0.5' }] }, 4000)
assert.deepEqual(r, { books: 0, priceChanges: 0 })
assert.equal(tops.get(T)!.at, 3000, 'a malformed change leaves the top alone')
r = applyClobFrame(tops, { asset_id: T, event_type: 'book', bids: [], asks: [{ price: '0.5', size: '1' }] }, 5000)
assert.deepEqual(r, { books: 0, priceChanges: 0 }, 'a one-sided book is not a top')

console.log('poly-clob-ws: all assertions passed')
