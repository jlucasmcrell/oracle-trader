import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PolyPaperLab,polyPaperFee,polyPaperOrderFee,polyPaperQuote,polyPaperSignals} from '../../src/main/strategies/polyPaper'
import type {VenueMarket,OrderBook} from '../../src/shared/types'
import {POLY_PAPER_RULES_SINCE} from '../../src/shared/polyPaper'
const root=mkdtempSync(join(tmpdir(),'oracle-poly-paper-')),base=Date.parse('2026-09-16T19:00Z')
let now=base,seq=0
const market:VenueMarket={id:'test',venue:'polymarket-us',question:'Fixture',status:'open',outcomeType:'BINARY',closeTime:base+3600000,tickSize:.01}
const book=(bid=.45,ask=.49,size=10):OrderBook=>({venue:'polymarket-us',marketId:'test',bids:[{price:bid,size}],asks:[{price:ask,size}]})
const quote=polyPaperQuote(book(),now)!
assert.equal(polyPaperQuote(book(.6,.4),now),undefined)
assert.equal(polyPaperQuote(book(.4,.5,.5),now),undefined)
assert.equal(polyPaperFee(.5,base),.015)
assert.equal(polyPaperFee(.5,Date.parse('2026-09-17T03:59Z')),.0695/4)
assert.equal(polyPaperFee(.5,base,true),-.0125*.25,'maker rebate at the venue formula')
assert.equal(polyPaperOrderFee(1,.5,base,true),0,'one contract: the rebate rounds to zero, as billed')
assert.equal(polyPaperOrderFee(100,.5,base,true),-.31,'100 contracts at 50c: -$0.31, the documented table value')
assert.equal(polyPaperFee(.5,base,false,.1),.025)
// The venue bills the ORDER TOTAL to the nearest cent (measured on 432 real fills); the
// per-share helper above stays exact, the order helper is what the ledger charges.
assert.equal(polyPaperOrderFee(1,.5,base),.02)
assert.equal(polyPaperOrderFee(1,.5,Date.parse('2026-09-17T03:59Z')),.02)
assert.equal(polyPaperOrderFee(1,.5,base,true),0)
assert(Math.abs(polyPaperOrderFee(10,.5,base)-.15)<1e-9)
assert.equal(polyPaperOrderFee(1,.06,base),0,'a 1-share 6c buy bills zero after cent rounding')
assert.equal(polyPaperOrderFee(1,.94,base),0)
const all=new Set<string>()
for(const q of [quote,{...quote,bid:.06,ask:.09},{...quote,bid:.91,ask:.94},{...quote,pressure:4}])for(const h of [[],[{at:now-6*60000,mid:.35}]])for(const s of polyPaperSignals(market,q,h,now))all.add(s.strategy)
assert.equal(all.size,8,'All registered strategies reachable')
assert(polyPaperSignals(market,{...quote,bid:.06,ask:.09},[],now).some(s=>s.strategy==='longshot'&&!s.maker),'Longshot control takes the ask')
assert.equal(polyPaperSignals({...market,minTradeQty:2},quote,[],now).length,0)
assert.equal(polyPaperSignals({...market,closeTime:now},quote,[],now).length,0)
function setup(){
 const path=join(root,`${++seq}.json`)
 let current=book(),resolved:VenueMarket={...market}
 const venue={searchMarkets:async()=>[market],getMarket:async()=>resolved,getOrderBook:async()=>current}
 const lab=new PolyPaperLab(path,venue,()=>now)
 return {lab,path,venue,setBook:(b:OrderBook)=>{current=b},resolve:(m:VenueMarket)=>{resolved=m},state:()=>JSON.parse(readFileSync(path,'utf8'))}
}
async function main(){
 const x=setup();await x.lab.scan();assert.equal(x.lab.status().positions.length,0,'No same-snapshot fills')
 await x.lab.scan();assert.equal(x.lab.status().positions.length,0,'No fill at identical timestamp')
 now+=60000;await x.lab.scan();assert(x.lab.status().positions.some(p=>p.strategy==='benchmark'));assert(!x.lab.status().positions.some(p=>p.strategy==='join'),'Bid touch does not fill a passive order')
 // Round 114: an unchanged book is not a loss. From the entry price the taker round trip alone crossed the -5c stop.
 now+=60000;await x.lab.scan();assert(x.lab.status().positions.some(p=>p.strategy==='benchmark'),'Taker position survives an unchanged next quote')
 assert(!x.lab.status().trades.some(t=>t.strategy==='benchmark'&&t.reason==='loss stop'),'No loss stop without a price move')
 x.setBook(book(.43,.45));now+=60000;await x.lab.scan();assert(!x.lab.status().positions.some(p=>p.strategy==='join'&&p.side==='YES'),'Touching the resting limit is not a fill')
 x.setBook(book(.43,.44));now+=60000;await x.lab.scan();assert(x.lab.status().positions.some(p=>p.strategy==='join'&&p.side==='YES'),'Trade-through fills resting bid')
 const saved=x.state();const reload=new PolyPaperLab(x.path,x.venue,()=>now);assert.deepEqual(reload.status().positions,x.lab.status().positions,'Restart preserves positions')
 x.lab.setEnabled(false);assert.equal(x.lab.status().orders.length,0);assert(x.lab.status().positions.length>0)
 now+=16*60000;await x.lab.scan();assert(x.lab.status().trades.length>0,'Paused entries still manage exits')
 for(const s of x.lab.status().strategies){const positions=x.lab.status().positions.filter(p=>p.strategy===s.id);assert(Math.abs(s.cash-(1000+s.net+s.legacyNet-positions.reduce((n,p)=>n+p.entry+p.fee,0)))<1e-8,'Cash reconciles after fees')}
 assert(saved.positions.every((p:any)=>p.entry>0&&p.entry<1))
 // Cohorts: trades opened before the current rules are history only; the scorecard counts the rest.
 {const c=setup();await c.lab.scan();const st=c.state(),t0={strategy:'favorite',market,side:'YES',entry:.5,fee:0,exit:.6,exitFee:0,net:.1,closed:POLY_PAPER_RULES_SINCE+86400000,reason:'Fixture'}
  st.orders=[];st.positions=[];st.trades=[{...t0,id:'old',opened:POLY_PAPER_RULES_SINCE-1},{...t0,id:'new1',opened:POLY_PAPER_RULES_SINCE,net:-.2},{...t0,id:'new2',opened:POLY_PAPER_RULES_SINCE+5,net:.05}]
  writeFileSync(c.path,JSON.stringify(st));const row=new PolyPaperLab(c.path,c.venue,()=>now).status().strategies.find(r=>r.id==='favorite')!
  assert.deepEqual([row.closed,row.legacyClosed,+row.net.toFixed(8),+row.legacyNet.toFixed(8)],[2,1,-.15,.1],'Old-rule trades are reported apart and excluded from the assessment')}
 // Fractional settlement and NO complement, zero settlement fee, no synthetic closing fill.
 now=base;const y=setup();await y.lab.scan();const st=y.state(),o=st.orders.find((o:any)=>o.side==='NO');st.orders=[];st.positions=[{...o,strategy:'favorite',entry:.6,fee:.01,opened:base}];st.cash.favorite=999.39;writeFileSync(y.path,JSON.stringify(st));
 y.resolve({...market,resolved:true,resolution:'MKT',resolutionProbability:.25,status:'resolved'});const settled=new PolyPaperLab(y.path,y.venue,()=>now);now=base+2*3600000;await settled.scan();assert.equal(settled.status().positions.length,0);assert.equal(settled.status().trades[0].exit,.75);assert.equal(settled.status().trades[0].exitFee,0);assert(Math.abs(settled.status().strategies.find(s=>s.id==='favorite')!.cash-1000.14)<1e-8)
 // Missing settlement must retain capital, even if stale book prices remain present.
 st.positions[0].strategy='favorite';writeFileSync(y.path,JSON.stringify(st));y.resolve({...market});const pending=new PolyPaperLab(y.path,y.venue,()=>now);await pending.scan();assert.equal(pending.status().positions.length,1);assert.equal(pending.status().trades.length,0)
 // Discovery failure cannot strand already-open inventory.
 now=base;const z=setup();await z.lab.scan();now+=60000;await z.lab.scan();z.lab.setEnabled(false);z.venue.searchMarkets=async()=>{throw Error('offline')};now=base+31*60000;await z.lab.scan();assert(z.lab.status().trades.length>0);assert(z.lab.status().lastError?.includes('Discovery'))
 console.log('Polymarket paper passed: 8 reachable strategies, isolated read-only venue, next-quote fills, passive trade-through, fees/date boundary, persistence, cash reconciliation, pause/exit, fractional settlement, stale-book refusal and discovery recovery')
}
main().catch(e=>{console.error(e);process.exitCode=1})
