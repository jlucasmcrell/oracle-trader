/**
 * The drawdown kill switch, read the way the app actually writes it.
 *
 * The app keeps TWO daily records in `kalshi-auto.json` state and the names are
 * one letter apart: `daily` is `{ date, count }`, today's trade counter, while
 * `dailyPnl` is `{ date, realized, tripped }` and carries the kill switch
 * (autoTrader.ts killSwitchCheck). trade-quality.mjs read `daily.tripped` — a
 * field that does not exist — so it printed "kill clear" unconditionally, and
 * on 2026-09-15 it said "clear" through a halt that had already stopped every
 * entry for two hours. The date guard matters too: a trip is scoped to its own
 * UTC day and the app clears it on the roll (autoTrader.ts rollDaily).
 *
 * @param {{ daily?: unknown, dailyPnl?: { date?: string, realized?: number, tripped?: boolean },
 *           venueDay?: { date?: string, realized?: number } } | null | undefined} state
 * @param {string} today UTC date, YYYY-MM-DD
 * @returns {{ tripped: boolean, text: string }}
 */
export function killState(state, today) {
  const p = state?.dailyPnl
  if (!p || p.date !== today || p.tripped !== true) return { tripped: false, text: 'clear' }
  // Whichever ledger is worse governs the trip, so report that one: the venue
  // settlement feed is the ledger of record in live mode and the local exits
  // ledger never sees the quoter, convergence, lead-lag or Dutch engines.
  const local = Number.isFinite(p.realized) ? p.realized : 0
  const v = state?.venueDay
  const venue = v && v.date === today && Number.isFinite(v.realized) ? v.realized : undefined
  const useVenue = venue !== undefined && venue < local
  const worst = useVenue ? venue : local
  return {
    tripped: true,
    text: `TRIPPED (${useVenue ? 'venue' : 'local'} day ${worst.toFixed(2)}) — new entries halted until the next UTC day`
  }
}
