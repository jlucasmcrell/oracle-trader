import type { IbkrInstrument, IbkrQuote } from './ibkr'
export interface IbkrLabMarket {
  id:string; product:string; question:string; category:string; rulesUrl:string
  closeTime:number; expiresAt:number; strike:number; direction?:'above'|'below'
  yes:IbkrInstrument; no:IbkrInstrument
}
export interface IbkrLabConfig {
  enabled:boolean; mode:'paper'|'live'; liveStrategies:string[]
  contracts:number; maxOpenPerStrategy:number; maxDailyLoss:number; maxLiveCost:number
}
export interface IbkrLabOrder {
  id:string; strategy:string; marketId:string; outcome:'YES'|'NO'; quantity:number; limit:number
  maker:boolean; createdAt:number; expiresAt:number; reason:string; basket?:string
}
export interface IbkrLabPosition {
  id:string; strategy:string; market:IbkrLabMarket; outcome:'YES'|'NO'; quantity:number
  entry:number; entryFee:number; openedAt:number; reason:string; basket?:string
  /** Per-contract net had the position been exited on the first fresh quote at or after the fill; price exits move from it. */
  entryMark?:number
  /** When entryMark was taken (the fill time when the fill quote was fresh). */
  entryMarkAt?:number
}
export interface IbkrLabTrade {
  /** Both legs of one market netted at $1: `entry` is the PAIR's cost and may exceed 1, so per-contract price
   *  statistics must skip this row. Directional arms can no longer create one (audit B-195). */
  paired?:boolean
  id:string; strategy:string; marketId:string; question:string; outcome:'YES'|'NO'; quantity:number
  entry:number; exit:number; fees:number; net:number; openedAt:number; closedAt:number; reason:string
}
export interface IbkrLabLive {
  id:string; strategy:string; market:IbkrLabMarket; outcome:'YES'|'NO'; quantity:number; createdAt:number
  status:'submitting'|'open'|'closed'|'uncertain'; orderId?:string; exitOrderId?:string; message?:string
  filled:number; exitFilled:number; entryCost:number; exitCost:number; fees:number; net?:number
  exitOrderIds?:string[]; exitAttempt?:number; pendingRef?:string; lastExitAt?:number
  /** The orderRef each order was submitted with: the one id a TWS completed-order row carries (audit B-07). */
  entryRef?:string; exitRefs?:Record<string,string>
  executions?:Record<string,import('./types').VenueFill>
  paired?:number; pairRevenue?:number
  /** Per-contract exit value on the first fresh quote after the fill; price exits move from it, as paper does. Absent until one is fresh. */
  entryMark?:number|null
  entryMarkAt?:number
  ordersComplete?:boolean
  basket?:string
}
export interface IbkrLabState {
  /** UTC days on which an arm hit its daily loss cap, per arm: those day-clusters are truncated conditional on
   *  losses, so any band built from them is optimistic by an unknown amount (audit B-196). */
  cappedDays?:Record<string,string[]>
  version:1; config:IbkrLabConfig; startedAt:number; scans:number; lastScanAt?:number; lastError?:string
  markets:IbkrLabMarket[]; quotes:Record<string,IbkrQuote>; histories:Record<string,{at:number;p:number}[]>
  orders:IbkrLabOrder[]; positions:IbkrLabPosition[]; trades:IbkrLabTrade[]; cash:Record<string,number>
  seen:Record<string,number>; live:IbkrLabLive[]; notes:Record<string,string>; discoveryAt?:number
  forecast:Record<string,{at:number;p:number;reason:string}>; modelDay:string; modelCalls:number
  modelProvider?:string; previousModelBudget?:{provider:string;day:string;calls:number}
  forecastAttempts?:Record<string,number>
  /** "<PRODUCT> <yyyy-mm>" -> when IBKR answered "No security definition" for it; discovery does not ask again for a day (BACKLOG 115). */
  unlisted?:Record<string,number>
}
/**
 * Trades OPENED before this instant ran under earlier entry/exit rules (round 114 changed marks, holds and admission at
 * 2026-09-17T07:31:43Z). They stay in the ledger and are reported as a separate cohort; scorecards and live
 * qualification use only trades opened under the current rules. Move this forward whenever those rules change.
 */
export const IBKR_RULES_SINCE=Date.parse('2026-09-17T07:31:43Z')
export interface IbkrLabStrategyRow {
  id:string; name:string; status:string; reason:string; fills:number; closed:number; wins:number; losses:number
  realized:number; unrealized:number; unpriced:number; cash:number; open:number; pending:number; days:number
  events:number; liveEligible:boolean; confidenceLow?:number
  /** Of `days`, how many were cut short by the daily loss cap - those clusters are truncated on losses. */
  cappedDays:number
  /** Why the arm is not promotable yet, when it is not. Empty once every leg of the gate is met. */
  gateBlockers?:string[]
  /** Closed under earlier rules: kept for history, excluded from every number above. */
  legacyClosed:number; legacyRealized:number
}
export interface IbkrLabStatus {
  config:IbkrLabConfig; startedAt:number; scans:number; lastScanAt?:number; lastError?:string; running:boolean
  markets:number; freshQuotes:number; strategies:IbkrLabStrategyRow[]; trades:IbkrLabTrade[]
  positions:IbkrLabPosition[]; live:IbkrLabLive[]; modelCalls:number; notes:string[]
  orders:IbkrLabOrder[]
}
