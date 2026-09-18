import type { VenueMarket } from './types'
export const POLY_PAPER_STRATEGIES = [
  {id:'join',name:'Passive join',rule:'Buy both sides at their best bid; no assumed rebate.'},
  {id:'improve',name:'Passive improve',rule:'Improve each bid by one tick without crossing.'},
  {id:'momentum',name:'Quote momentum',rule:'Follow a 3c move over at least five minutes.'},
  {id:'reversion',name:'Mean reversion',rule:'Fade a 4c move over at least five minutes.'},
  {id:'pressure',name:'Book pressure',rule:'Passive entry toward a top-three-level depth ratio above 3:1.'},
  {id:'longshot',name:'Longshot control',rule:'Buy the 3–10c side at the ask; hold to settlement.'},
  {id:'favorite',name:'Favorite control',rule:'Buy the 90–97c side at the ask; hold to settlement.'},
  {id:'benchmark',name:'Alternating-side benchmark',rule:'Alternate YES/NO taker entries; no predictive signal.'}
] as const
export type PolyPaperStrategy = typeof POLY_PAPER_STRATEGIES[number]['id']
export interface PolyPaperOrder {id:string;strategy:PolyPaperStrategy;market:VenueMarket;side:'YES'|'NO';limit:number;maker:boolean;at:number;expires:number}
/** mark: net per contract had the position been exited on the fill quote. Stops and targets move from it. */
export interface PolyPaperPosition extends PolyPaperOrder {entry:number;fee:number;opened:number;mark?:number}
export interface PolyPaperTrade extends PolyPaperPosition {exit:number;exitFee:number;net:number;closed:number;reason:string}
export interface PolyPaperQuote {at:number;bid:number;ask:number;bidSize:number;askSize:number;pressure:number}
export interface PolyPaperState {
  version:1;started:number;enabled:boolean;scans:number;lastScan?:number;lastError?:string;discovered:number;discoveryAt:number
  markets:VenueMarket[];quotes:Record<string,PolyPaperQuote>;history:Record<string,{at:number;mid:number}[]>
  cash:Record<string,number>;orders:PolyPaperOrder[];positions:PolyPaperPosition[];trades:PolyPaperTrade[];cooldowns:Record<string,number>
}
/**
 * Trades OPENED before this instant ran under earlier entry/exit rules (round 114 changed marks, holds and admission at
 * 2026-09-17T07:31:43Z). They stay in the ledger and are reported as a separate cohort; scorecards and live
 * qualification use only trades opened under the current rules. Move this forward whenever those rules change.
 */
export const POLY_PAPER_RULES_SINCE=Date.parse('2026-09-17T07:31:43Z')
export interface PolyPaperStatus {
  enabled:boolean;running:boolean;started:number;scans:number;lastScan?:number;lastError?:string;discovered:number;tracked:number;fresh:number
  strategies:{id:string;name:string;rule:string;cash:number;open:number;pending:number;closed:number;net:number;unrealized:number;unpriced:number;days:number;markets:number;lower?:number;upper?:number;assessment:string;legacyClosed:number;legacyNet:number}[]
  positions:PolyPaperPosition[];orders:PolyPaperOrder[];trades:PolyPaperTrade[]
}
