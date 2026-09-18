// One-time/idempotent migration: merge legacy quoter fill ledgers into the
// canonical quoter-kalshi-fills.jsonl, repair literal "\\n" separators, and
// deduplicate exact lifecycle records. Safe to rerun.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.env.APPDATA || '', 'oracle-trader')
const canonical = join(dir, 'quoter-kalshi-fills.jsonl')
const inputs = [canonical, join(dir, 'quoter-kalshi.json-fills.jsonl')]

function records(path) {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf8').replace(/\\n(?=\{)/g, '\n')
  return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

const rows = inputs.flatMap(records)
const seen = new Set()
const unique = []
for (const row of rows) {
  const key = JSON.stringify([row.ts, row.marketId, row.outcome, row.yesPrice, row.legCost, row.count, row.source])
  if (seen.has(key)) continue
  seen.add(key)
  unique.push(row)
}
unique.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
if (existsSync(canonical)) copyFileSync(canonical, canonical + '.bak_20260905_merge')
writeFileSync(canonical, unique.map((x) => JSON.stringify(x)).join('\n') + (unique.length ? '\n' : ''))
console.log(JSON.stringify({ inputs: inputs.filter(existsSync), read: rows.length, unique: unique.length, canonical }, null, 2))
