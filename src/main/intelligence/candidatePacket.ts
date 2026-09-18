import type { AutoSignal } from '../../shared/ipc'
import type { OrderBook, VenueMarket } from '../../shared/types'
import type { CandidatePacket, EvidenceRef } from './types'
import { kalshiFeeCentsPerContract } from '../util/kalshiFee'
function top(book:OrderBook|undefined,side:'bid'|'ask'){return side==='bid'?book?.bids[0]:book?.asks[0]}
function oneContractFeeCents(rate:number|undefined,p:number,maker:boolean):number{
  // Routed through the canonical model (2026-09-18): the packet declares
  // contracts:1, so a 1-contract order fee expressed in cents is exactly right
  // here. The canonical helper adds the float-dust guard that this inline copy
  // was missing.
  if(maker||!rate) return 0
  return kalshiFeeCentsPerContract(rate,p,1)
}
export function buildCandidatePacket(args:{signal:AutoSignal;market?:VenueMarket;book?:OrderBook;balance?:number;openPositions:number;dailyTradesLeft:number;stake:number;headlines?:string[];venue?:string}):CandidatePacket{
  const {signal:s,market:m,book}=args; const bid=top(book,'bid'),ask=top(book,'ask')
  const maker=s.details['entryMode']==='maker'
  const yesLimit=s.outcome==='YES'?(maker?(bid?.price??s.price):(ask?.price??s.price)):(maker?(ask?.price??s.price):(bid?.price??s.price))
  const executable=s.outcome==='YES'?yesLimit:1-yesLimit
  const evidence:EvidenceRef[]=[]
  if(m?.rulesPrimary) evidence.push({id:'rules',source:'venue',asOf:Date.now(),text:m.rulesPrimary})
  for(const [i,h] of (args.headlines??[]).slice(0,8).entries()) evidence.push({id:`headline-${i+1}`,source:'rss',asOf:Date.now(),text:h})
  evidence.push({id:'strategy',source:'oracle-trader',asOf:Date.now(),text:JSON.stringify(s.details)})
  return {version:1,candidateId:s.id,decisionTime:Date.now(),venue:args.venue??'kalshi',strategy:s.strategy,market:{id:s.marketId,question:s.question,rules:m?.rulesPrimary,closeTime:s.closeTime,yesBid:bid?.price,yesAsk:ask?.price,yesMid:s.price,depthAtPrice:s.outcome==='YES'?ask?.size:bid?.size},order:{direction:s.outcome,maker,contracts:1,executablePrice:executable,yesLimitPrice:yesLimit,feeCents:oneContractFeeCents(maker?m?.makerFeeRate:m?.feeRate,executable,maker),slippageReserveCents:maker?0:1,maxLossDollars:executable},strategyEvidence:{...s.details,scannerScore:s.score,scannerConfidence:s.confidence},portfolio:{balance:args.balance,openPositions:args.openPositions,dailyTradesLeft:args.dailyTradesLeft,stake:args.stake},freshness:{packetAt:Date.now()},evidence}
}
