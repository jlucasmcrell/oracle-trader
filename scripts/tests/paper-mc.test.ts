/**
 * Regression tests for the A1/A2 multi-outcome paper-position defects
 * (see docs/AUDIT-BUGS-2026-09-18.md).
 *
 * A paper position is keyed on `marketId : outcome : answerId`. The BUY half of
 * the multi-outcome feature was finished, but sell, settle and getPositions each
 * dropped `answerId` on a different leg, so a multi-outcome position could be
 * bought and then never sold or settled: the sell threw "No paper position to
 * sell", settle returned null (payout never credited, position never deleted)
 * and getPositions hid the field the UI needed to repair the lookup.
 *
 * Nothing in the suite referenced `answerId` at all, which is exactly why this
 * survived. These tests pin the identity contract on every leg.
 *
 * Pure logic; no network, no Electron. Run: npm run test:paper-mc
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PaperBroker } from '../../src/main/engine/paper'
import type { OrderRequest, PriceQuote } from '../../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'oracle-paper-mc-'))
let seq = 0

const quote = (outcome: string, price: number): PriceQuote => ({
  venue: 'polymarket-us',
  marketId: 'm1',
  outcome,
  price,
  probability: price,
  timestamp: Date.now()
})

const buyReq = (outcome: string, answerId: string, amount: number): OrderRequest => ({
  venue: 'polymarket-us',
  marketId: 'm1',
  marketQuestion: 'Who wins?',
  outcome,
  answerId,
  amount
})

/** A broker plus the state path it persists to. */
function fresh(): { broker: PaperBroker; path: string } {
  const path = join(root, `paper-${++seq}.json`)
  return { broker: new PaperBroker('polymarket-us', 'USD', 1000, path), path }
}

async function main(): Promise<void> {
  // 1. buy keys on answerId, and the identity is visible to the caller.
  {
    const { broker } = fresh()
    const res = broker.buy(buyReq('Team B', 'a2', 10), quote('Team B', 0.5))
    assert.equal(res.shares, 20)
    assert.equal(res.fee, 0, 'a market without a feeRate is fee-free in paper')

    const pos = broker.getPositions()
    assert.equal(pos.length, 1)
    assert.equal(pos[0].answerId, 'a2', 'A1: getPositions must surface answerId or the UI cannot round-trip it')
    assert.equal(pos[0].outcome, 'Team B')
    assert.equal(broker.getPositionShares('m1', 'Team B', 'a2'), 20)
    // The binary key is a DIFFERENT position: identity is (market, outcome, answer).
    assert.equal(broker.getPositionShares('m1', 'Team B'), 0)
  }

  // 2. A2: settling without answerId MISSES. This is the vanishing stake: before
  // the fix the position was unreachable at settlement, so the payout was never
  // credited and the position was never removed.
  {
    const { broker } = fresh()
    broker.buy(buyReq('Team B', 'a2', 10), quote('Team B', 0.5))
    assert.equal(broker.settle('m1', 'Team B', 1), null, 'settling without answerId must not find the position')
    assert.equal(broker.getPositions().length, 1, 'a miss must leave the position intact, not consume it')

    const s = broker.settle('m1', 'Team B', 1, 'a2')
    assert.notEqual(s, null)
    assert.equal(s!.shares, 20)
    assert.equal(s!.realizedPnl, 10)
    assert.equal(broker.getPositions().length, 0)
    assert.equal(broker.getAccount().balance, 1010, '990 after the buy, +20 payout')
  }

  // 3. A losing answer is accounted as a full loss, not silently dropped.
  {
    const { broker } = fresh()
    broker.buy(buyReq('Team A', 'a1', 10), quote('Team A', 0.4))
    assert.equal(broker.getAccount().balance, 990)
    const s = broker.settle('m1', 'Team A', 0, 'a1')
    assert.notEqual(s, null)
    assert.equal(s!.realizedPnl, -10, 'the whole stake is a realized loss')
    assert.equal(broker.getAccount().balance, 990, 'a 0 payout credits nothing')
    assert.equal(broker.getPositions().length, 0)
  }

  // 4. Two answers on one market coexist and settle independently.
  {
    const { broker } = fresh()
    broker.buy(buyReq('Team A', 'a1', 10), quote('Team A', 0.4))
    broker.buy(buyReq('Team B', 'a2', 10), quote('Team B', 0.4))
    assert.equal(broker.getPositions().length, 2)
    broker.settle('m1', 'Team A', 0, 'a1')
    assert.equal(broker.getPositions().length, 1, 'the other answer must survive its sibling settling')
    assert.equal(broker.getPositions()[0].answerId, 'a2')
  }

  // 5. Sell works once the request carries answerId (the engine already passes it;
  // the renderer did not).
  {
    const { broker } = fresh()
    broker.buy(buyReq('Team B', 'a2', 10), quote('Team B', 0.5))
    assert.equal(broker.getPositionShares('m1', 'Team B', 'a2'), 20)
    const res = broker.sell(
      { venue: 'polymarket-us', marketId: 'm1', outcome: 'Team B', answerId: 'a2' },
      quote('Team B', 0.6)
    )
    assert.equal(res.shares, 20)
    assert(Math.abs(res.realizedPnl - 2) < 1e-9, '(0.6 - 0.5) * 20 is float-inexact; compare with tolerance')
    assert.equal(broker.getPositions().length, 0)
  }

  // 5b. It still throws if the caller omits answerId, so the failure is loud
  // rather than silently selling the wrong thing.
  {
    const { broker } = fresh()
    broker.buy(buyReq('Team B', 'a2', 10), quote('Team B', 0.5))
    assert.throws(
      () => broker.sell({ venue: 'polymarket-us', marketId: 'm1', outcome: 'Team B' }, quote('Team B', 0.6)),
      /No paper position to sell/,
      'an answer-scoped position must not be sellable via the binary key'
    )
    assert.equal(broker.getPositions().length, 1, 'the failed sell must not mutate the position')
  }

  // 6. The answer identity survives a restart and is still settleable.
  {
    const { broker, path } = fresh()
    broker.buy(buyReq('Team B', 'a2', 10), quote('Team B', 0.5))
    const reloaded = new PaperBroker('polymarket-us', 'USD', 1000, path)
    const pos = reloaded.getPositions()
    assert.equal(pos.length, 1)
    assert.equal(pos[0].answerId, 'a2', 'the answer identity must persist across a restart')
    assert.notEqual(reloaded.settle('m1', 'Team B', 1, 'a2'), null, 'and must still settle after a restart')
  }

  // 7. Source invariant for the leg no unit test can reach: the renderer must
  // keep sending answerId on sell, or a multi-outcome position is unsellable
  // again. This is the half that broke, and it had no coverage whatsoever.
  {
    const app = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
    assert(
      app.includes('answerId: pos.answerId'),
      'A1: the renderer sell call must pass pos.answerId (a multi-outcome position is otherwise unsellable)'
    )
    const engine = readFileSync(join(process.cwd(), 'src', 'main', 'engine', 'engine.ts'), 'utf8')
    assert(
      engine.includes('broker.settle(marketId, outcome, winPrice, answerId)'),
      'A2: the engine must forward answerId to the broker - that parameter is optional, so tsc cannot catch its removal'
    )
  }

  console.log(
    'Paper multi-outcome passed: answerId keying on buy/sell/settle/getPositions, independent sibling answers, ' +
      'loud failure on a binary-key sell, restart persistence, the renderer sell invariant, and the engine forwarding invariant'
  )
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
