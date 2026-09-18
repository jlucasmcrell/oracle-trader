// READ-ONLY Polymarket US account dump (GET only).
const { app, safeStorage } = require('electron');
const fs = require('fs'); const crypto = require('crypto'); const path = require('path');
app.setPath('userData', path.join(app.getPath('appData'), 'oracle-trader'));
const PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const OUT = process.argv[process.argv.length - 1];
function dec(v) { if (!v) return ''; if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); return v.replace(/^plain:/, ''); }
app.whenReady().then(async () => {
  const out = { at: new Date().toISOString() };
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
    const id = dec(cfg.polymarketUsApiKeyId), secret = dec(cfg.polymarketUsPrivateKey);
    const seed = Buffer.from(secret, 'base64').subarray(0, 32);
    const key = crypto.createPrivateKey({ key: Buffer.concat([PREFIX, seed]), format: 'der', type: 'pkcs8' });
    async function get(p) {
      const ts = String(Date.now()); const msg = ts + 'GET' + p.split('?')[0];
      const sig = crypto.sign(null, Buffer.from(msg), key).toString('base64');
      const r = await fetch('https://api.polymarket.us' + p, { headers: { 'X-PM-Access-Key': id, 'X-PM-Timestamp': ts, 'X-PM-Signature': sig } });
      const t = await r.text(); if (!r.ok) throw new Error(`GET ${p} -> ${r.status}: ${t.slice(0, 300)}`); return t ? JSON.parse(t) : {};
    }
    const tryGet = async (k, p) => { for (let i=0;i<3;i++){ try { out[k] = await get(p); return; } catch (e) { out[k+'_error']=String(e.message||e); await new Promise(r=>setTimeout(r,1500)); } } };
    await tryGet('balances','/v1/account/balances');
    await tryGet('positions','/v1/portfolio/positions');
    await tryGet('open','/v1/orders/open?limit=500');
    // The venue returns at most 20 activities per page: follow nextCursor to eof (40 pages max),
    // otherwise a busy day's resolutions are undercounted (2026-09-07).
    const paged = async (k, base) => {
      const acc = []; let cursor = ''; let done = false;
      try {
        for (let page = 0; page < 40 && !done; page++) {
          let d;
          for (let attempt = 0; ; attempt++) {
            try { d = await get(base + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')); break; }
            catch (e) { if (attempt >= 4 || !/-> 429/.test(String(e.message || e))) throw e; await new Promise(r => setTimeout(r, 3000 * (attempt + 1))); }
          }
          acc.push(...(d.activities || []));
          if (d.eof || !d.nextCursor || (d.activities || []).length === 0) { done = true; break; }
          cursor = d.nextCursor; await new Promise(r => setTimeout(r, 700));
        }
        out[k] = { activities: acc, pages: done ? 'complete' : 'partial' };
      } catch (e) { out[k] = { activities: acc, pages: 'partial' }; out[k+'_error'] = String(e.message || e); }
    };
    await paged('activities','/v1/portfolio/activities?limit=500&sortOrder=SORT_ORDER_DESCENDING&types=ACTIVITY_TYPE_TRADE');
    await paged('activities_all','/v1/portfolio/activities?limit=500&sortOrder=SORT_ORDER_DESCENDING');
    console.log('OK');
  } catch (e) { out.error = String(e && e.stack || e); console.error('DUMP_ERR', out.error); }
  finally { fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); app.quit(); }
});
