// Which backlog reads are due. Parses docs/BACKLOG.md for dated triggers and prints the ones due today or
// overdue, plus the next three days. `--notify` pushes the due list once a day through the app's alert webhook
// (the same ntfy/Discord endpoint the sentinel uses) so the operator sees it without remembering anything;
// maintenance.ps1 runs this before the daily session and the session reads data/due-triggers.md first.
//   node scripts/due-triggers.mjs            print
//   node scripts/due-triggers.mjs --notify   print, write data/due-triggers.md, push if anything is due (once per day)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'G:/PROJECTS/oracle-trader'
const NOTIFY = process.argv.includes('--notify')
const today = new Date().toISOString().slice(0, 10)
const plus = (d) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)

const text = readFileSync(join(REPO, 'docs/BACKLOG.md'), 'utf8')
// Items are bullets ("- **title**" or "N. **title**"); an item's text runs to the next bullet at the same or lower indent.
const lines = text.split(/\r?\n/)
const items = []
let cur = null
for (const l of lines) {
  const head = /^(?:- |(\d+)\. )\*\*(.+?)\*\*/.exec(l)
  if (head) {
    // The item number: the bullet prefix ("153. **...**") or the title's own start ("**153 DONE ...**", "**151 first pass**").
    const num = head[1] ?? /^(\d+)\b/.exec(head[2])?.[1] ?? null
    cur = { num, title: head[2].replace(/\.$/, ''), body: l }
    items.push(cur)
    continue
  }
  if (cur && /^\s{2,}\S/.test(l)) cur.body += ' ' + l.trim()
  else if (cur && l.trim() === '') cur = null
}
// A finished item's completion is a LATER bullet with the same number, not an edit of the original: keep only the
// last bullet per number, and drop it if that bullet says the item is done.
const lastByNum = new Map()
for (const it of items) if (it.num) lastByNum.set(it.num, it)
const dated = []
for (const it of items) {
  if (it.num && lastByNum.get(it.num) !== it) continue
  if (/\b(DONE|CLOSED|VOID|WITHDRAWN|SUPERSEDED)\b/.test(it.title)) continue
  // Only a date inside the item's own Trigger sentence counts ("Trigger: read on **2026-09-25**"); an item whose
  // trigger is an event ("at the next gate tally", "none - standing") is not a dated read.
  const trigIdx = it.body.search(/\btrigger\b/i)
  if (trigIdx < 0) continue
  const trig = it.body.slice(trigIdx)
  const tdates = [...trig.matchAll(/\b(2026-\d{2}-\d{2})\b/g)].map((m) => m[1])
  if (!tdates.length) continue
  // The read date is the latest date the trigger names ("build 09-19; read 09-26" reads on 09-26).
  const when = tdates.sort().slice(-1)[0]
  dated.push({ when, title: it.title.slice(0, 110) })
}
// The backlog keeps its history: a finished item's completion is usually a LATER bullet, not an edit of the original,
// so anything older than two days has either been read by a maintenance session or superseded. Only a trigger
// dated today, yesterday or the day before is DUE here; the maintenance prompt's own step 8 still walks the rest.
const due = dated.filter((d) => d.when <= today && d.when >= plus(-2) && !/\b(DONE|CLOSED|VOID|WITHDRAWN|SUPERSEDED)\b/.test(d.title)).sort((a, b) => a.when.localeCompare(b.when))
const soon = dated.filter((d) => d.when > today && d.when <= plus(3)).sort((a, b) => a.when.localeCompare(b.when))
const fmt = (d) => `${d.when}  ${d.title}`
const md = [`# Reads due - ${today}`, '', due.length ? '## DUE (today or overdue)' : '## Nothing due today', ...due.map((d) => `- ${fmt(d)}`), '', '## Next three days', ...(soon.length ? soon.map((d) => `- ${fmt(d)}`) : ['- none']), ''].join('\n')
console.log(md)
if (!NOTIFY) process.exit(0)
mkdirSync(join(REPO, 'data'), { recursive: true })
writeFileSync(join(REPO, 'data/due-triggers.md'), md)
const stamp = join(REPO, 'data', `due-triggers.notified-${today}`)
if (!due.length || existsSync(stamp)) process.exit(0)
let webhook = ''
try {
  const cfg = JSON.parse(readFileSync(join(process.env.APPDATA, 'oracle-trader', 'kalshi-auto.json'), 'utf8')).config
  if (typeof cfg.alertWebhookUrl === 'string' && /^https:\/\//.test(cfg.alertWebhookUrl)) webhook = cfg.alertWebhookUrl
} catch { /* no config, no push */ }
if (!webhook) { console.log('(no alert webhook configured; nothing pushed)'); process.exit(0) }
const title = `Oracle Trader - ${due.length} read${due.length === 1 ? '' : 's'} due`
const message = due.map(fmt).join('\n').slice(0, 3800) + '\n\nThe maintenance session reads these today; results land in docs/BACKLOG.md.'
try {
  if (/discord\.com\/api\/webhooks/.test(webhook)) {
    await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${title}**\n${message}`.slice(0, 1900) }), signal: AbortSignal.timeout(10_000) })
  } else {
    const u = new URL(webhook)
    await fetch(u.origin, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: u.pathname.replace(/^\/+|\/+$/g, ''), title, message, priority: 3 }), signal: AbortSignal.timeout(10_000) })
  }
  writeFileSync(stamp, new Date().toISOString())
  console.log(`(pushed ${due.length} due item(s) to the alert webhook)`)
} catch (e) {
  console.log(`(push failed: ${String(e).slice(0, 80)})`)
}
