const fs = require('fs');
let code = fs.readFileSync('G:/PROJECTS/oracle-trader/src/main/strategies/autoTrader.ts', 'utf8');

const target = `  private leadLagCfg(): import('./leadLag').LeadLagConfig {
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

const replacement = `  private leadLagCfg(): import('./leadLag').LeadLagConfig {
    return {
      leadLagEnabled: true,
      leadLagLiveEnabled: this.config.liveArmed,
      leadLagMinDislocationCents: 4.0,
      leadLagMaxSpreadCents: 5.0,
      leadLagMaxContractsPerOrder: 2,
      leadLagMaxCapitalSpend: 15.0,
      pollIntervalMs: 15000
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

code = code.replace(target, replacement);
fs.writeFileSync('G:/PROJECTS/oracle-trader/src/main/strategies/autoTrader.ts', code, 'utf8');
console.log('autoTrader.ts getQuantStatus exported successfully');
