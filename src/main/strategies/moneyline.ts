import { teamInQuestion } from './sportsAnchor'

/**
 * Market-type words that mean a market is NOT a plain match winner. Word
 * boundaries matter: a bare `set` would match inside "Sunset", and a bare
 * `half` inside "Halfway".
 */
const DERIVATIVE =
  /\b(over|under|score|scores|scored|goals?|runs?|points?|spread|handicap|margin|1st|2nd|first|second|half|halves|inning|innings|period|quarter|sets?|corners?|cards?|clean|btts|tie|draw|total|totals|by)\b/

/**
 * Is this Kalshi market a plain MONEYLINE (who wins the match)?
 *
 * A sports event carries far more than the moneyline — spreads, goal/run
 * totals, period results, prop markets — and h2h sharp odds price NONE of
 * them. Team-name matching alone paired "Will Vallecano score over 0.5
 * goals" (0.48) with Vallecano's win probability (0.036) and reported a 44¢
 * edge that does not exist. Every derivative must be excluded, and the
 * question must name exactly ONE team so we know which side it backs
 * ("A vs B Winner?" is ambiguous — both teams appear in both legs).
 */
export function isMoneylineWin(question: string, home: string, away: string): boolean {
  const q = question.toLowerCase()
  if (DERIVATIVE.test(q)) return false
  if (!/\bwins?\b/.test(q)) return false
  const hasHome = teamInQuestion(home, question)
  const hasAway = teamInQuestion(away, question)
  return hasHome !== hasAway
}
