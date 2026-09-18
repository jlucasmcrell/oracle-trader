/** Preserve raw files; exact duplicate IDs count once, conflicting IDs require an integrity review. */
export function uniqueObservations(rows, keyOf) {
  const byId = new Map()
  let duplicates = 0, conflicts = 0
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) throw new Error('Observation has no stable identity')
    const prior = byId.get(key)
    if (!prior) byId.set(key, row)
    else if (JSON.stringify(prior) === JSON.stringify(row)) duplicates++
    else conflicts++
  }
  return { rows: [...byId.values()], duplicates, conflicts }
}
