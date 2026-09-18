const { app, safeStorage }=require('electron'); app.setName('oracle-trader'); app.setPath('userData',require('path').join(process.env.APPDATA,'oracle-trader')); const fs=require('fs'); const crypto=require('crypto');
app.whenReady().then(async()=>{try{const c=JSON.parse(fs.readFileSync(require('path').join(process.env.APPDATA,'oracle-trader','config.json'),'utf8')); const dec=v=>v.startsWith('enc:')?safeStorage.decryptString(Buffer.from(v.slice(4),'base64')):v.replace(/^plain:/,''); const keyId=dec(c.kalshiApiKeyId), pk=dec(c.kalshiPrivateKey); const base='https://api.elections.kalshi.com/trade-api/v2'; async function get(path){const ts=String(Date.now()),abs='/trade-api/v2'+path.split('?')[0]; const sig=crypto.sign('sha256',Buffer.from(ts+'GET'+abs),{key:pk,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:crypto.constants.RSA_PSS_SALTLEN_DIGEST}).toString('base64'); const r=await fetch(base+path,{headers:{'KALSHI-ACCESS-KEY':keyId,'KALSHI-ACCESS-TIMESTAMP':ts,'KALSHI-ACCESS-SIGNATURE':sig}});if(!r.ok)throw new Error(r.status+' '+await r.text());return r.json()} const d=await get('/portfolio/balance'); console.log(JSON.stringify(d,null,2));}catch(e){console.error(e.stack||e)}finally{app.quit()}})





