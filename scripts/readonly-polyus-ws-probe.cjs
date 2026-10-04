// READ-ONLY Polymarket US market-data WebSocket probe: subscribes, listens, writes a summary. Places nothing.
//   npx electron scripts/readonly-polyus-ws-probe.cjs [seconds] [slug ...] <out.json>
// Default slugs: the current and next hourly "BTC Up or Down" markets. Alongside the stream it polls the public
// /bbo endpoint every 5 s, so the summary says how stale the public price is against the authenticated feed.
// Protocol (wss://api.polymarket.us/v1/ws/markets): Ed25519-signed X-PM-* headers on the upgrade, signing
// timestamp + 'GET' + '/v1/ws/markets'; frames {"subscribe":{"requestId","subscriptionType","marketSlugs"}}.
const { app, safeStorage } = require('electron');
const fs = require('fs'); const crypto = require('crypto'); const path = require('path');
const WebSocket = require('ws');
app.setPath('userData', path.join(app.getPath('appData'), 'oracle-trader'));
const PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function dec(v) { if (!v) return ''; if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); return v.replace(/^plain:/, ''); }
const args = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.endsWith('.cjs') && a !== '.');
const OUT = args.find((a) => a.endsWith('.json')) ?? 'polyus_ws_probe.json';
const SECONDS = Number(args.find((a) => /^\d+$/.test(a)) ?? 120);
function hourSlug(ms) { const d = new Date(ms); return `cpc-btc-updown-1h-${d.toISOString().slice(0, 10)}-${String(d.getUTCHours()).padStart(2, '0')}00z`; }
const given = args.filter((a) => a.includes('-') && !a.endsWith('.json'));
const SLUGS = given.length ? given : [hourSlug(Date.now()), hourSlug(Date.now() + 3600_000)];
const px = (a) => (a && a.value !== undefined ? Number(a.value) : undefined);
app.whenReady().then(async () => {
  const out = { at: new Date().toISOString(), seconds: SECONDS, slugs: SLUGS, frames: 0, byType: {}, errors: [], ws: {}, pub: {} };
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
    const id = dec(cfg.polymarketUsApiKeyId), secret = dec(cfg.polymarketUsPrivateKey);
    const key = crypto.createPrivateKey({ key: Buffer.concat([PREFIX, Buffer.from(secret, 'base64').subarray(0, 32)]), format: 'der', type: 'pkcs8' });
    const ts = String(Date.now());
    const sig = crypto.sign(null, Buffer.from(ts + 'GET' + '/v1/ws/markets'), key).toString('base64');
    const ws = new WebSocket('wss://api.polymarket.us/v1/ws/markets', { headers: { 'X-PM-Access-Key': id, 'X-PM-Timestamp': ts, 'X-PM-Signature': sig } });
    const track = (bucket, slug, bid, ask, last) => {
      const b = (bucket[slug] ??= { updates: 0, changes: 0, last: null, gapsMs: [], firstAt: null });
      const now = Date.now(); const k = `${bid}/${ask}`;
      b.updates++; if (b.firstAt == null) b.firstAt = now;
      if (k !== b.key) { if (b.changedAt) b.gapsMs.push(now - b.changedAt); b.changes++; b.key = k; b.changedAt = now; }
      b.last = { at: new Date(now).toISOString(), bid, ask, last };
    };
    await new Promise((resolve) => {
      const done = () => { try { ws.close(); } catch {} resolve(); };
      const timer = setTimeout(done, SECONDS * 1000);
      ws.on('unexpected-response', (_req, res) => { out.errors.push(`upgrade refused: HTTP ${res.statusCode}`); clearTimeout(timer); done(); });
      ws.on('error', (e) => out.errors.push('ws error: ' + String(e.message || e)));
      ws.on('close', (code, reason) => { out.closed = { code, reason: String(reason).slice(0, 200) }; });
      ws.on('open', () => {
        out.openedAt = new Date().toISOString();
        ws.send(JSON.stringify({ subscribe: { requestId: 'lite', subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA_LITE', marketSlugs: SLUGS } }));
        ws.send(JSON.stringify({ subscribe: { requestId: 'trade', subscriptionType: 'SUBSCRIPTION_TYPE_TRADE', marketSlugs: SLUGS } }));
        const ping = setInterval(() => { try { ws.ping(); } catch {} }, 15_000);
        ws.on('close', () => clearInterval(ping));
      });
      ws.on('message', (data) => {
        out.frames++;
        let m; try { m = JSON.parse(String(data)); } catch { out.byType.unparsed = (out.byType.unparsed ?? 0) + 1; return; }
        const type = Object.keys(m).filter((k) => k !== 'requestId').join('+') || 'empty';
        out.byType[type] = (out.byType[type] ?? 0) + 1;
        if (!out.sample?.[type]) { (out.sample ??= {})[type] = String(data).slice(0, 600); }
        if (m.error) out.errors.push('server: ' + String(m.error).slice(0, 200));
        const lite = m.marketDataLite;
        if (lite?.marketSlug) track(out.ws, lite.marketSlug, px(lite.bestBid), px(lite.bestAsk), px(lite.lastTradePx));
        const book = m.marketData;
        if (book?.marketSlug) track(out.ws, book.marketSlug + ' (book)', px(book.bids?.[0]?.px), px(book.offers?.[0]?.px), undefined);
        if (m.trade?.marketSlug) { const t = (out.trades ??= {}); t[m.trade.marketSlug] = (t[m.trade.marketSlug] ?? 0) + 1; }
      });
      // The public endpoint the September lag arm read, for comparison.
      const poll = setInterval(async () => {
        for (const slug of SLUGS) {
          try {
            const r = await fetch(`https://api.polymarket.us/v1/markets/${slug}/bbo`, { headers: { 'User-Agent': 'oracle-trader-readonly' } });
            const j = await r.json(); const d = j.marketData ?? {};
            track(out.pub, slug, px(d.bestBid), px(d.bestAsk), px(d.lastTradePx));
          } catch (e) { out.errors.push('bbo: ' + String(e.message || e).slice(0, 120)); }
        }
      }, 5000);
      ws.on('close', () => clearInterval(poll));
      setTimeout(() => clearInterval(poll), SECONDS * 1000);
    });
  } catch (e) { out.errors.push(String(e.message || e)); }
  for (const bucket of [out.ws, out.pub]) for (const b of Object.values(bucket)) {
    const g = b.gapsMs.sort((x, y) => x - y); b.medianChangeGapS = g.length ? g[Math.floor(g.length / 2)] / 1000 : null; delete b.gapsMs; delete b.key; delete b.changedAt;
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ frames: out.frames, byType: out.byType, errors: out.errors.slice(0, 5), ws: out.ws, pub: out.pub, trades: out.trades }, null, 1));
  app.quit();
});
