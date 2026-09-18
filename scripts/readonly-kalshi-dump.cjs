// READ-ONLY Kalshi account dump (GET only). Writes JSON to the scratchpad.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { cursorPages } = require('./cursor-pages.cjs');
app.setPath('userData', path.join(app.getPath('appData'), 'oracle-trader'));
const OUT = process.argv[process.argv.length - 1].endsWith('.json') ? process.argv[process.argv.length - 1] : 'kalshi_dump.json';
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function dec(v) { if (!v) return ''; if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); return v.replace(/^plain:/, ''); }
app.whenReady().then(async () => {
  const out = { at: new Date().toISOString() };
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
    if (cfg.kalshiDemo) throw new Error('app configured for demo; refusing');
    const keyId = dec(cfg.kalshiApiKeyId);
    const pk = dec(cfg.kalshiPrivateKey).replace(/\\n/g, '\n');
    async function get(p) {
      const abs = '/trade-api/v2' + p.split('?')[0];
      for (let attempt = 0; attempt < 5; attempt++) {
        const ts = String(Date.now());
        const sig = crypto.sign('sha256', Buffer.from(ts + 'GET' + abs), { key: pk, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }).toString('base64');
        const r = await fetch(BASE + p, { signal: AbortSignal.timeout(30000), headers: { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sig } });
        if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
        const text = await r.text();
        if (!r.ok) throw new Error(`GET ${p} -> ${r.status}: ${text.slice(0, 300)}`);
        return text ? JSON.parse(text) : {};
      }
      throw new Error('429 persisted for ' + p);
    }
    if (process.argv.includes('--limits-only')) {
      out.limits = await get('/account/limits');
      out.costs = await get('/account/endpoint_costs');
      out.complete = true;
      console.log(JSON.stringify(out));
      return;
    }
    async function paged(p, key) {
      const page = await cursorPages(get, p, key, () => sleep(400));
      (out.pagination ??= {})[`${p}#${key}`] = { pages: page.pages, rows: page.rows.length, complete: true };
      return page.rows;
    }
    out.balance = await get('/portfolio/balance'); await sleep(300);
    out.positions = await paged('/portfolio/positions?count_filter=position', 'market_positions'); await sleep(300);
    out.event_positions = await paged('/portfolio/positions?count_filter=position', 'event_positions'); await sleep(300);
    out.resting = await paged('/portfolio/orders?status=resting', 'orders'); await sleep(300);
    out.settlements = await paged('/portfolio/settlements', 'settlements'); await sleep(300);
    out.fills = await paged('/portfolio/fills', 'fills'); await sleep(300);
    out.orders_all = await paged('/portfolio/orders', 'orders');
    // Older executed/canceled orders can move behind Kalshi's historical cutoff.
    out.orders_historical = await paged('/historical/orders', 'orders');
    out.orders_all = [...new Map([...out.orders_historical, ...out.orders_all].map(o => [o.order_id, o])).values()];
    out.complete = true;
    console.log(`OK balance=${JSON.stringify(out.balance)} positions=${out.positions.length} resting=${out.resting.length} settlements=${out.settlements.length} fills=${out.fills.length} orders=${out.orders_all.length}`);
  } catch (e) {
    out.complete = false;
    out.error = String(e && e.stack || e);
    console.error('DUMP_ERR', out.error);
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    app.quit();
  }
});
