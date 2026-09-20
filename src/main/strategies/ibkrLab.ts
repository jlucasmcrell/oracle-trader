import {appendFileSync,existsSync,mkdirSync,readFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {writeFileAtomic} from '../store/json'
import type {TradingEngine} from '../engine/engine'
import type {IbkrReader} from '../venues/ibkr'
import type {IbkrAdapter} from '../venues/ibkrAdapter'
import {discoverForecastMarkets,loadFinalSettlements} from '../venues/forecastexData'
import {IBKR_HOLD_MAX_DAYS,IBKR_HOLD_TO_SETTLEMENT,IBKR_RETIRED,IBKR_STRATEGIES,IBKR_UNAVAILABLE,freshAsk,frameMid,ibkrSignals,type LabFrame} from './ibkrSignals'
import {ibkrWeather} from './ibkrWeather'
import {IBKR_RULES_SINCE,type IbkrLabConfig,type IbkrLabMarket,type IbkrLabPosition,type IbkrLabState,type IbkrLabStatus,type IbkrLabStrategyRow} from '../../shared/ibkrLab'

export const IBKR_LAB_DEFAULTS:IbkrLabConfig={enabled:true,mode:'paper',liveStrategies:[],contracts:1,maxOpenPerStrategy:4,maxDailyLoss:10,maxLiveCost:1.5}
const fee=.01,slippage=.01,startingCash=1000
/** Losses a hold-to-settlement arm must have SAMPLED before its band can promote it (BACKLOG 141's standard). */
export const IBKR_MIN_LOSSES=15
/** ...or this many closed trades, whichever comes first - the same "250 trades or 15 losses" the Kalshi arm uses. */
export const IBKR_LOSS_WAIVER_TRADES=250
const round=(n:number)=>Math.round(n*1e8)/1e8
const day=(ts:number)=>new Date(ts).toISOString().slice(0,10)
const sameDay=(a:number,b:number)=>day(a)===day(b)
export interface IbkrLabSources {
  discover:(now:number,report:(s:string)=>void)=>Promise<IbkrLabMarket[]>
  settlements:(now:number,from:number)=>Promise<Map<string,number>>
  spot:(product:string,now:number)=>Promise<{price:number;annualVol:number;at:number}|undefined>
  forecast?:(market:IbkrLabMarket,probability:number)=>Promise<{p:number;reason:string;approved?:boolean}|undefined>
  weather:(market:IbkrLabMarket,now:number)=>ReturnType<typeof ibkrWeather>
  forecastProvider?:string
}
/** Independent paper accounts on real quotes; no global engine-mode change is ever made here. */
export class IbkrLab {
  private state:IbkrLabState
  private busy=false
  private failure?:string
  private cursor=0
  private lastSettlementAt=0
  private discoveryFailedAt=0
  private modelBusy=false
  private liveBusy=false
  /** orderId -> permId, from open-order snapshots: the id a completed-order row still carries (B-07). */
  private permIds=new Map<string,number>()
  private readonly sources:IbkrLabSources
  constructor(private path:string,private reader:IbkrReader,private engine:TradingEngine,private venue:IbkrAdapter,sources:Partial<IbkrLabSources>={}){
    this.state={version:1,config:{...IBKR_LAB_DEFAULTS,liveStrategies:[]},startedAt:Date.now(),scans:0,markets:[],quotes:{},histories:{},orders:[],positions:[],trades:[],cash:Object.fromEntries(IBKR_STRATEGIES.map(s=>[s.id,startingCash])),seen:{},live:[],notes:{},forecast:{},modelDay:day(Date.now()),modelCalls:0}
    try{
      if(existsSync(path)){
        const s=JSON.parse(readFileSync(path,'utf8'))
        if(s.version!==1||!Array.isArray(s.positions)||!Array.isArray(s.orders)||!Array.isArray(s.trades)||!s.config||!s.cash||!Array.isArray(s.live))throw new Error('Invalid IBKR laboratory ledger')
        this.state=s
        for(const def of IBKR_STRATEGIES)this.state.cash[def.id]??=startingCash
        for(const p of this.state.live)if(p.status==='submitting'){p.status='uncertain';p.message='Restart during submission; venue reconciliation required.'}
      }
    }catch(e){this.failure=`IBKR lab ledger unreadable; nothing will trade: ${String(e)}`}
    this.sources={discover:(now,report)=>discoverForecastMarkets(reader,now,report),settlements:loadFinalSettlements,spot:cryptoSpot,weather:ibkrWeather,...sources}
    if(sources.forecastProvider&&this.state.modelProvider!==sources.forecastProvider){
      this.state.previousModelBudget={provider:this.state.modelProvider??'configured provider',day:this.state.modelDay,calls:this.state.modelCalls}
      this.state.modelProvider=sources.forecastProvider;this.state.modelCalls=0;this.state.modelDay=day(Date.now())
      this.state.notes._model=`Forecast provider: ${sources.forecastProvider}; eight requests per UTC day. Previous provider attempts remain recorded.`
    }
  }
  private save(){try{writeFileAtomic(this.path,JSON.stringify(this.state))}catch(e){this.failure='IBKR laboratory storage failed; entries stopped';throw e}}
  status(now=Date.now()):IbkrLabStatus{
    const s=this.state
    const strategies:IbkrLabStrategyRow[]=IBKR_STRATEGIES.map(def=>{
      const all=s.trades.filter(t=>t.strategy===def.id),trades=all.filter(t=>t.openedAt>=IBKR_RULES_SINCE),legacy=all.filter(t=>t.openedAt<IBKR_RULES_SINCE),positions=s.positions.filter(p=>p.strategy===def.id)
      // Estimand: net per CONTRACT (contract-weighted), standard error clustered by day. The equal-day mean used
      // until 2026-09-19 could pass liveEligible on a strategy that lost money per contract (external review
      // §127, F-04). G = day clusters; se = sqrt(G/(G-1) x sum_d (S_d - n_d x mean)^2) / N.
      const stop=IBKR_RETIRED.get(def.id)
      const days=new Map<string,{n:number;sum:number}>();for(const t of trades){const key=day(t.closedAt),v=days.get(key)??{n:0,sum:0};v.n+=t.quantity;v.sum+=t.net;days.set(key,v)}
      const groups=[...days.values()],N=groups.reduce((a,g)=>a+g.n,0),mean=N?groups.reduce((a,g)=>a+g.sum,0)/N:0
      const se=groups.length>1&&N>0?Math.sqrt(groups.length/(groups.length-1)*groups.reduce((a,g)=>a+(g.sum-g.n*mean)**2,0))/N:Infinity
      const G=groups.length,critical=G<=2?12.706:G===3?4.303:G<=5?3.182:G<=10?2.776:G<=30?2.262:1.96
      const confidenceLow=Number.isFinite(se)?mean-critical*se:undefined
      let unrealized=0,unpriced=0
      for(const p of positions){const q=s.quotes[String((p.outcome==='YES'?p.market.no:p.market.yes).conId)];if(q&&freshAsk(q,now))unrealized+=(1-q.ask!-slippage-fee-p.entry)*p.quantity-p.entryFee;else unpriced++}
      const events=new Set(trades.map(t=>t.marketId.split('_').slice(0,-1).join('_'))).size
      const cappedDays=(s.cappedDays?.[def.id]??[]).filter(d=>days.has(d)).length
      const pending=s.orders.filter(o=>o.strategy===def.id).length
      // Section 142 read three arms as "0 trades, 0 edge" when they had fired and were holding contracts 12-58
      // days out, and a fourth as silent while it had orders resting. A row with no closed trade has to say WHICH
      // of the four it is, or the panel invites the same mistake: never signalled / resting / holding / closed.
      const blank=trades.length?'':positions.length?`No closed trade yet: holding ${positions.length}, the earliest settles ${new Date(Math.min(...positions.map(p=>p.market.expiresAt))).toISOString().slice(0,10)}. `
        :pending?`No fill yet: ${pending} order(s) resting. `:'No qualifying signal yet. '
      const wins=trades.filter(t=>t.net>0).length,losses=trades.filter(t=>t.net<0).length
      // The loss branch has to have been SAMPLED. A settlement arm that buys 89-97c favourites wins ~95% of the
      // time, so before its first loss the sample is near-deterministic: se collapses, the band tightens around a
      // mean that has never seen the payout it is exposed to, and the gate opens on what is the MODAL record of a
      // zero-edge arm (fade on 2026-09-20: 10 wins, 0 losses, observed sd 2.44c against ~35c on every sibling that
      // has taken one - a 14x understatement, and P(10 straight wins at fair prices) = 0.59). BACKLOG 141 answered
      // this for the Kalshi arm on 138 trades - "the arm wins exactly as often as its prices say it should, which
      // is the signature of NO edge" - and set the retest at 250 trades or 15 losses. Hold-to-settlement arms here
      // are the same instrument, so they carry the same bar. A zero-width band is never evidence either.
      const held=IBKR_HOLD_TO_SETTLEMENT.has(def.id)
      const sampled=!held||losses>=IBKR_MIN_LOSSES||trades.length>=IBKR_LOSS_WAIVER_TRADES
      const gateBlockers:string[]=[]
      if(stop)gateBlockers.push(stop)
      if(def.id==='benchmark')gateBlockers.push('control arm: never promoted')
      if(trades.length<30)gateBlockers.push(`${trades.length}/30 closed`)
      if(events<10)gateBlockers.push(`${events}/10 events`)
      if(days.size<3)gateBlockers.push(`${days.size}/3 day-clusters`)
      if(!sampled)gateBlockers.push(`${losses}/${IBKR_MIN_LOSSES} losses sampled (or ${trades.length}/${IBKR_LOSS_WAIVER_TRADES} trades)`)
      if(!(se>0)||!Number.isFinite(se))gateBlockers.push('no usable dispersion')
      if(!((confidenceLow??-1)>0))gateBlockers.push(`lower bound ${confidenceLow===undefined?'unavailable':confidenceLow.toFixed(2)+'c'}`)
      return {id:def.id,name:def.name,status:s.config.enabled?'Testing':'Entries paused',reason:blank+(s.notes[def.id]??def.description),fills:trades.length+positions.length,closed:trades.length,wins,losses,realized:round(trades.reduce((a,t)=>a+t.net,0)),unrealized:round(unrealized),unpriced,cash:s.cash[def.id]??startingCash,open:positions.length,pending,days:days.size,cappedDays,events,confidenceLow,legacyClosed:legacy.length,legacyRealized:round(legacy.reduce((a,t)=>a+t.net,0)),gateBlockers,liveEligible:gateBlockers.length===0}
    })
    for(const def of IBKR_UNAVAILABLE)strategies.push({id:def.id as any,name:def.name,status:'Not applicable',reason:def.reason,fills:0,closed:0,wins:0,losses:0,realized:0,unrealized:0,unpriced:0,cash:0,open:0,pending:0,days:0,cappedDays:0,events:0,confidenceLow:undefined,legacyClosed:0,legacyRealized:0,gateBlockers:['not available on this venue'],liveEligible:false})
    for(const row of strategies){if(row.status==='Not applicable'||IBKR_RETIRED.has(row.id))continue;if(!s.config.enabled)continue;row.status=this.failure?'Stopped':!s.scans?'Discovering':row.open?'Managing positions':row.pending?'Orders pending':'Watching for signals'}
    for(const row of strategies){const stop=IBKR_RETIRED.get(row.id);if(stop){row.status='Stopped (evidence)';row.reason=stop}}
    return {config:structuredClone(s.config),startedAt:s.startedAt,scans:s.scans,lastScanAt:s.lastScanAt,lastError:this.failure??s.lastError,running:this.busy,markets:s.markets.length,freshQuotes:Object.values(s.quotes).filter(q=>freshAsk(q,now)).length,strategies,trades:s.trades.slice(-100).reverse(),positions:structuredClone(s.positions),orders:structuredClone(s.orders),live:structuredClone(s.live),modelCalls:s.modelCalls,notes:Object.entries(s.notes).filter(([k])=>k.startsWith('_')).map(([,v])=>v)}
  }
  async configure(patch:Partial<IbkrLabConfig>){
    if(this.failure)throw new Error(this.failure)
    const config={...this.state.config,...patch}
    if(typeof config.enabled!=='boolean'||!['paper','live'].includes(config.mode)||!Array.isArray(config.liveStrategies)||config.liveStrategies.some(id=>!IBKR_STRATEGIES.some(s=>s.id===id)))throw new Error('Invalid IBKR lab configuration')
    if(!Number.isSafeInteger(config.contracts)||config.contracts<1||config.contracts>4||!Number.isSafeInteger(config.maxOpenPerStrategy)||config.maxOpenPerStrategy<1||config.maxOpenPerStrategy>10||!Number.isFinite(config.maxDailyLoss)||config.maxDailyLoss<=0||config.maxDailyLoss>50||!Number.isFinite(config.maxLiveCost)||config.maxLiveCost<=0||config.maxLiveCost>10)throw new Error('Invalid IBKR risk bounds')
    if(config.mode==='live'){
      if(!config.liveStrategies.length)throw new Error('Select at least one evidence-qualified strategy')
      const rows=this.status().strategies
      if(config.liveStrategies.some(id=>IBKR_RETIRED.has(id)))throw new Error('A strategy stopped on its own evidence cannot be enabled for live entry')
      if(config.liveStrategies.some(id=>!rows.find(r=>r.id===id)?.liveEligible)){
        const why=config.liveStrategies.map(id=>`${id}: ${(rows.find(r=>r.id===id)?.gateBlockers??['unknown']).join(', ')}`).join('; ')
        throw new Error(`Live entry requires 30 closed paper trades, 10 events, 3 day-clusters, a sampled loss branch and a positive day-cluster lower bound - ${why}`)
      }
      if(this.engine.getExecutionMode()!=='live')throw new Error('Oracle must be in Live mode; IBKR paper testing does not change Kalshi mode')
      if((await this.venue.getAccount()).balance<config.maxLiveCost)throw new Error('Fund IBKR before enabling live strategy orders')
    }
    this.state.config=config;this.save();return this.status()
  }
  async scan(now=Date.now()){
    if(this.busy||this.failure)return
    this.busy=true
    try{
      const s=this.state
      // A failed discovery cannot succeed before the Gateway is back, and each attempt logs a line per product
      // and month: 164 lines a minute while it was down (2026-09-17T03:53Z). Retry every 10 min instead of
      // every scan, except with no universe at all, where nothing else in the scan has anything to work on.
      const discoveryReady=!s.markets.length||now-this.discoveryFailedAt>10*60000
      if(discoveryReady&&(!s.markets.length||now-(s.discoveryAt??0)>6*3600000)){
        try{s.notes._discovery='Discovering exact exchange/IBKR contract matches'
          // Discovery reports a failed product month as "<PRODUCT> <yyyy-mm>: <error>" and carries on. Written wholesale, a
          // gateway hiccup mid-walk dropped those products for six hours; keep their previous contracts and retry in 30 min.
          const failed=new Set<string>()
          const found=await this.sources.discover(now,m=>{const f=/^(\S+) \d{4}-\d{2}: /.exec(m);if(f)failed.add(f[1]);s.notes._discovery=m;console.log('[ibkr-lab]',m)})
          const kept=s.markets.filter(m=>failed.has(m.product)&&m.closeTime>now&&!found.some(x=>x.id===m.id))
          s.markets=[...found,...kept];s.discoveryAt=failed.size?Date.now()-6*3600000+30*60000:Date.now()
          s.notes._discovery=`${s.markets.length} exact contracts discovered at ${new Date().toLocaleTimeString()}`+(failed.size?`; ${failed.size} product(s) failed, previous contracts kept, retry in 30 minutes`:'')}
        catch(e){this.discoveryFailedAt=now;s.notes._discovery=String(e);if(!s.markets.length)throw e}
      }
      const universe=new Map(s.markets.map(m=>[m.id,m]));for(const p of s.positions)universe.set(p.market.id,p.market)
      for(const p of s.live)if(p.status==='open')universe.set(p.market.id,p.market)
      const all=[...universe.values()].filter(m=>m.closeTime>Date.now())
      const priority=new Set([...s.orders.map(o=>o.marketId),...s.positions.map(p=>p.market.id),...s.live.filter(p=>p.status==='open').map(p=>p.market.id)])
      const active=all.filter(m=>priority.has(m.id)),rotated=all.map((_,i)=>all[(i+this.cursor)%all.length])
      const batch=[...new Map([...active.slice(this.cursor%Math.max(1,active.length),this.cursor%Math.max(1,active.length)+10),...rotated].map(m=>[m.id,m])).values()].slice(0,30)
      this.cursor+=20
      const spotByProduct=new Map<string,Awaited<ReturnType<IbkrLabSources['spot']>>>()
      const weatherByMarket=new Map<string,Awaited<ReturnType<IbkrLabSources['weather']>>>()
      await Promise.all([...new Set(batch.map(m=>m.product).filter(p=>/^CF(BTC|ETH|SOL|XRP)$/.test(p)))].map(async product=>{
        try{spotByProduct.set(product,await this.sources.spot(product,Date.now()))}catch(e){s.notes['spot-first']=String(e)}
      }))
      await Promise.all(batch.filter(m=>/^U[HL]/.test(m.product)).map(async m=>{try{weatherByMarket.set(m.id,await this.sources.weather(m,Date.now()))}catch(e){s.notes['weather-forecast']=String(e)}}))
      if(batch.length){
        const quotes=await this.reader.quotes(batch.flatMap(m=>[m.yes.conId,m.no.conId]))
        for(const q of quotes)s.quotes[String(q.conId)]=q
        // Append-only quote log for the Kalshi <-> ForecastEx same-event shadow (backlog 150): the lab keeps only the
        // latest quote per contract, and a cross-venue read needs the history on both sides.
        try{const dir=join(dirname(this.path),'ibkr-quotes');mkdirSync(dir,{recursive:true})
          const at=new Date().toISOString(),lines=quotes.filter(q=>q.dataType==='live'&&!q.error).map(q=>JSON.stringify({at,conId:q.conId,ask:q.ask,askSize:q.askSize,bid:q.bid,bidSize:q.bidSize}))
          if(lines.length)appendFileSync(join(dir,`${at.slice(0,10)}.jsonl`),lines.join('\n')+'\n')}catch{}
        const failures=quotes.filter(q=>q.error),fresh=quotes.filter(q=>freshAsk(q,Date.now())).length
        s.notes._quotes=`Latest batch: ${fresh}/${quotes.length} executable outcome quotes. ${failures.length?`${failures.length} unavailable: ${[...new Set(failures.map(q=>q.error))].join('; ')}`:'Missing prices or size are skipped.'}`
        appendFileSync(this.path+`.quotes-${day(Date.now())}.jsonl`,JSON.stringify({at:Date.now(),quotes})+'\n')
      }
      now=Date.now()
      const frames:LabFrame[]=[]
      for(const m of batch){const yes=s.quotes[String(m.yes.conId)],no=s.quotes[String(m.no.conId)];if(!yes||!no)continue
        const history=s.histories[m.id]??[];const f:LabFrame={market:m,yes,no,history,forecast:s.forecast[m.id],spot:spotByProduct.get(m.product),weather:weatherByMarket.get(m.id)}
        if(freshAsk(yes,now)&&freshAsk(no,now)){frames.push(f);s.histories[m.id]=[...history,{at:now,p:frameMid(f)}].filter(x=>x.at>=now-2*3600000).slice(-240)}
      }
      this.fillOrders(now,universe)
      this.closePositions(now)
      if(s.positions.some(p=>p.market.expiresAt<now)||s.live.some(p=>p.status==='open'&&p.market.expiresAt<now)){
        if(now-this.lastSettlementAt>3600000){this.lastSettlementAt=now;try{const oldest=Math.min(...s.positions.map(p=>p.market.expiresAt),...s.live.filter(p=>p.status==='open').map(p=>p.market.expiresAt));this.settle(await this.sources.settlements(now,oldest),now)}catch(e){s.notes._settlements=String(e)}}
      }
      if(s.config.enabled){
        for(const sig of ibkrSignals(frames,now)){
          if(IBKR_RETIRED.has(sig.strategy))continue   // stopped on its own evidence; the ledger stays, admission does not
          const key=`${sig.strategy}:${sig.marketId}:${sig.outcome}:${day(now)}`
          if(s.seen[key]||s.orders.some(o=>o.strategy===sig.strategy&&o.marketId===sig.marketId&&o.outcome===sig.outcome)||s.positions.some(p=>p.strategy===sig.strategy&&p.market.id===sig.marketId&&p.outcome===sig.outcome))continue
          // A DIRECTIONAL arm must never end up long both sides of one market. The dedupe above is keyed on the
          // outcome and the `seen` key carries the UTC day, so an arm that flipped side on a later day bought the
          // other leg and the $1 pairing below then booked the pair as one trade - seven such rows exist, and a
          // single one contributes -80c of favorite's -68c over 11 trades (audit B-195, section 143). A basket
          // signal is exempt: buying both legs is its whole hypothesis and it carries `basket`.
          if(!sig.basket&&(s.positions.some(p=>p.strategy===sig.strategy&&p.market.id===sig.marketId&&p.outcome!==sig.outcome&&!p.basket)||s.orders.some(o=>o.strategy===sig.strategy&&o.marketId===sig.marketId&&o.outcome!==sig.outcome&&!o.basket)))continue
          const exposure=s.positions.filter(p=>p.strategy===sig.strategy).length+s.orders.filter(o=>o.strategy===sig.strategy).length
          // Held positions occupy slots for days; four slots would stop a settlement arm after its first four entries.
          const slots=IBKR_HOLD_TO_SETTLEMENT.has(sig.strategy)?Math.max(12,s.config.maxOpenPerStrategy):s.config.maxOpenPerStrategy
          if(exposure>=slots||this.dailyLoss(sig.strategy,now))continue
          if((s.cash[sig.strategy]??0)<(sig.limit+fee)*s.config.contracts)continue
          s.orders.push({id:randomUUID(),...sig,quantity:s.config.contracts,createdAt:now,expiresAt:now+(sig.maker?60:2)*60000})
          s.seen[key]=now;s.notes[sig.strategy]=sig.reason
        }
      }
      s.scans++;s.lastScanAt=now;s.lastError=undefined
      for(const k of Object.keys(s.seen))if(now-s.seen[k]>3*86400000)delete s.seen[k]
      this.save()
      void this.runForecast(frames,now).catch(e=>{s.notes.news=String(e)})
      void this.reconcileLive(now).catch(e=>{s.notes._live=String(e)})
      console.log(`[ibkr-lab] ${s.config.mode}; scan ${s.scans}; ${frames.length}/${batch.length} fresh pairs; ${s.orders.length} pending; ${s.positions.length} paper positions; ${s.trades.length} closed`)
    }catch(e){this.state.lastError=String(e);try{this.save()}catch{};console.warn('[ibkr-lab]',String(e))}
    finally{this.busy=false}
  }
  /**
   * True once an arm has lost its daily allowance, which stops its entries for the rest of the UTC day. That is a
   * risk control and stays, but it truncates the day CONDITIONAL ON LOSSES, and the UTC day is the cluster unit
   * both standard errors are built on: a capped day is a short day, and short days are the losing ones (audit
   * B-196). `cappedDays` counts them so a read can say so instead of quietly inheriting the bias.
   */
  private dailyLoss(strategy:string,now:number){
    const capped=this.state.trades.filter(t=>t.strategy===strategy&&sameDay(t.closedAt,now)).reduce((a,t)=>a+t.net,0)<=-this.state.config.maxDailyLoss
    if(capped){const d=(this.state.cappedDays??={});(d[strategy]??=[]).includes(day(now))||d[strategy].push(day(now))}
    return capped
  }
  private fillOrders(now:number,markets:Map<string,IbkrLabMarket>){
    const s=this.state,keep:typeof s.orders=[],used=new Map<string,number>()
    for(const o of s.orders){
      const m=markets.get(o.marketId),q=m&&s.quotes[String((o.outcome==='YES'?m.yes:m.no).conId)]
      if(o.expiresAt<=now||!m||m.closeTime<=now||this.dailyLoss(o.strategy,now)||IBKR_RETIRED.has(o.strategy))continue
      if(!s.config.enabled)continue
      const key=`${o.strategy}:${m.id}:${o.outcome}`,available=(q?.askSize??0)-(used.get(key)??0)
      if(!q||!freshAsk(q,now)||(q.askAt??0)<=o.createdAt+1000||available<1){keep.push(o);continue}
      const price=o.maker?o.limit:round(q.ask!+slippage)
      if(o.maker?q.ask!>o.limit-.01+1e-8:price>o.limit+1e-8){keep.push(o);continue}
      const opposite=s.quotes[String((o.outcome==='YES'?m.no:m.yes).conId)]
      const hold=IBKR_HOLD_TO_SETTLEMENT.has(o.strategy)
      if(!o.basket&&!hold&&(!opposite||!freshAsk(opposite,now)||price+opposite.ask!+slippage+2*fee-1>=.08-1e-8)){keep.push(o);continue}
      const quantity=Math.min(o.quantity,Math.floor(available)),cost=(price+fee)*quantity
      if(cost>(s.cash[o.strategy]??0))continue
      s.cash[o.strategy]=round(s.cash[o.strategy]-cost);used.set(key,(used.get(key)??0)+quantity)
      const entryMark=opposite&&freshAsk(opposite,now)?round(1-opposite.ask!-slippage-price-2*fee):undefined
      const p:IbkrLabPosition={id:randomUUID(),strategy:o.strategy,market:m,outcome:o.outcome,quantity,entry:price,entryFee:fee*quantity,openedAt:now,reason:o.reason,basket:o.basket,entryMark,entryMarkAt:entryMark===undefined?undefined:now}
      s.positions.push(p)
      if(s.config.mode==='live'&&s.config.liveStrategies.includes(o.strategy))void this.enterLive(p,o.limit).catch(e=>{s.notes._live=String(e)})
      // IOC-style partial taker fills do not invent the unfilled remainder. Passive remainders stay queued.
      if(o.maker&&quantity<o.quantity)keep.push({...o,quantity:o.quantity-quantity})
    }
    s.orders=keep
    // ForecastEx nets opposing positions at $1. Keep the paired result as one closed trade.
    for(const p of [...s.positions]){if(!s.positions.includes(p))continue;const other=s.positions.find(x=>x!==p&&x.strategy===p.strategy&&x.market.id===p.market.id&&x.outcome!==p.outcome)
      if(!other)continue
      const qty=Math.min(p.quantity,other.quantity),fees=(p.entryFee/p.quantity+other.entryFee/other.quantity)*qty
      // `entry` here is the cost of ONE PAIR and therefore can exceed 1 (observed up to 1.78). Every other trade
      // row carries a single-leg price, so anything computing a per-contract price statistic - the calibration
      // check BACKLOG 141 prescribes for the 2026-09-26 read - has to skip these. `paired` is that flag.
      s.trades.push({id:randomUUID(),paired:true,strategy:p.strategy,marketId:p.market.id,question:p.market.question+' (YES/NO pair)',outcome:p.outcome,quantity:qty,entry:p.entry+other.entry,exit:1,fees,net:round((1-p.entry-other.entry)*qty-fees),openedAt:Math.min(p.openedAt,other.openedAt),closedAt:now,reason:'Opposing contracts paired at $1'})
      s.cash[p.strategy]=round(s.cash[p.strategy]+qty)
      for(const position of [p,other]){position.entryFee*=1-qty/position.quantity;position.quantity-=qty;if(!position.quantity)s.positions=s.positions.filter(x=>x!==position)}
    }
  }
  private closePositions(now:number){
    const s=this.state
    for(const p of [...s.positions]){
      if(p.basket&&(s.positions.some(other=>other!==p&&other.basket===p.basket)||now-p.openedAt<120000))continue
      if(!p.basket&&IBKR_HOLD_TO_SETTLEMENT.has(p.strategy))continue // settled by the published final value
      const q=s.quotes[String((p.outcome==='YES'?p.market.no:p.market.yes).conId)]
      if(p.market.closeTime<=now||!q||!freshAsk(q,now)||(q.askAt??0)<=p.openedAt+1000||q.askSize!<p.quantity)continue
      // The old guard refused the exit whenever the opposing ask left our side worth under a cent, which is
      // exactly a near-total LOSS. Those positions never closed, so they never entered `realized` - the only
      // number the promotion gate reads - while every winner did: a one-sided censor on the statistic that
      // promotes an arm to real money (audit B-196, section 143). The guard existed to avoid a negative exit
      // price; clamping at zero says the same thing truthfully, because a contract whose other side is offered at
      // 99c is worth nothing. This un-censors 98c < ask <= 99c only: above that `freshAsk` refuses the quote
      // outright (ask <= .99), which is a WIDER censor on the same tail and is shared with the entry path, so it
      // needs its own decision (BACKLOG 200). Paper ledger only - the live path never comes through here.
      const exit=Math.max(0,1-q.ask!-slippage),net=(exit-p.entry)*p.quantity-p.entryFee-fee*p.quantity
      // One exit policy, paper and live: price exits measure movement from the first fresh valuation at or after the
      // fill. Without one there is nothing to measure from; take it now (movement zero) rather than switch to the
      // absolute-loss stop the round-114 rules replaced. Time and pre-close exits still apply.
      if(p.entryMark===undefined){p.entryMark=round(net/p.quantity);p.entryMarkAt=now}
      const move=net/p.quantity-p.entryMark
      if(move<.05&&move>-.08&&now-p.openedAt<3600000&&p.market.closeTime-now>10*60000)continue
      this.close(p,exit,fee*p.quantity,now,net>=0?'Profit / time exit via opposing ask':'Risk / time exit via opposing ask')
    }
  }
  private close(p:IbkrLabPosition,exit:number,exitFee:number,now:number,reason:string){
    const s=this.state,fees=p.entryFee+exitFee
    s.trades.push({id:randomUUID(),strategy:p.strategy,marketId:p.market.id,question:p.market.question,outcome:p.outcome,quantity:p.quantity,entry:p.entry,exit,fees,net:round((exit-p.entry)*p.quantity-fees),openedAt:p.openedAt,closedAt:now,reason})
    s.cash[p.strategy]=round(s.cash[p.strategy]+exit*p.quantity-exitFee);s.positions=s.positions.filter(x=>x!==p)
  }
  private settle(results:Map<string,number>,now:number){
    for(const p of [...this.state.positions]){const win=results.get(p.market.id);if(win!==undefined&&now>=p.market.expiresAt)this.close(p,p.outcome==='YES'?win:1-win,0,now,'Published ForecastEx final settlement')}
    for(const p of this.state.live){const win=results.get(p.market.id);if(p.status==='open'&&p.ordersComplete&&p.filled>p.exitFilled+(p.paired??0)&&win!==undefined&&now>=p.market.expiresAt){p.net=round((p.outcome==='YES'?win:1-win)*(p.filled-p.exitFilled-(p.paired??0))+(p.pairRevenue??0)+p.exitFilled-p.entryCost-p.exitCost-p.fees);p.status='closed';p.message='Exchange final settlement; excludes coupon/interest income'}}
  }
  private async runForecast(frames:LabFrame[],now:number){
    const s=this.state;if(this.modelBusy||!this.sources.forecast||!s.config.enabled)return
    if(s.modelDay!==day(now)){s.modelDay=day(now);s.modelCalls=0}
    if(s.modelCalls>=8){s.notes.news='Daily eight-call forecast budget reached';return}
    const attempts=s.forecastAttempts??={}
    // news and market-conditioned are hold-to-settlement, so ibkrSignals refuses anything expiring past
    // IBKR_HOLD_MAX_DAYS. Asking the model about those contracts spends the day's budget on entries that can never
    // be taken: 13 of 28 calls on 2026-09-18..20 went to paper outside the horizon (section 143).
    const candidates=frames.filter(f=>f.market.closeTime-now>3600000&&f.market.expiresAt-now<=IBKR_HOLD_MAX_DAYS*86400000&&now-(attempts[f.market.id]??0)>6*3600000&&(!s.forecast[f.market.id]||now-s.forecast[f.market.id].at>6*3600000))
    const f=candidates.find(f=>!/^(CF|U[HL])/.test(f.market.product))??candidates[0]
    if(!f)return
    this.modelBusy=true;s.modelCalls++;attempts[f.market.id]=now;s.notes.news=`Requesting forecast from ${s.modelProvider??'configured model'}`;this.save()
    try{const v=await this.sources.forecast(f.market,frameMid(f));appendFileSync(this.path+'.forecasts.jsonl',JSON.stringify({at:Date.now(),market:f.market,marketProbability:frameMid(f),provider:s.modelProvider,verdict:v??null})+'\n');if(v&&Number.isFinite(v.p)&&v.p>0&&v.p<1){s.forecast[f.market.id]={...v,at:Date.now()};s.notes.news=(v.approved===false?'Probability recorded although the model declined to recommend a trade: ':'')+v.reason}else s.notes.news=v?.reason??'Model abstained; no invented forecast';this.save()}
    finally{this.modelBusy=false}
  }
  private async enterLive(p:IbkrLabPosition,limit:number){
    const s=this.state
    if(this.failure||s.config.mode!=='live'||!s.config.liveStrategies.includes(p.strategy)||this.engine.getExecutionMode()!=='live')return
    // One strategy owns each event in the real account: cross-strategy netting would destroy attribution.
    if(s.live.some(l=>l.market.id===p.market.id&&l.status!=='closed'&&(l.strategy!==p.strategy||l.outcome===p.outcome)))return
    if(s.live.filter(l=>l.strategy===p.strategy&&l.status!=='closed').length>=s.config.maxOpenPerStrategy)return
    if(s.live.filter(l=>sameDay(l.createdAt,Date.now())).reduce((a,l)=>a+(l.net??0),0)<=-s.config.maxDailyLoss)return
    const id=randomUUID(),ref=`ibkr-lab:${p.strategy}:${id}:entry`
    const live={id,strategy:p.strategy,market:p.market,outcome:p.outcome,quantity:p.quantity,createdAt:Date.now(),status:'submitting' as const,filled:0,exitFilled:0,entryCost:0,exitCost:0,fees:0,pendingRef:ref,entryRef:ref,basket:p.basket}
    s.live.push(live);this.save()
    const record=s.live.at(-1)!
    try{const r=await this.engine.placeOrder({venue:'ibkr',ref,marketId:String((p.outcome==='YES'?p.market.yes:p.market.no).conId),outcome:p.outcome,contracts:p.quantity,limitPrice:limit,amount:s.config.maxLiveCost,timeInForce:'immediate_or_cancel'});record.orderId=r.orderId;record.status='open';record.pendingRef=undefined;record.message=r.venueStatus}
    catch(e){record.status='uncertain';record.message=String(e)}
    this.save()
  }
  private async reconcileLive(now:number){
    if(this.liveBusy||!this.state.live.some(p=>p.status==='open'||p.status==='uncertain'))return
    this.liveBusy=true
    try{
      await this.engine.reconcileOrders('ibkr')
      const fills=await this.venue.getFills(),open=await this.venue.getOpenOrders(),completed=await this.venue.reader.completed()
      // A TWS COMPLETED_ORDER carries orderRef and permId but NO orderId/clientId (decoder.js decodeMsg_COMPLETED_ORDER), so
      // matching completed rows by `${clientId}:${orderId}` was never true and no live exit could ever submit (audit
      // 2026-09-19, B-07). Our orderRef is the journal's client id, unique per submission; match on it, and on the
      // permId the open-order snapshot reported for that order id when we have one.
      const permIdOf=(id:string)=>this.permIds.get(id)
      const terminal=(id:string|undefined,filled:number,ref?:string)=>{
        if(!id||open.some(o=>o.orderId===id))return false
        const row=completed.find(o=>(ref&&o.order.orderRef===ref)||(o.order.permId!==undefined&&o.order.permId===permIdOf(id))||`${o.order.clientId}:${o.order.orderId}`===id)
        return !!row&&/^(Filled|Cancelled|Canceled|ApiCancelled|Inactive)$/i.test(row.state.status??row.state.completedStatus??'')&&Number.isFinite(row.order.filledQuantity)&&row.order.filledQuantity===filled
      }
      for(const o of open)if(o.permId!==undefined)this.permIds.set(o.orderId,o.permId)
      for(const p of this.state.live.filter(p=>p.status==='open'||p.status==='uncertain')){
        if(p.status==='uncertain'&&p.pendingRef){
          const intent=this.engine.orderIntent('ibkr',p.pendingRef),isExit=p.pendingRef.includes(':exit:')
          if(intent?.state==='acknowledged'&&intent.orderId){
            if(isExit){p.exitOrderId=intent.orderId;(p.exitOrderIds??=[]).push(intent.orderId);(p.exitRefs??={})[intent.orderId]=p.pendingRef}else p.orderId=intent.orderId
            p.status='open';p.pendingRef=undefined
          }else if(!intent||intent.state==='rejected'){p.status=isExit?'open':'closed';p.pendingRef=undefined;p.message='Order rejected before acceptance';if(!isExit)p.net=0}
          else continue
        }
        if(p.status!=='open')continue
        const ids=p.exitOrderIds??(p.exitOrderId?[p.exitOrderId]:[])
        const executions=p.executions??={}
        for(const f of fills)if(f.orderId===p.orderId||ids.includes(f.orderId??''))executions[f.id]=f
        const entries=Object.values(executions).filter(f=>f.orderId===p.orderId),exits=Object.values(executions).filter(f=>ids.includes(f.orderId??''))
        p.filled=entries.reduce((a,f)=>a+f.shares,0);p.entryCost=entries.reduce((a,f)=>a+f.shares*f.price,0)
        p.exitFilled=exits.reduce((a,f)=>a+f.shares,0);p.exitCost=exits.reduce((a,f)=>a+f.shares*f.price,0)
        p.fees=[...entries,...exits].reduce((a,f)=>a+f.fee,0)
        if(p.filled&&p.entryMark==null){
          // Paper's price exits measure movement from the first fresh valuation at or after the fill (round 114); live uses
          // the same rule or a strategy qualifies on exits it will not reproduce. A stale quote leaves the mark unset (and
          // no price exit can be judged on a stale quote anyway); it is taken on the first fresh one, then fixed.
          const q=this.state.quotes[String((p.outcome==='YES'?p.market.no:p.market.yes).conId)]
          if(q&&freshAsk(q,now)&&q.ask!+slippage<=.99){p.entryMark=round(1-q.ask!-slippage-fee-(p.entryCost+p.fees)/p.filled);p.entryMarkAt=now}
        }
        p.ordersComplete=(p.filled===p.quantity||terminal(p.orderId,p.filled,p.entryRef))&&ids.every(id=>terminal(id,exits.filter(f=>f.orderId===id).reduce((a,f)=>a+f.shares,0),p.exitRefs?.[id]))
        if(p.exitFilled+(p.paired??0)>p.filled){p.status='uncertain';p.message='Execution totals exceed holdings; entries held for reconciliation';continue}
        if(!p.filled&&terminal(p.orderId,0,p.entryRef)){p.net=0;p.status='closed';p.message='IOC completed without a fill';continue}
        if(p.filled&&p.exitFilled+(p.paired??0)>=p.filled){p.net=round((p.pairRevenue??0)+p.exitFilled-p.entryCost-p.exitCost-p.fees);p.status='closed';continue}
      }
      // Account-level netting precedes any exit decision; otherwise a just-paired position looks closable twice.
      for(const p of this.state.live.filter(p=>p.status==='open')){
        const other=this.state.live.find(x=>x!==p&&x.status==='open'&&x.strategy===p.strategy&&x.market.id===p.market.id&&x.outcome!==p.outcome)
        if(!other)continue
        const qty=Math.min(p.filled-p.exitFilled-(p.paired??0),other.filled-other.exitFilled-(other.paired??0))
        if(qty<=0)continue
        for(const leg of [p,other]){leg.paired=(leg.paired??0)+qty;leg.pairRevenue=(leg.pairRevenue??0)+qty/2}
      }
      for(const p of this.state.live.filter(p=>p.status==='open')){
        if(p.filled&&p.exitFilled+(p.paired??0)>=p.filled){p.net=round((p.pairRevenue??0)+p.exitFilled-p.entryCost-p.exitCost-p.fees);p.status='closed';continue}
        const ids=p.exitOrderIds??(p.exitOrderId?[p.exitOrderId]:[]),exits=Object.values(p.executions??{}).filter(f=>ids.includes(f.orderId??''))
        if(p.basket&&(this.state.live.some(other=>other!==p&&other.status==='open'&&other.filled>other.exitFilled+(other.paired??0)&&other.basket===p.basket)||now-p.createdAt<120000))continue
        if(!p.filled||now-p.createdAt<60000||now-(p.lastExitAt??0)<60000||this.engine.getExecutionMode()!=='live')continue
        if(!terminal(p.orderId,p.filled,p.entryRef)||ids.some(id=>!terminal(id,exits.filter(f=>f.orderId===id).reduce((a,f)=>a+f.shares,0),p.exitRefs?.[id])))continue
        if(!p.basket&&IBKR_HOLD_TO_SETTLEMENT.has(p.strategy))continue
        const remaining=p.filled-p.exitFilled-(p.paired??0)
        const q=this.state.quotes[String((p.outcome==='YES'?p.market.no:p.market.yes).conId)]
        if(p.market.closeTime<=now||!q||!freshAsk(q,Date.now())||q.askSize!<remaining||q.ask!+slippage>.99)continue
        const edge=1-q.ask!-slippage-fee-(p.entryCost+p.fees)/p.filled
        if(p.entryMark==null)continue // unreachable with a fresh quote; never fall back to an absolute stop
        const move=edge-p.entryMark
        if(move<.05&&move>-.08&&now-p.createdAt<3600000&&p.market.closeTime-now>10*60000)continue
        p.exitAttempt=(p.exitAttempt??0)+1;p.pendingRef=`ibkr-lab:${p.strategy}:${p.id}:exit:${p.exitAttempt}`;p.lastExitAt=now
        p.status='submitting';p.ordersComplete=false;this.save()
        try{const r=await this.engine.sellPosition({venue:'ibkr',marketId:String((p.outcome==='YES'?p.market.yes:p.market.no).conId),outcome:p.outcome,shares:remaining,limitPrice:p.outcome==='YES'?round(1-q.ask!-slippage):round(q.ask!+slippage),timeInForce:'immediate_or_cancel',ref:p.pendingRef});p.exitOrderId=r.orderId;(p.exitOrderIds??=[]).push(r.orderId);(p.exitRefs??={})[r.orderId]=p.pendingRef!;p.pendingRef=undefined;p.status='open'}catch(e){p.status='uncertain';p.message=String(e)}
      }
      this.save()
    }finally{this.liveBusy=false}
  }
}

const spotCache=new Map<string,{price:number;annualVol:number;at:number}>()
export async function cryptoSpot(product:string,now:number){
  if(!/^CF(BTC|ETH|SOL|XRP)$/.test(product))return undefined
  const cached=spotCache.get(product);if(cached&&now-cached.at<15000)return cached
  const coin=product.slice(2),base=`https://api.exchange.coinbase.com/products/${coin}-USD`
  const [ticker,candles]=await Promise.all([fetch(base+'/ticker',{signal:AbortSignal.timeout(8000)}).then(r=>{if(!r.ok)throw new Error('Coinbase spot unavailable');return r.json()}),fetch(base+'/candles?granularity=300',{signal:AbortSignal.timeout(8000)}).then(r=>{if(!r.ok)throw new Error('Coinbase volatility history unavailable');return r.json()})])
  if(!Array.isArray(candles)||candles.length<24)throw new Error('Insufficient observed crypto volatility')
  const sorted=candles.filter(c=>Array.isArray(c)&&Number(c[4])>0).sort((a,b)=>a[0]-b[0]).slice(-288)
  const returns=sorted.slice(1).map((c,i)=>Math.log(c[4]/sorted[i][4])),mean=returns.reduce((a,b)=>a+b,0)/returns.length
  const annualVol=Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/(returns.length-1))*Math.sqrt(365.25*86400/300)
  const result={price:Number(ticker.price),annualVol,at:Date.parse(ticker.time)}
  if(!Number.isFinite(result.price)||result.price<=0||!Number.isFinite(annualVol)||annualVol<=0||now-result.at>30000)throw new Error('Crypto source stale or invalid')
  spotCache.set(product,result);return result
}
