const fs = require('fs');
let code = fs.readFileSync('G:/PROJECTS/oracle-trader/src/main/strategies/autoTrader.ts', 'utf8');

// Replace getQuantStatus
const oldMethod = `  getQuantStatus(): import('../../shared/ipc').QuantStatus {
    return {
      dutch: this.dutchEngine.status(this.dutchCfg()),
      convergence: this.convergenceEngine.status(this.convergenceCfg()),
      leadLag: this.leadLagEngine.status(this.leadLagCfg()),
      quoter: this.quoter.status(this.quoterCfg())
    }
  }`;

const newMethod = `  private quoterCfg() {
    return {
      enabled: true,
      seriesPattern: '^KX(HIGH|LOW)',
      maxSpreadCents: 12,
      minSpreadCents: 3,
      edgeInsideTouchCents: 1,
      orderSizeContracts: 1,
      maxInventoryPerMarket: 3,
      maxTotalExposureDollars: 20,
      autoCancelMinutesBeforeClose: 60,
      minMinutesToClose: 90,
      maxMinutesToClose: 2880
    }
  }

  private dutchCfg() {
    return {
      enabled: true,
      liveEnabled: false,
      minOverSum: 0.03,
      minEdgeCents: 1.0,
      maxLegSpreadCents: 10,
      minLegLiquidityDollars: 10,
      maxTotalLegs: 8,
      orderSizeDollars: 5,
      maxDailyBaskets: 10
    }
  }

  private convergenceCfg() {
    return {
      enabled: true,
      liveEnabled: false,
      minMarginPct: 0.2,
      maxMinutesToClose: 6,
      minMinutesToClose: 1,
      minEdgeCents: 1.0,
      orderSizeContracts: 1,
      maxDailyTrades: 20
    }
  }

  private leadLagCfg() {
    return {
      enabled: true,
      liveEnabled: false,
      minDislocationCents: 3.5,
      minPolySpreadCents: 4.0,
      orderSizeContracts: 1,
      maxDailySweeps: 20
    }
  }

  getQuantStatus(): import('../../shared/ipc').QuantStatus {
    return {
      dutch: this.dutchEngine.status(this.dutchCfg()),
      convergence: this.convergenceEngine.status(this.convergenceCfg()),
      leadLag: this.leadLagEngine.status(this.leadLagCfg()),
      quoter: this.quoter.status(this.quoterCfg())
    }
  }`;

code = code.replace(oldMethod, newMethod);
fs.writeFileSync('G:/PROJECTS/oracle-trader/src/main/strategies/autoTrader.ts', code, 'utf8');
console.log('autoTrader.ts patched successfully');
