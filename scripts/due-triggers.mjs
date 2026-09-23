// Which pre-registered reads are due. The list is docs/reads.json (section 163): one entry per read with the date to
// look at it, the command, the registered rule and the action. An entry is DUE from its date until it is marked
// `done` - however overdue; the old parser read dates out of backlog prose, missed 40 wrapped headings, every date
// written as a timestamp and every read whose text lacked the word "Trigger", and dropped anything two days overdue
// for good (backlog 168). maintenance.ps1 runs this before the daily session, which reads data/due-triggers.md first.
// `--notify` pushes the due list once a day through the alert webhook (config first, then the sentinel's saved copy).
//   node scripts/due-triggers.mjs            print
//   node scripts/due-triggers.mjs --notify   print, write data/due-triggers.md, push if anything is due (once per day)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'G:/PROJECTS/oracle-trader'
const NOTIFY = process.argv.includes('--notify')
const today = new Date().toISOString().slice(0, 10)
const plus = (d) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)

const { reads } = JSON.parse(readFileSync(join(REPO, 'docs/reads.json'), 'utf8'))
const open = reads.filter((r) => !r.done && typeof r.due === 'string')
const due = open.filter((r) => r.due <= today).sort((a, b) => a.due.localeCompare(b.due))
const soon = open.filter((r) => r.due > today && r.due <= plus(3)).sort((a, b) => a.due.localeCompare(b.due))
const line = (r) => `${r.due}  ${r.id}. ${r.what}${r.owner === 'app' ? ' (the app does this itself - check it ran)' : ''}`
const detail = (r) => [`- ${line(r)}`, `  - how: ${r.how}`, `  - rule: ${r.rule}`, `  - action: ${r.action}`].join('\n')
const md = [
  `# Reads due - ${today}`,
  '',
  'Source: docs/reads.json. Perform each DUE read exactly as its registration says, record the result in docs/BACKLOG.md and the changelog, then set its `done` (or move `due` to the next check, with the reason in `note`).',
  '',
  due.length ? '## DUE (today or overdue)' : '## Nothing due today',
  ...due.map(detail),
  '',
  '## Next three days',
  ...(soon.length ? soon.map((r) => `- ${line(r)}`) : ['- none']),
  ''
].join('\n')
console.log(md)
if (!NOTIFY) process.exit(0)
mkdirSync(join(REPO, 'data'), { recursive: true })
writeFileSync(join(REPO, 'data/due-triggers.md'), md)
const stamp = join(REPO, 'data', `due-triggers.notified-${today}`)
if (!due.length || existsSync(stamp)) process.exit(0)
const isHook = (u) => typeof u === 'string' && /^https:\/\//.test(u)
let webhook = ''
try {
  const cfg = JSON.parse(readFileSync(join(process.env.APPDATA, 'oracle-trader', 'kalshi-auto.json'), 'utf8')).config
  if (isHook(cfg.alertWebhookUrl)) webhook = cfg.alertWebhookUrl
} catch { /* fall through to the saved copy */ }
if (!webhook) {
  // The sentinel's copy survives a wiped config (the 09-22 push was lost to exactly that).
  try {
    const saved = JSON.parse(readFileSync(join(process.env.APPDATA, 'oracle-trader', 'alert-webhook.json'), 'utf8')).url
    if (isHook(saved)) webhook = saved
  } catch { /* none */ }
}
if (!webhook) { console.log('(no alert webhook configured; nothing pushed)'); process.exit(0) }
const title = `Oracle Trader - ${due.length} read${due.length === 1 ? '' : 's'} due`
const message = due.map(line).join('\n').slice(0, 3800) + '\n\nThe maintenance session performs these today; results land in docs/BACKLOG.md.'
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
