/** Preserve raw files; exact duplicate IDs count once, conflicting IDs require an integrity review. */
export function uniqueObservations(rows, keyOf) {
  const byId = new Map(), conflictRows = []
  let duplicates = 0, conflicts = 0
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) throw new Error('Observation has no stable identity')
    const prior = byId.get(key)
    if (!prior) byId.set(key, row)
    else if (JSON.stringify(prior) === JSON.stringify(row)) duplicates++
    else { conflicts++; conflictRows.push(prior, row) }
  }
  return { rows: [...byId.values()], duplicates, conflicts, conflictRows }
}

/**
 * AMENDMENT 2026-09-19 (docs/REVIEW-CHANGES-2026-09-06.md §136), fixed before any outcome was read for it.
 * From the 06:20Z reboot to the 08:22Z repair on 2026-09-15 a second copy of each recorder wrote beside the first,
 * so every identity in that window exists twice and never byte-for-byte (the clocks differ). A conflict whose rows
 * all lie inside this window IS that incident and is resolved by the grader's registered rule; a conflict anywhere
 * else is unexplained and still refuses a verdict.
 */
const DUPLICATE_WRITER_WINDOW = [Date.parse('2026-09-15T06:20:00Z'), Date.parse('2026-09-15T08:25:00Z')]
export const inDuplicateWriterWindow = (row) => {
  const t = Date.parse(row?.ts)
  return t >= DUPLICATE_WRITER_WINDOW[0] && t <= DUPLICATE_WRITER_WINDOW[1]
}
