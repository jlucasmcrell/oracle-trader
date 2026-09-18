import {appendFileSync,existsSync,readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {writeFileAtomic} from '../store/json'
import {underlyingOf} from './classify'
import type {VenueAdapter} from '../../shared/venue'
import type {OrderBook,VenueMarket} from '../../shared/types'
import {POLY_PAPER_RULES_SINCE,POLY_PAPER_STRATEGIES,type PolyPaperState,type PolyPaperStatus,type PolyPaperQuote,type PolyPaperOrder,type PolyPaperPosition,type PolyPaperStrategy} from '../../shared/polyPaper'

const MINUTE=60000,STARTING_CASH=1000
// Published US fee change: September 16, 2026 23:59 Eastern. Maker rebate per docs.polymarket.us/fees (2026-09-18):
// -0.0125 x p(1-p) per contract, applied at the trade. Returned as a NEGATIVE fee so every caller's `cash -= price + fee`
// and `net = exit - entry - fee` credit it without special cases. The per-second liquidity incentive program is NOT
// modelled (its pools are per market and published live). At one contract the rebate rounds to $0.00 in
// polyPaperOrderFee, exactly as the venue bills - the formula only matters once size exceeds ~4 contracts.
export const POLY_MAKER_REBATE=.0125
export function polyPaperFee(price:number,at:number,maker=false,rate?:number){
  const scheduled=at>=Date.parse('2026-09-17T03:59:00Z')?.0695:.06
  return maker?-POLY_MAKER_REBATE*price*(1-price):price*(1-price)*Math.max(scheduled,Number.isFinite(rate)?rate!:0)
}
/**
 * The fee the venue actually BILLS for one order, as opposed to the exact per-share
 * rate above. Measured on the 432 real polymarket-us fills in the fill-reconciler
 * archive (2026-09-02..12): every reported fee was a whole number of cents, and
 * round-to-nearest-cent of shares*price*(1-price)*rate reproduced 85 of the 87
 * fee-paying fills (97.7%); ceil matched 43.7%, floor 57.5%, the unrounded
 * fraction 2.3% (and only where the raw fraction happened to land on a whole
 * cent). The 2 exceptions are one maker rebate (a credit on the separate
 * -0.0125 schedule) and one unexplained 1-cent case in 432 fills.
 * So this venue rounds the ORDER TOTAL to the cent: it
 * does not ceil (unlike Kalshi, which does) and it does not bill the fraction.
 * Rounding per share rather than per order would be wrong at any size above one,
 * which is why the share count is an argument here and not baked in.
 */
export function polyPaperOrderFee(shares:number,price:number,at:number,maker=false,rate?:number){
  // `|| 0` folds the -0 a rounded-away rebate produces; the ledger and strict comparisons must never see -0.
  return Math.round(shares*polyPaperFee(price,at,maker,rate)*100)/100||0
}
/** Unit-sized counterfactual: the lab opens exactly one share per position. */
const PAPER_SHARES=1
export function polyPaperQuote(book:OrderBook,at:number):PolyPaperQuote|undefined {
  const valid=(x:{price:number;size:number})=>Number.isFinite(x.price)&&x.price>0&&x.price<1&&Number.isFinite(x.size)&&x.size>=1
  const bids=book.bids.filter(valid).sort((a,b)=>b.price-a.price),asks=book.asks.filter(valid).sort((a,b)=>a.price-b.price)
  if(!bids.length||!asks.length||bids[0].price>=asks[0].price)return
  return {at,bid:bids[0].price,ask:asks[0].price,bidSize:bids[0].size,askSize:asks[0].size,pressure:bids.slice(0,3).reduce((n,x)=>n+x.size,0)/asks.slice(0,3).reduce((n,x)=>n+x.size,0)}
}
const sideQuote=(q:PolyPaperQuote,side:'YES'|'NO')=>side==='YES'?{bid:q.bid,ask:q.ask,bidSize:q.bidSize,askSize:q.askSize}:{bid:1-q.ask,ask:1-q.bid,bidSize:q.askSize,askSize:q.bidSize}
export function polyPaperSignals(m:VenueMarket,q:PolyPaperQuote,h:{at:number;mid:number}[],at:number):Pick<PolyPaperOrder,'strategy'|'side'|'limit'|'maker'>[]{
  if(m.status!=='open'||!m.closeTime||m.closeTime-at<30*MINUTE||m.closeTime-at>72*60*MINUTE||(m.minTradeQty??1)>1||q.ask-q.bid>.06)return []
  const out:ReturnType<typeof polyPaperSignals>=[],mid=(q.bid+q.ask)/2,tick=m.tickSize??.01
  if(!Number.isFinite(tick)||tick<=0||tick>=1)return []
  const add=(strategy:PolyPaperStrategy,side:'YES'|'NO',maker=true,improve=false)=>{
    const s=sideQuote(q,side),raw=maker?s.bid+(improve?tick:0):Math.min(.99,s.ask+.01)
    const limit=Math.round(Math.floor((raw+1e-9)/tick)*tick*1e6)/1e6
    if(limit>0&&limit<1&&(!maker||limit<s.ask-1e-9))out.push({strategy,side,limit,maker})
  }
  if(mid>=.15&&mid<=.85&&q.ask-q.bid>=.02){for(const side of ['YES','NO'] as const){add('join',side);add('improve',side,true,true)}}
  const past=h.find(p=>at-p.at>=5*MINUTE&&at-p.at<=12*MINUTE)
  if(past&&mid>=.15&&mid<=.85){const move=mid-past.mid;if(Math.abs(move)>=.03)add('momentum',move>0?'YES':'NO',false);if(Math.abs(move)>=.04)add('reversion',move>0?'NO':'YES',false)}
  if(mid>=.15&&mid<=.85&&(q.pressure>=3||q.pressure<=1/3))add('pressure',q.pressure>=3?'YES':'NO')
  for(const side of ['YES','NO'] as const){const s=sideQuote(q,side);if(s.ask>=.03&&s.ask<=.1)add('longshot',side,false);if(s.ask>=.9&&s.ask<=.97)add('favorite',side,false)}
  add('benchmark',Math.floor(at/(30*MINUTE))%2?'YES':'NO',false)
  return out
}

/** Independent simulation: only public read methods are provided, never a trading engine or broker. */
export class PolyPaperLab {
  private state:PolyPaperState
  private running=false
  private retryAfter=new Map<string,number>()
  constructor(private path:string,private venue:Pick<VenueAdapter,'searchMarkets'|'getMarket'|'getOrderBook'>,private clock=Date.now){
    this.state=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{version:1,started:clock(),enabled:true,scans:0,discovered:0,discoveryAt:0,markets:[],quotes:{},history:{},cash:Object.fromEntries(POLY_PAPER_STRATEGIES.map(s=>[s.id,STARTING_CASH])),orders:[],positions:[],trades:[],cooldowns:{}}
    if(this.state.version!==1||!Array.isArray(this.state.trades)||POLY_PAPER_STRATEGIES.some(s=>!Number.isFinite(this.state.cash[s.id])))throw Error('Invalid Polymarket paper ledger; refusing to overwrite')
  }
  private save(){writeFileAtomic(this.path,JSON.stringify(this.state))}
  setEnabled(enabled:boolean){if(typeof enabled!=='boolean')throw Error('Expected paper entry switch');this.state.enabled=enabled;if(!enabled)this.state.orders=[];this.save();return this.status()}
  status():PolyPaperStatus {
    const s=this.state,now=this.clock()
    return {enabled:s.enabled,running:this.running,started:s.started,scans:s.scans,lastScan:s.lastScan,lastError:s.lastError,discovered:s.discovered,tracked:s.markets.length,fresh:Object.values(s.quotes).filter(q=>now-q.at<=2*MINUTE).length,
      strategies:POLY_PAPER_STRATEGIES.map(def=>{
        const all=s.trades.filter(t=>t.strategy===def.id),trades=all.filter(t=>t.opened>=POLY_PAPER_RULES_SINCE),legacy=all.filter(t=>t.opened<POLY_PAPER_RULES_SINCE),positions=s.positions.filter(p=>p.strategy===def.id),byDay=new Map<string,number[]>()
        for(const t of trades){const day=new Date(t.closed).toISOString().slice(0,10);byDay.set(day,[...(byDay.get(day)??[]),t.net])}
        const means=[...byDay.values()].map(a=>a.reduce((n,v)=>n+v,0)/a.length),days=means.length,mean=means.reduce((n,v)=>n+v,0)/Math.max(1,days)
        const se=days>1?Math.sqrt(means.reduce((n,v)=>n+(v-mean)**2,0)/(days-1)/days):undefined
        const lower=se===undefined?undefined:mean-2.8*se,upper=se===undefined?undefined:mean+2.8*se
        let unrealized=0,unpriced=0
        for(const p of positions){const q=s.quotes[p.market.id];if(!q||now-q.at>2*MINUTE){unpriced++;continue}const exit=Math.max(0,sideQuote(q,p.side).bid-.01);unrealized+=exit-p.entry-p.fee-polyPaperOrderFee(PAPER_SHARES,exit,now,false,p.market.feeRate)}
        const markets=new Set(trades.map(t=>underlyingOf(t.market.id,t.market.question)??t.market.id)).size,ready=days>=7&&trades.length>=100&&markets>=10
        return {...def,cash:s.cash[def.id],open:positions.length,pending:s.orders.filter(o=>o.strategy===def.id).length,closed:trades.length,net:trades.reduce((n,t)=>n+t.net,0),unrealized,unpriced,days,markets,lower,upper,legacyClosed:legacy.length,legacyNet:legacy.reduce((n,t)=>n+t.net,0),assessment:def.id==='benchmark'?'Control only':!ready?'Collecting evidence':lower!>0?'Promising; paper only':upper!<0?'Negative; reassess':'Inconclusive'}
      }),positions:s.positions,orders:s.orders,trades:s.trades.slice(-60).reverse()}
  }
  private close(p:PolyPaperPosition,price:number,reason:string,now:number,settlement=false){
    const fee=polyPaperOrderFee(PAPER_SHARES,price,now,settlement,p.market.feeRate),net=price-p.entry-p.fee-fee
    this.state.cash[p.strategy]+=price-fee
    this.state.trades.push({...p,exit:price,exitFee:fee,net,closed:now,reason})
    this.state.positions=this.state.positions.filter(x=>x.id!==p.id)
    this.state.cooldowns[`${p.strategy}:${p.market.id}`]=now+30*MINUTE
  }
  /** A later executable quote is required for every fill. Each strategy is an independent counterfactual. */
  private process(m:VenueMarket,q:PolyPaperQuote,now:number){
    const s=this.state
    for(const p of [...s.positions].filter(p=>p.market.id===m.id)){
      const side=sideQuote(q,p.side),exit=Math.max(0,side.bid-.01),net=exit-p.entry-p.fee-polyPaperOrderFee(PAPER_SHARES,exit,now,false,m.feeRate)
      const hold=p.strategy==='longshot'||p.strategy==='favorite',move=p.mark===undefined?net:net-p.mark
      if(!hold&&side.bidSize>=1&&(now-p.opened>=15*MINUTE||move>=.03||move<=-.05))this.close(p,exit,move>=.03?'profit target':move<=-.05?'loss stop':'15-minute exit',now)
    }
    s.orders=s.orders.filter(o=>o.expires>now)
    for(const o of [...s.orders].filter(o=>o.market.id===m.id)){
      if(now<=o.at||!s.enabled||!m.closeTime||now>=m.closeTime||m.status!=='open')continue
      const daily=s.trades.filter(t=>t.strategy===o.strategy&&new Date(t.closed).toISOString().slice(0,10)===new Date(now).toISOString().slice(0,10)).reduce((n,t)=>n+t.net,0)
      if(daily<=-5){s.orders=s.orders.filter(x=>x.strategy!==o.strategy);continue}
      const side=sideQuote(q,o.side),price=o.maker?o.limit:side.ask+.01
      if(side.askSize<1||(o.maker?side.ask>=o.limit-1e-9:price>o.limit+1e-9)||price>=1)continue
      const fee=polyPaperOrderFee(PAPER_SHARES,price,now,o.maker,m.feeRate)
      if(s.cash[o.strategy]<price+fee)continue
      const exitNow=Math.max(0,side.bid-.01),mark=exitNow-price-fee-polyPaperOrderFee(PAPER_SHARES,exitNow,now,false,m.feeRate)
      s.cash[o.strategy]-=price+fee;s.positions.push({...o,entry:price,fee,opened:now,mark});s.orders=s.orders.filter(x=>x.id!==o.id)
    }
    const history=s.history[m.id]??[]
    if(s.enabled)for(const signal of polyPaperSignals(m,q,history,now)){
      const owned=[...s.positions,...s.orders].filter(x=>x.strategy===signal.strategy)
      const group=underlyingOf(m.id,m.question)??m.id
      if(owned.filter(x=>(underlyingOf(x.market.id,x.market.question)??x.market.id)===group).length>=2)continue
      const daily=s.trades.filter(t=>t.strategy===signal.strategy&&new Date(t.closed).toISOString().slice(0,10)===new Date(now).toISOString().slice(0,10)).reduce((n,t)=>n+t.net,0)
      if(owned.length>=4||owned.some(x=>x.market.id===m.id&&x.side===signal.side)||(s.cooldowns[`${signal.strategy}:${m.id}`]??0)>now||daily<=-5||s.cash[signal.strategy]<1)continue
      s.orders.push({...signal,id:randomUUID(),market:m,at:now,expires:now+(signal.maker?30:2)*MINUTE})
    }
    s.history[m.id]=[...history.filter(p=>now-p.at<=12*MINUTE),{at:now,mid:(q.bid+q.ask)/2}].slice(-30)
  }
  async scan(){
    if(this.running)return;this.running=true
    const s=this.state,errors:string[]=[]
    try{
      const now=this.clock()
      if(!s.markets.length||now-s.discoveryAt>=30*MINUTE){
        try{
        const markets=await this.venue.searchMarkets({sort:'ending-soon',limit:1000,minCloseTime:now+30*MINUTE,maxCloseTime:now+72*60*MINUTE})
        s.discovered=markets.length
        // Bounded catalog sample; rotate every discovery instead of permanently testing its first page.
        const eligible=markets.filter(m=>m.outcomeType==='BINARY'&&m.status==='open'&&(m.minTradeQty??1)<=1&&m.closeTime&&m.closeTime>now+30*MINUTE)
        const offset=eligible.length?(Math.floor(now/(30*MINUTE))*12)%eligible.length:0
        s.markets=Array.from({length:Math.min(12,eligible.length)},(_,i)=>eligible[(offset+Math.floor(i*eligible.length/Math.min(12,eligible.length)))%eligible.length]);s.discoveryAt=now
        }catch(e){errors.push(`Discovery: ${String(e).slice(0,180)}`)}
      }
      s.orders=s.orders.filter(o=>o.expires>this.clock())
      const markets=new Map([...s.markets,...s.orders.map(o=>o.market),...s.positions.map(p=>p.market)].map(m=>[m.id,m]))
      for(let m of markets.values()){
        if((this.retryAfter.get(m.id)??0)>this.clock())continue
        try{
          let now=this.clock()
          if(m.closeTime&&now>=m.closeTime){
            m=await this.venue.getMarket(m.id)
            const value=m.resolved?(m.resolution?.toLowerCase()==='yes'?1:m.resolution?.toLowerCase()==='no'?0:m.resolution==='MKT'?m.resolutionProbability:undefined):undefined
            if(value!==undefined&&Number.isFinite(value)&&value>=0&&value<=1){for(const p of [...s.positions].filter(p=>p.market.id===m.id))this.close(p,p.side==='YES'?value:1-value,'venue settlement',now,true);s.orders=s.orders.filter(o=>o.market.id!==m.id);continue}
            // A halted/closed sports book may still expose old prices. Wait for venue settlement.
            if(m.status!=='open'||!m.closeTime||now>=m.closeTime)continue
          }
          const started=this.clock(),book=await this.venue.getOrderBook!(m.id);now=this.clock()
          if(now-started>15_000)continue
          const q=polyPaperQuote(book,now);if(!q)continue
          s.quotes[m.id]=q
          appendFileSync(`${this.path}.quotes-${new Date(now).toISOString().slice(0,10)}.jsonl`,JSON.stringify({marketId:m.id,...q})+'\n')
          this.process(m,q,now)
        }catch(e){const message=String(e).split('<')[0].slice(0,180);errors.push(`${m.id}: ${message}`);if(/429/.test(message))this.retryAfter.set(m.id,this.clock()+5*MINUTE)}
      }
      const keep=new Set(markets.keys());s.quotes=Object.fromEntries(Object.entries(s.quotes).filter(([id])=>keep.has(id)));s.history=Object.fromEntries(Object.entries(s.history).filter(([id])=>keep.has(id)))
      s.cooldowns=Object.fromEntries(Object.entries(s.cooldowns).filter(([,until])=>until>this.clock()))
      s.scans++;s.lastScan=this.clock();s.lastError=errors.length?errors.slice(0,3).join('; '):undefined
      console.log(`[poly-paper] scan ${s.scans}; ${s.markets.length} tracked; ${s.positions.length} positions; ${s.orders.length} pending; ${s.trades.length} closed; ${errors.length} errors`)
    }catch(e){s.lastError=String(e)}finally{this.running=false;this.save()}
  }
}
