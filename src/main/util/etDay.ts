const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' })

/** New York calendar date (YYYY-MM-DD) and whether it falls on a Saturday or Sunday. */
export function etDay(ms: number): { date: string; weekend: boolean } {
  const p: Record<string, string> = {}
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value
  return { date: `${p.year}-${p.month}-${p.day}`, weekend: p.weekday === 'Sat' || p.weekday === 'Sun' }
}
