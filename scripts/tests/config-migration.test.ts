import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Module from 'node:module'
const home = mkdtempSync(join(tmpdir(), 'oracle-migration-'))
const loader = (Module as any)._load
const network = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Network forbidden') }
;(Module as any)._load = function (id: string, ...args: any[]) {
  if (id === 'electron') return { app: { getPath: () => home, getAppPath: () => home }, safeStorage: { isEncryptionAvailable: () => false } }
  if (id === '../services/liveSpot') return { liveSpotFeed: { start: () => {} } } // Configuration test has no market-data connection.
  return loader.call(this, id, ...args)
}
try {
  const { AutoTrader } = require('../../src/main/strategies/autoTrader')
  const file = join(home, 'auto.json')
  const first = new AutoTrader({}, file)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).configVersion, 27)
  first.setConfig({ maxOpenPositions: 7, enabled: false, autoPoll: false, bookLogging: false })
  const second = new AutoTrader({}, file)
  assert.equal(second.getConfig().maxOpenPositions, 7)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).configVersion, 27)

  // ---- v27 (2026-09-18): the fee-model fix ---------------------------------
  // netCentsOf() used to divide an already per-contract fee by the contract
  // count a second time. netSum/netSq/byEvent/byDay are running SUMS, so the
  // contaminated total cannot be filtered out later - v27 must clear it once,
  // while keeping every field the fee term never touched. Re-seed the file at
  // v26 with a populated calib block and re-open it.
  const seeded = JSON.parse(readFileSync(file, 'utf8'))
  seeded.configVersion = 26
  seeded.state.calib = {
    byStrategy: {
      fade: {
        n: 40,
        brierSum: 3.2,
        buckets: [{ n: 40, wins: 22, probSum: 12.5 }],
        netN: 40,
        netSum: 120,
        netSq: 900,
        byEvent: { E1: { n: 10, sum: 30 } },
        byDay: { '2026-09-01': { n: 10, sum: 30 } }
      },
      clean: { n: 5, brierSum: 1.1, buckets: [] } // never graded a settlement: but nothing accumulated
    },
    vetoWatch: [],
    vetoes: { graded: 0, wouldHaveWon: 0, estPnlCents: 0 }
  }
  writeFileSync(file, JSON.stringify(seeded))

  const third = new AutoTrader({}, file)
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.configVersion, 27)
  const s = after.state.calib.byStrategy.fade
  assert.equal(s.netN, undefined)
  assert.equal(s.netSum, undefined)
  assert.equal(s.netSq, undefined)
  assert.equal(s.byEvent, undefined)
  assert.equal(s.byDay, undefined)
  // every field the fee term never touched survives
  assert.equal(s.n, 40)
  assert.equal(s.brierSum, 3.2)
  assert.equal(s.buckets.length, 1)
  assert.equal(s.buckets[0].wins, 22)
  assert.equal(after.state.calib.byStrategy.clean.n, 5)
  // the operator's live setting survives the reset
  assert.equal(third.getConfig().maxOpenPositions, 7)
  console.log('config migration: version persisted, operator limit survives restart, v27 clears net-cents evidence only')
} finally {
  ;(Module as any)._load = loader
  globalThis.fetch = network
  rmSync(home, { recursive: true, force: true })
}
