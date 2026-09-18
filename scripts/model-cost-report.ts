import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { summarizeModelUsage, type ModelUsage } from '../src/main/intelligence/modelUsage'

const args = process.argv.slice(3) // invoked by the installed-compiler runner
const options: Record<string, string> = {}
for (let i = 0; i < args.length; i += 2) {
  if (!['--dir', '--since', '--until'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: npm run costs:report -- [--dir PATH] [--since YYYY-MM-DD] [--until YYYY-MM-DD]; until is exclusive')
  options[args[i]] = args[i + 1]
}
function boundary(key: string, fallback: number): number {
  const value = options[key]
  if (!value) return fallback
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Invalid UTC date: ' + key)
  return Date.parse(value)
}
const since = boundary('--since', -Infinity), until = boundary('--until', Infinity)
if (since >= until) throw new Error('Date range must be increasing')
const dir = options['--dir'] ?? join(process.env.APPDATA ?? '', 'oracle-trader', 'model-usage')
if (!options['--dir'] && !process.env.APPDATA) throw new Error('Supply --dir for the app model-usage directory')
const all: ModelUsage[] = []
if (existsSync(dir)) for (const name of readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
  for (const line of readFileSync(join(dir, name), 'utf8').split('\n').filter(s => s.trim())) all.push(JSON.parse(line))
}
// Validate every record, including identities outside the requested window.
summarizeModelUsage(all)
const selected = all.filter(r => r.timestamp >= since && r.timestamp < until)
const groups = summarizeModelUsage(selected)
const calls = groups.reduce((s, g) => s + g.calls, 0), unknownCostCalls = groups.reduce((s, g) => s + g.unknownCostCalls, 0)
console.log(JSON.stringify({
  status: calls ? 'observed-calls' : 'no-observations', since: options['--since'] ?? null, untilExclusive: options['--until'] ?? null,
  firstObservedAt: selected.length ? new Date(selected.reduce((first, r) => Math.min(first, r.timestamp), Infinity)).toISOString() : null,
  calls, knownReportedCostUsd: groups.reduce((s, g) => s + g.reportedCostUsd, 0), unknownCostCalls,
  allObservedCallsPriced: calls > 0 && unknownCostCalls === 0, groups,
  limits: 'Forward observations only; missing costs are unknown. Excludes earlier calls, other software, subscriptions, data, electricity and unrecorded calls. Not an invoice or complete business P&L.'
}, null, 2))
