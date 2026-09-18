const fs = require('fs');
let code = fs.readFileSync('G:/PROJECTS/oracle-trader/src/main/strategies/autoTrader.ts', 'utf8');

// Replace quoterCfg and add the correct typed helpers
const oldMethods = `  private quoterCfg(): import('./quoter').QuoterConfig {
    const cfg = this.config as unknown as Partial<import('./quoter').QuoterConfig>
    return { quoterEnabled: cfg.quoterEnabled ?? true, quoterCategory: cfg.quoterCategory ?? 'Climate and Weather', quoterSeriesRegex: cfg.quoterSeriesRegex ?? '^KX(HIGH|LOW)', quoterMinSpreadCents: cfg.quoterMinSpreadCents ?? 3, quoterMaxSpreadCents: cfg.quoterMaxSpreadCents ?? 20, quoterMaxTouchDepth: cfg.quoterMaxTouchDepth ?? 50, quoterMaxContracts: cfg.quoterMaxContracts ?? 3, quoterMaxMarkets: cfg.quoterMaxMarkets ?? 10, quoterMaxExposure: cfg.quoterMaxExposure ?? 20, quoterMaxInventory: cfg.quoterMaxInventory ?? 3, quoterCancelMinutes: cfg.quoterCancelMinutes ?? 60, quoterMinHoursToClose: cfg.quoterMinHoursToClose ?? 3, quoterMaxHoursToClose: cfg.quoterMaxHoursToClose ?? 48, amountPerTrade: this.config.amountPerTrade }
  }`;

const newMethods = `  private quoterCfg(): import('./quoter').QuoterConfig {
    const cfg = this.config as unknown as Partial<import('./quoter').QuoterConfig>
    return {
      quoterEnabled: cfg.quoterEnabled ?? true,
      quoterCategory: cfg.quoterCategory ?? 'Climate and Weather',
      quoterSeriesRegex: cfg.quoterSeriesRegex ?? '^KX(HIGH|LOW)',
      quoterMinSpreadCents: cfg.quoterMinSpreadCents ?? 3,
      quoterMaxSpreadCents: cfg.quoterMaxSpreadCents ?? 20,
      quoterMaxTouchDepth: cfg.quoterMaxTouchDepth ?? 50,
      quoterMaxContracts: cfg.quoterMaxContracts ?? 3,
      quoterMaxMarkets: cfg.quoterMaxMarkets ?? 10,
      quoterMaxExposure: cfg.quoterMaxExposure ?? 20,
      quoterMaxInventory: cfg.quoterMaxInventory ?? 3,
      quoterCancelMinutes: cfg.quoterCancelMinutes ?? 60,
      quoterMinHoursToClose: cfg.quoterMinHoursToClose ?? 3,
      quoterMaxHoursToClose: cfg.quoterMaxHoursToClose ?? 48,
      amountPerTrade: this.config.amountPerTrade
    }
  }

  private dutchCfg(): import('./dutchBook').DutchBookConfig {
    return {
      dutchEnabled: true,
      dutchLiveEnabled: this.config.liveArmed,
      dutchMinEdgeCents: 1.5,
      dutchMaxLegs: 8,
      dutchMaxBasketSpend: 15.0,
      dutchRequireExhaustive: false
    }
  }

  private convergenceCfg(): import('./cryptoConvergence').CryptoConvergenceConfig {
    return {
      convergenceEnabled: true,
      convergenceLiveEnabled: this.config.liveArmed,
      convergenceSeries: ['KXBTCD', 'KXETHD', 'KXSOLD', 'KXXRPD'],
      convergenceMinMarginPct: 0.2,
      convergenceMaxMarginPct: 0.6,
      convergenceMinEdgeCents: 1.0,
      convergenceMinCostCents: 60,
      convergenceMaxCostCents: 88,
      convergenceMaxContractsPerTrade: 2,
      convergenceMaxOpenTrades: 4,
      convergenceTradeHorizonMinMinutes: 2,
      convergenceTradeHorizonMaxMinutes: 6
    }
  }

  private leadLagCfg(): import('./leadLag').LeadLagConfig {
    return {
      leadLagEnabled: true,
      leadLagLiveEnabled: this.config.liveArmed,
      leadLagMinDislocationCents: 4.0,
      leadLagMaxSpreadCents: 5.0,
      leadLagMaxContractsPerOrder: 2,
      leadLagMaxCapitalSpend: 15.0,
      pollIntervalMs: 15000
    }
  }`;

code = code.replace(oldMethods, newMethods);

// Also remove duplicate getQuantStatus at line ~553
const dupMethod = `  private quoterCfg() {
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

code = code.replace(dupMethod, '');
fs.writeFileSync('G:/PROJECTS/oracle-trader/src/main/strategies/autoTrader.ts', code, 'utf8');
console.log('autoTrader.ts cleaned up successfully');
