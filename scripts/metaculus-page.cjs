// Reads the community forecast Metaculus renders for logged-out visitors ("12% CHANCE") from
// question pages in a hidden Electron window, one question at a time. The API hides the
// aggregation from tokens on almost every question (2026-09-07), the page does not.
// Runs with its OWN profile (oracle-trader-probe): sharing the app's profile left pages
// half-rendered, and the app's profile is what decrypts the config, so the shadow script
// spawns this as a child process.
//   <electron> scripts/metaculus-page.cjs <postId> [<postId> ...]   → one line per id: PAGE {"id":..,"pct":..}
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.setPath('userData', path.join(app.getPath('appData'), 'oracle-trader-probe'))
const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const READ = `(() => { const t = document.body ? document.body.innerText : ''; const m = t.match(/([0-9]{1,3}(?:\\.[0-9]+)?)%\\s*CHANCE/i); return m ? Number(m[1]) : null })()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true } })
  win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36')
  try {
    for (const id of ids) {
      let pct = null
      try {
        await win.loadURL(`https://www.metaculus.com/questions/${id}/`)
        for (let i = 0; i < 6 && typeof pct !== 'number'; i++) {
          await sleep(2000)
          pct = await win.webContents.executeJavaScript(READ)
        }
      } catch (e) {
        console.log('PAGE ' + JSON.stringify({ id, error: String(e).slice(0, 120) }))
        continue
      }
      console.log('PAGE ' + JSON.stringify({ id, pct: typeof pct === 'number' ? pct : null }))
      await sleep(1200)
    }
  } finally {
    win.destroy()
    app.quit()
  }
})
