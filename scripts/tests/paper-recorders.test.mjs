// The rules of the two paper tests registered 2026-11-12, asserted on hand-built rows: what counts as a late-game
// entry (docs/PREREGISTERED-lategame.md) and what counts as a fill of a resting paper bid in a new market
// (docs/PREREGISTERED-newmarket-bid.md). A grader that is generous here manufactures an edge that is not there.
import assert from 'node:assert/strict'
import { entryOf, fee1, band } from '../lategame-gate.mjs'
import { matchKalshi, matchPoly } from '../lategame-shadow.mjs'
import { orderOf, filled, makerFee1 } from '../newmarket-gate.mjs'

// ---- late game ----
const row = (o = {}) => ({ st: 'in', lg: 'nba', per: 4, sa: 98, sh: 90, ka: { t: 'K-AWAY', b: 0.8, a: 0.82, as: 50 }, kh: { t: 'K-HOME', b: 0.18, a: 0.2, as: 50 }, pa: { b: 0.87, a: 0.88 }, ...o })
assert.deepEqual(entryOf(row()), { t: 'K-AWAY', px: 0.82, gated: true, side: 'ka' }, 'the leader at Kalshi\'s ask; Polymarket 5.5c ahead passes the gate')
assert.equal(entryOf(row({ pa: { b: 0.84, a: 0.85 } })).gated, false, 'Polymarket 2.5c ahead is a blind entry only')
assert.equal(entryOf(row({ pa: null })).gated, false, 'no Polymarket book: blind only')
assert.equal(entryOf(row({ pa: { b: 0.8, a: 0.96 } })).gated, false, 'a Polymarket spread over 5c is not a price')
assert.equal(entryOf(row({ per: 3 })), null, 'the third quarter is not late')
assert.equal(entryOf(row({ lg: 'nhl', per: 3 }))?.t, 'K-AWAY', 'the third period is hockey\'s last')
assert.equal(entryOf(row({ per: 5 }))?.t, 'K-AWAY', 'overtime counts')
assert.equal(entryOf(row({ sa: 90, sh: 90 })), null, 'a tie has no leader')
assert.equal(entryOf(row({ st: 'post' })), null, 'a finished game is not an entry')
assert.equal(entryOf(row({ ka: { t: 'K-AWAY', b: 0.95, a: 0.96, as: 50 } })), null, 'over 95c is out of range')
assert.equal(entryOf(row({ ka: { t: 'K-AWAY', b: 0.6, a: 0.69, as: 50 } })), null, 'under 70c is out of range')
assert.equal(entryOf(row({ ka: { t: 'K-AWAY', b: 0.8, a: 0.82, as: 0 } })), null, 'nothing offered is not a price')
const home = entryOf(row({ sa: 80, sh: 90, kh: { t: 'K-HOME', b: 0.8, a: 0.82, as: 5 }, pa: { b: 0.12, a: 0.13 } }))
assert.deepEqual([home.t, home.gated], ['K-HOME', true], 'the home leader reads Polymarket\'s away price from the other side')
assert.deepEqual([fee1(0.82), fee1(0.95), fee1(0.5)], [2, 1, 2], 'one contract pays the taker fee rounded up to a whole cent')

const g = { start: Date.parse('2026-11-13T00:00:00Z'), away: { abbr: 'SAS', name: 'Spurs', loc: 'San Antonio' }, home: { abbr: 'LAL', name: 'Lakers', loc: 'Los Angeles' } }
const ev = (a, h, exp) => [{ ticker: `X-${a}`, code: a, sub: a === 'SAS' ? 'San Antonio' : 'Los Angeles L', exp }, { ticker: `X-${h}`, code: h, sub: 'Los Angeles L', exp }]
assert.deepEqual(matchKalshi(g, [ev('SAS', 'LAL', Date.parse('2026-11-13T03:00:00Z'))]), { away: 'X-SAS', home: 'X-LAL' })
assert.equal(matchKalshi(g, [ev('SAS', 'LAL', Date.parse('2026-11-15T03:00:00Z'))]), null, 'the same matchup two days later is another game')
const poly = [{ slug: 'nba-sas-lal', names: ['lakers', 'spurs'], tokens: ['T-LAL', 'T-SAS'], start: g.start + 600_000 }]
assert.deepEqual(matchPoly(g, poly), { slug: 'nba-sas-lal', awayToken: 'T-SAS' }, 'the away team\'s token, whatever order Polymarket lists them in')
assert.equal(matchPoly({ ...g, start: g.start + 86_400_000 }, poly), null)

const b = band([{ day: 'a', c: 10 }, { day: 'a', c: -10 }, { day: 'b', c: 4 }, { day: 'b', c: 4 }])
assert.equal(b.mean, 2); assert.ok(b.lo < 2 && b.hi > 2 && b.days === 2)

// ---- new markets ----
assert.deepEqual(orderOf({ yb: 0.85, ybs: 30, nb: 0.1, nbs: 40 }), { side: 'no', px: 0.1, ahead: 40 }, 'YES offered at 90c: join the 10c NO bid behind its 40')
assert.deepEqual(orderOf({ yb: 0.08, ybs: 12, nb: 0.5, nbs: 40 }), { side: 'yes', px: 0.08, ahead: 12 }, 'NO offered at 92c: join the 8c YES bid')
assert.equal(orderOf({ yb: 0.01, ybs: 5, nb: 0.04, nbs: 40 }), null, 'a 96c ask is out of range')
assert.equal(orderOf({ yb: 0.4, ybs: 5, nb: 0.4, nbs: 40 }), null)
assert.equal(orderOf({ yb: null, ybs: 0, nb: null, nbs: 0 }), null, 'an empty book calls for nothing')
const o = { side: 'no', px: 0.1, ahead: 40 }, T = Date.parse('2026-11-12T12:00:00Z'), at = (s) => new Date(T + s * 1000).toISOString()
const buyYes = (s, yes, n) => ({ ts: at(s), yes, n, side: 'yes' })
assert.equal(filled(o, [buyYes(10, 0.9, 40)], T, T + 3600_000), false, 'prints that only clear the size ahead of us do not fill us')
assert.equal(filled(o, [buyYes(10, 0.9, 25), buyYes(20, 0.9, 16)], T, T + 3600_000), true, 'prints at our price for more than the size ahead do')
assert.equal(filled(o, [buyYes(10, 0.91, 1)], T, T + 3600_000), true, 'a print through our price fills us')
assert.equal(filled(o, [buyYes(10, 0.89, 500)], T, T + 3600_000), false, 'a print short of our price does not')
assert.equal(filled(o, [{ ts: at(10), yes: 0.91, n: 500, side: 'no' }], T, T + 3600_000), false, 'a taker buying OUR side is not selling to us')
assert.equal(filled(o, [buyYes(-5, 0.91, 1)], T, T + 3600_000), false, 'a print before the order rested is not ours')
assert.equal(filled(o, [buyYes(3700, 0.91, 1)], T, T + 3600_000), false, 'a print after the cancel is not ours')
assert.equal(filled({ side: 'yes', px: 0.08, ahead: 12 }, [{ ts: at(10), yes: 0.07, n: 1, side: 'no' }], T, T + 3600_000), true, 'the YES-side mirror')
assert.deepEqual([makerFee1(0.1, 'quadratic', 1), makerFee1(0.1, 'quadratic_with_maker_fees', 1), makerFee1(0.5, 'quadratic_with_maker_fees', 2)], [0, 1, 1], 'a maker pays only where the series charges makers')

console.log('paper-recorders: all assertions passed')
