import fs from 'node:fs'

const path = 'src/main/strategies/quoter.ts'
let text = fs.readFileSync(path, 'utf8')

// 1. Add import
if (!text.includes("from '../services/noaaMetar'")) {
  text = text.replace(
    "import type { OrderBook } from '../../shared/types'",
    "import type { OrderBook } from '../../shared/types'\nimport { metarService } from '../services/noaaMetar'"
  )
}

// 2. Add METAR refresh at top of tick()
if (!text.includes('await metarService.refreshStations()')) {
  text = text.replace(
    'const now = Date.now()\n      const series = await this.series(cfg)',
    'const now = Date.now()\n      await metarService.refreshStations().catch(() => undefined)\n      const series = await this.series(cfg)'
  )
}

// 3. Integrate deterministic METAR fair value
const targetBlock = `        // AS Reservation Price: r = fairValue - q * gamma * sigma^2 * tau`
const replacementBlock = `        // Deterministic NOAA METAR Evaluation for Weather Series
        if ((c.series.startsWith('KXHIGH') || c.series.startsWith('KXLOW')) && c.strike) {
          const metarCert = metarService.evaluateStrikeCertainty(c.series, c.strike)
          if (metarCert !== null) {
            // If strike is mathematically crossed by station observation, fair value snaps to 1.00
            fairValue = metarCert
          }
        }

        // AS Reservation Price: r = fairValue - q * gamma * sigma^2 * tau`

if (!text.includes('evaluateStrikeCertainty') && text.includes(targetBlock)) {
  text = text.replace(targetBlock, replacementBlock)
}

fs.writeFileSync(path, text)
console.log('quoter.ts successfully updated with NOAA METAR integration')
