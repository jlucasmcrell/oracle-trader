import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventName} from '@stoqey/ib'
import {IbkrLab} from '../../src/main/strategies/ibkrLab'
import {IBKR_HOLD_TO_SETTLEMENT,IBKR_STRATEGIES,calibrationSlope,freshAsk,ibkrSignals,cryptoFair,type LabFrame} from '../../src/main/strategies/ibkrSignals'
import {forecastTime,finalSettlements,csvRows} from '../../src/main/venues/forecastexData'
import {IbkrReader} from '../../src/main/venues/ibkr'
import {ibkrWeather} from '../../src/main/strategies/ibkrWeather'
import {IBKR_RULES_SINCE,type IbkrLabMarket} from '../../src/shared/ibkrLab'
const base=Date.parse('2026-09-16T09:00:00Z')
let now=base
const quote=(conId:number,ask:number,size=10,at=now)=>({conId,ask,askSize:size,askAt:at,at:new Date(at).toISOString(),dataType:'live'})
const instrument=(conId:number,outcome:'YES'|'NO')=>({conId,outcome,symbol:'TEST',description:'Test',name:'Test',exchange:'FORECASTX',currency:'USD',securityType:'OPT',expiry:'20260917',lastTradeTime:''})
const market=(id='TEST_091626_100',strike=100):IbkrLabMarket=>({id,product:'TEST',strike,question:'Will test exceed threshold?',category:'Elections',rulesUrl:'https://example.test/rules',closeTime:base+8*3600000,expiresAt:base+9*3600000,direction:'above',yes:instrument(strike*2,'YES'),no:instrument(strike*2+1,'NO')})
const frame=(p=.8):LabFrame=>({market:market(),yes:quote(200,p+.01),no:quote(201,1-p+.01),history:[]})
const root=mkdtempSync(join(tmpdir(),'oracle-ibkr-lab-'))
let sequence=0,writes=0
function setup(){
 const path=join(root,`${++sequence}.json`),m=market()
 const reader={quotes:async(ids:number[])=>ids.map(id=>quote(id,id===m.yes.conId?.8:.22))}
 const engine={getExecutionMode:()=> 'live',placeOrder:async()=>{writes++;throw Error('No broker writes in paper tests')},sellPosition:async()=>{writes++;throw Error('No broker writes in paper tests')},reconcileOrders:async()=>{},orderIntent:()=>undefined}
 const venue={getAccount:async()=>({balance:0}),getFills:async()=>[],getOpenOrders:async()=>[],reader:{completed:async()=>[]}}
 const sources={discover:async()=>[m],settlements:async()=>new Map<string,number>(),spot:async()=>undefined,weather:async()=>undefined}
 const lab=new IbkrLab(path,reader as any,engine as any,venue as any,sources)
 return {lab,path,reader,engine,venue,sources,m,s:(lab as any).state}
}
function order(m:IbkrLabMarket,overrides={}){return {id:'order',strategy:'favorite',marketId:m.id,outcome:'YES',quantity:1,limit:.82,maker:false,createdAt:now-30000,expiresAt:now+60000,reason:'Fixture',...overrides}}
const fill=(x:ReturnType<typeof setup>)=>(x.lab as any).fillOrders(now,new Map([[x.m.id,x.m]]))
function addPosition(x:ReturnType<typeof setup>,overrides={}){const p={id:'position',strategy:'favorite',market:x.m,outcome:'YES',quantity:1,entry:.4,entryFee:.01,openedAt:now-120000,reason:'Fixture',...overrides};x.s.positions.push(p);return p}
async function main(){
 const actualNow=Date.now;Date.now=()=>now
 try{
  assert.equal(forecastTime('2026-09-16T16:00:00'),Date.parse('2026-09-16T21:00:00Z'))
  assert.equal(forecastTime('2026-12-16T16:00:00'),Date.parse('2026-12-16T22:00:00Z'))
  assert.deepEqual(csvRows('a,b\n"x,y","a""b"\n'),[['a','b'],['x,y','a"b']])
  const csv='event_contract,subtype,expiration_date,settlement_price\nA,YES,2026-09-15T16:00:00-05:00,1.00\nA,NO,2026-09-15T16:00:00-05:00,0.00\nB,YES,2026-09-15T16:00:00-05:00,0\nC,YES,2026-09-17T16:00:00-05:00,1\nC,NO,2026-09-17T16:00:00-05:00,0\nD,YES,2026-09-15T16:00:00-05:00,\n'
  assert.deepEqual([...finalSettlements(csv,'2026-09-15',now)],[['A',1]])
  assert.throws(()=>finalSettlements('wrong,columns','2026-09-15',now),/schema/)
  for(const patch of [{askAt:now-31000},{askAt:now+1},{dataType:'delayed'},{dataType:'frozen'},{askSize:0},{askSize:undefined},{ask:undefined},{ask:NaN},{error:'Unavailable'}])assert.equal(freshAsk({...quote(1,.4),...patch},now),false)
  assert.ok(cryptoFair(110,100,.4,1/365)>.99)
  assert.ok(cryptoFair(90,100,.4,1/365)<.01)
  // Every declared arm must be reachable from an explicit, valid input scenario.
  const reached=new Set<string>()
  for(const p of [.04,.08,.15,.2,.3,.4,.5,.6,.7,.8,.85,.9,.96])for(const spread of [-.1,0,.02,.06,.1])for(const direction of [-1,1]){
   const f=frame(p);f.yes=quote(200,p+spread/2,direction>0?2:100);f.no=quote(201,1-p+spread/2,direction>0?100:2)
   f.history=[15,12,10,5,2].map(minutes=>({at:now-minutes*60000,p:Math.max(.01,Math.min(.99,p-.12*direction))}))
   f.forecast={p:direction>0?.95:.05,at:now};f.weather={p:direction>0?.95:.05,at:now,morning:true}
   for(const signal of ibkrSignals([f],now))reached.add(signal.strategy)
   const crypto={...f,market:{...f.market,product:'CFBTC',closeTime:now+4*60000},spot:{price:direction>0?120:80,annualVol:.4,at:now}}
   for(const signal of ibkrSignals([crypto],now))reached.add(signal.strategy)
   crypto.market.closeTime=now+3600000
   for(const signal of ibkrSignals([crypto],now))reached.add(signal.strategy)
  }
  const peers=[90,100,110].map((strike,i)=>({...frame([.4,.1,.7][i]),market:market(`TEST_091626_${strike}`,strike)}))
  for(const signal of ibkrSignals(peers,now))reached.add(signal.strategy)
  assert.deepEqual(IBKR_STRATEGIES.filter(s=>!reached.has(s.id)).map(s=>s.id),[],'Every strategy has an executable signal path')
  assert.equal(ibkrSignals([{...frame(),yes:{...quote(200,.8),dataType:'delayed'}}],now).length,0)
  // Paper runs against a globally live engine without invoking any broker writer.
  const x=setup();await x.lab.scan();assert.equal(x.s.positions.length,0);assert.ok(x.s.orders.length>0)
  now+=30000;await x.lab.scan();assert.ok(x.s.positions.length>0);assert.equal(writes,0)
  const held=x.s.positions.find((p:any)=>p.strategy==='favorite');assert.equal(held.entry,.81);assert.equal(held.entryFee,.01)
  assert.equal(x.s.cash.favorite,999.18)
  const reloaded=new IbkrLab(x.path,x.reader as any,x.engine as any,x.venue as any,x.sources);assert.equal(reloaded.status().positions.length,x.s.positions.length)
  await assert.rejects(x.lab.configure({mode:'live',liveStrategies:['favorite']}),/30 closed/)
  await assert.rejects(x.lab.configure({contracts:1.5}),/risk/)
  // Next-quote rule, displayed size, taker price and delayed-data veto.
  const y=setup();y.s.orders=[order(y.m,{quantity:4})];y.s.quotes['200']=quote(200,.8,2);y.s.quotes['201']=quote(201,.22)
  fill(y);assert.equal(y.s.positions[0].quantity,2);assert.equal(y.s.orders.length,0);assert.equal(y.s.cash.favorite,998.36)
  const z=setup();z.s.orders=[order(z.m,{createdAt:now})];z.s.quotes['200']=quote(200,.8);z.s.quotes['201']=quote(201,.22);fill(z);assert.equal(z.s.positions.length,0)
  z.s.orders[0].createdAt=now-30000;z.s.quotes['200'].dataType='frozen';fill(z);assert.equal(z.s.positions.length,0)
  z.s.quotes['200']=quote(200,.83);fill(z);assert.equal(z.s.positions.length,0)
  z.s.orders[0].maker=true;z.s.orders[0].limit=.79;z.s.quotes['200']=quote(200,.79);fill(z);assert.equal(z.s.positions.length,0,'Touch is not a passive fill')
  z.s.quotes['200']=quote(200,.78);fill(z);assert.equal(z.s.positions[0].entry,.79)
  const wide=setup();wide.s.orders=[order(wide.m,{strategy:'momentum'})];wide.s.quotes['200']=quote(200,.8);wide.s.quotes['201']=quote(201,.28);fill(wide);assert.equal(wide.s.positions.length,0,'No mechanically loss-stopped entry')
  wide.s.orders=[order(wide.m)];fill(wide);assert.equal(wide.s.positions.length,1,'A held arm is not refused for exit costs it never pays')
  // Round 114: held arms reach settlement; timed arms stop on the move since the fill-time mark.
  const hold=setup();addPosition(hold,{strategy:'fade',openedAt:now-2*3600000,market:{...hold.m,closeTime:now+5*60000}});hold.s.quotes['201']=quote(201,.9)
  ;(hold.lab as any).closePositions(now);assert.equal(hold.s.positions.length,1,'Held arm ignores stop, one-hour and pre-close exits')
  const timed=setup();addPosition(timed,{strategy:'momentum',entryMark:-.06});timed.s.quotes['201']=quote(201,.65)
  ;(timed.lab as any).closePositions(now);assert.equal(timed.s.positions.length,1,'Net -8c from a -6c fill mark is a 2c move, not a stop')
  timed.s.quotes['201']=quote(201,.75);(timed.lab as any).closePositions(now);assert.equal(timed.s.positions.length,0,'A 12c move from the fill mark stops')
  assert.equal(ibkrSignals([{...frame(.8),yes:quote(200,.85),no:quote(201,.25)}],now).filter(s=>!s.basket&&!IBKR_HOLD_TO_SETTLEMENT.has(s.strategy)).length,0)
  // Round 114: calibration is reachable on a real 2c book (the old 3c-beyond-ask rule never fired on 29,601 frames).
  assert.ok(ibkrSignals([frame(.8)],now).some(s=>s.strategy==='calibration'&&s.outcome==='YES'),'Calibration fires on a 2c spread')
  assert.ok(ibkrSignals([frame(.8)],now).some(s=>s.strategy==='political-favorite'),'Political recalibration fires on an election contract')
  // Round 121: the general recalibration arm uses the category's own evaluation-half slope. Only politics is
  // compressed; a calibrated category (slope 1.0) yields no entry, so the arm no longer trades an average.
  assert.deepEqual([calibrationSlope('Elections'),calibrationSlope('Financial Markets'),calibrationSlope('Environmental')],[1.15,1,1])
  assert.ok(ibkrSignals([frame(.8)],now).some(s=>s.strategy==='calibration'),'Recalibration fires on an election contract')
  assert.ok(!ibkrSignals([{...frame(.8),market:{...market(),category:'Financial Markets'}}],now).some(s=>s.strategy==='calibration'),'No recalibration entry on a calibrated category')
  assert.ok(!ibkrSignals([{...frame(.8),market:{...market(),expiresAt:now+90*86400000}}],now).some(s=>IBKR_HOLD_TO_SETTLEMENT.has(s.strategy)),'Held arms skip contracts that cannot settle inside the test')
  // Correct opposing ask exit, both fees and no exit on the entry snapshot.
  const e=setup(),p=addPosition(e,{strategy:'momentum',entryMark:-.02});e.s.quotes['201']=quote(201,.5)
  ;(e.lab as any).closePositions(now);assert.equal(e.s.trades[0].exit,.49);assert.equal(e.s.trades[0].net,.07);assert.equal(e.s.positions.length,0)
  addPosition(e,{...p,id:'same-tick',openedAt:now});(e.lab as any).closePositions(now);assert.equal(e.s.positions.length,1)
  const basket=setup();addPosition(basket,{basket:'exhaustive'});addPosition(basket,{id:'other-leg',market:{...basket.m,id:'TEST_091626_110'},basket:'exhaustive'});basket.s.quotes['201']=quote(201,.8);(basket.lab as any).closePositions(now);assert.equal(basket.s.positions.length,2,'A completed exhaustive basket is held together for settlement')
  const settlement=setup();addPosition(settlement,{market:{...settlement.m,expiresAt:now-1},outcome:'NO'})
  ;(settlement.lab as any).settle(new Map([[settlement.m.id,0]]),now);assert.equal(settlement.s.trades[0].net,.59)
  const awaiting:any={id:'awaiting',strategy:'favorite',market:{...settlement.m,expiresAt:now-1},outcome:'YES',quantity:1,status:'open',filled:1,exitFilled:0,entryCost:.4,exitCost:0,fees:.01,ordersComplete:false}
  settlement.s.live=[awaiting];(settlement.lab as any).settle(new Map([[settlement.m.id,1]]),now);assert.equal(awaiting.status,'open','Unreconciled live orders cannot be graded early')
  awaiting.ordersComplete=true;(settlement.lab as any).settle(new Map([[settlement.m.id,1]]),now);assert.equal(awaiting.status,'closed');assert.equal(awaiting.net,.59)
  const forecasts=setup();let forecastsMade=0
  ;(forecasts.lab as any).sources.forecast=async()=>{forecastsMade++;return {p:.6,reason:'Insufficient edge',approved:false}}
  await (forecasts.lab as any).runForecast([frame()],now);await (forecasts.lab as any).runForecast([frame()],now)
  assert.equal(forecastsMade,1,'A veto must not be requested again on every scan');assert.equal(forecasts.s.forecast[market().id].p,.6,'The probability is tested even when the model declines a trade')
  assert.equal(JSON.parse(readFileSync(forecasts.path+'.forecasts.jsonl','utf8').trim()).verdict.approved,false)
  forecasts.s.modelCalls=8;await (forecasts.lab as any).runForecast([{...frame(),market:market('OTHER_091626_100')}],now);assert.equal(forecastsMade,1)
  const pair=setup();addPosition(pair,{entry:.3});addPosition(pair,{id:'opposite',outcome:'NO',entry:.6});fill(pair);assert.equal(pair.s.positions.length,0);assert.equal(pair.s.trades[0].net,.08)
  const corrupt=setup();writeFileSync(corrupt.path,'{truncated');const broken=new IbkrLab(corrupt.path,corrupt.reader as any,corrupt.engine as any,corrupt.venue as any,corrupt.sources)
  await broken.scan();assert.match(broken.status().lastError!,/unreadable/);assert.equal(readFileSync(corrupt.path,'utf8'),'{truncated')
  // Qualification is based on net results across independent events and days, never win rate alone.
  const live=setup();live.s.trades=Array.from({length:30},(_,i)=>({id:String(i),strategy:'favorite',marketId:`EVENT${i}_date_strike`,question:'Fixture',outcome:'YES',quantity:1,entry:.4,exit:.7,fees:.02,net:.28,openedAt:base-i*86400000,closedAt:base-Math.floor(i/10)*86400000,reason:'Fixture'}))
  // Qualification counts only trades opened under the current rules; the same record opened earlier is history.
  let row=live.lab.status().strategies.find(r=>r.id==='favorite')!
  assert.deepEqual([row.liveEligible,row.closed,row.legacyClosed,row.legacyRealized],[false,0,30,8.4],'old-rule trades never qualify a strategy')
  const since=IBKR_RULES_SINCE+3600000;live.s.trades=live.s.trades.map((t:any,i:number)=>({...t,openedAt:since+i,closedAt:since+Math.floor(i/10)*86400000}))
  row=live.lab.status().strategies.find(r=>r.id==='favorite')!
  // Thirty straight wins on a favourite arm is the MODAL record of a zero-edge arm, not evidence: before the first
  // loss the sample is near-deterministic, the clustered SE collapses and the band tightens around a mean that has
  // never seen the payout the arm is exposed to. BACKLOG 141 measured exactly that on the Kalshi arm at 138 trades
  // and set the bar at 250 trades or 15 losses; a hold-to-settlement arm here carries the same one (section 143).
  assert.deepEqual([row.liveEligible,row.closed,row.legacyClosed],[false,30,0],'an unsampled loss branch cannot qualify a settlement arm')
  assert.ok(row.gateBlockers!.some(b=>/losses sampled/.test(b)),'and the row says which leg of the gate is missing')
  await assert.rejects(live.lab.configure({mode:'live',liveStrategies:['favorite']}),/losses sampled/)
  // The same arm with its loss branch sampled: 45 closes over three days, 15 of them real losses at the
  // favourite's own payout, still net positive with a band clear of zero. That is what evidence looks like.
  const shape=[11,10,9].flatMap((wins,d)=>Array.from({length:15},(_,k)=>({d,win:k<wins})))
  live.s.trades=shape.map(({d,win},i)=>({id:'S'+i,strategy:'favorite',marketId:`EV${i}_date_strike`,question:'Fixture',
    outcome:'YES',quantity:1,entry:.4,exit:win?.7:.3,fees:.02,net:win?.3:-.1,openedAt:since+i,closedAt:since+d*86400000,reason:'Fixture'}) as any)
  row=live.lab.status().strategies.find(r=>r.id==='favorite')!
  assert.equal(row.gateBlockers!.some(b=>/losses sampled/.test(b)),false,'the loss branch is sampled')
  assert.deepEqual([row.liveEligible,row.closed,row.losses>=15],[true,45,true],'sampled losses, positive band, three day-clusters')
  // A quote-dynamics arm never needed the loss bar: it is not held to settlement, so its payout is not one-sided.
  const timedArm=setup();timedArm.s.trades=live.s.trades.map((r:any,i:number)=>({...r,strategy:'momentum',id:'M'+i,net:.3}))
  assert.equal(timedArm.lab.status().strategies.find((r:any)=>r.id==='momentum')!.gateBlockers!.some((b:string)=>/losses sampled/.test(b)),false,'the loss bar is for settlement arms only')
  await assert.rejects(live.lab.configure({mode:'live',liveStrategies:['favorite']}),/Fund IBKR/)
  live.venue.getAccount=async()=>({balance:20});await live.lab.configure({mode:'live',liveStrategies:['favorite']})
  assert.equal(live.lab.status().config.mode,'live');await live.lab.configure({mode:'paper',liveStrategies:[]})
  // Empty/partial IOC lifecycle; definitive terminal evidence before retry, durable execution dedupe.
  const l=setup();const record={id:'L',strategy:'favorite',market:l.m,outcome:'YES',quantity:2,createdAt:now-120000,status:'open',orderId:'17091:1',filled:0,exitFilled:0,entryCost:0,exitCost:0,fees:0}
  // A TWS completed-order row carries orderRef and permId but no orderId/clientId (audit 2026-09-19, B-07): the lab
  // must recognise it by the ref it submitted with, or by the permId the open-order snapshot reported.
  ;(record as any).entryRef='ibkr-lab:favorite:L:entry'
  l.s.live=[record];(l.venue.reader as any).completed=async()=>[{order:{orderRef:'ibkr-lab:favorite:L:entry',permId:9001,filledQuantity:0},state:{status:'Cancelled'}}]
  await (l.lab as any).reconcileLive(now);assert.equal(l.s.live[0].status,'closed','decoder-shaped completed row matched by orderRef');assert.equal(l.s.live[0].net,0)
  record.status='open';delete (record as any).entryRef;(l.lab as any).permIds.set('17091:1',9001)
  await (l.lab as any).reconcileLive(now);assert.equal(l.s.live[0].status,'closed','decoder-shaped completed row matched by permId')
  record.status='open';(l.lab as any).permIds.clear()
  await (l.lab as any).reconcileLive(now);assert.equal(l.s.live[0].status,'open','no ref and no permId: not terminal')
  ;(l.venue.reader as any).completed=async()=>[{order:{clientId:17091,orderId:1,filledQuantity:0},state:{status:'Cancelled'}}]
  await (l.lab as any).reconcileLive(now);assert.equal(l.s.live[0].status,'closed');assert.equal(l.s.live[0].net,0)
  record.status='open';(l.venue.getFills as any)=async()=>[{id:'fill1',orderId:'17091:1',shares:1,price:.4,fee:.01}];(l.venue.reader as any).completed=async()=>[{order:{clientId:17091,orderId:1,filledQuantity:1},state:{status:'Cancelled'}}]
  await (l.lab as any).reconcileLive(now);assert.equal(record.filled,1);assert.equal(record.fees,.01)
  ;(l.venue.getFills as any)=async()=>[];await (l.lab as any).reconcileLive(now);assert.equal(record.filled,1);assert.equal(record.entryCost,.4)
  // Recovery consumes a uniquely journaled request; it never re-submits an uncertain entry.
  record.status='uncertain';(record as any).pendingRef='ibkr-lab:favorite:L:entry';(l.engine.orderIntent as any)=()=>({state:'acknowledged',orderId:'17091:1'})
  await (l.lab as any).reconcileLive(now);assert.equal(record.status,'open');assert.equal(writes,0)
  const partial=setup(),rp:any={...record,id:'partial',quantity:2,filled:0,exitFilled:0,entryCost:0,exitCost:0,fees:0,executions:{},exitOrderId:'17091:2',exitOrderIds:['17091:2']}
  partial.s.live=[rp];partial.s.quotes['201']=quote(201,.49)
  ;(partial.venue.getFills as any)=async()=>[{id:'entry',orderId:'17091:1',shares:2,price:.4,fee:.02},{id:'exit1',orderId:'17091:2',shares:1,price:.5,fee:.01}]
  ;(partial.venue.reader as any).completed=async()=>[{order:{clientId:17091,orderId:1,filledQuantity:2},state:{status:'Filled'}},{order:{clientId:17091,orderId:2,filledQuantity:1},state:{status:'Cancelled'}}]
  let exitsSubmitted=0;(partial.engine.sellPosition as any)=async(req:any)=>{exitsSubmitted++;assert.equal(req.shares,1);return{orderId:'17091:3'}}
  await (partial.lab as any).reconcileLive(now);assert.equal(exitsSubmitted,0,'A held live position is not exited before settlement');assert.equal(rp.exitFilled,1)
  // The retry protection is the point here, so the exit is the one-hour time exit (no price move from the mark).
  rp.strategy='momentum';rp.createdAt=now-3700000;await (partial.lab as any).reconcileLive(now);assert.equal(exitsSubmitted,1);assert.equal(rp.exitFilled,1)
  now+=61000;partial.s.quotes['201']=quote(201,.49);await (partial.lab as any).reconcileLive(now);assert.equal(exitsSubmitted,1,'Unknown exit status cannot cause a duplicate retry')
  ;(partial.venue.getFills as any)=async()=>[{id:'exit2',orderId:'17091:3',shares:1,price:.5,fee:.01}]
  await (partial.lab as any).reconcileLive(now);assert.equal(rp.status,'closed');assert.equal(rp.net,.16)
  const netting=setup(),legs=['YES','NO'].map((outcome,i)=>({...record,id:`pair${i}`,orderId:`17091:${i+10}`,outcome,quantity:1,status:'open',filled:0,exitFilled:0,entryCost:0,exitCost:0,fees:0,executions:{}}))
  netting.s.live=legs;(netting.venue.getFills as any)=async()=>legs.map((p,i)=>({id:`paired${i}`,orderId:p.orderId,shares:1,price:i?.6:.3,fee:.01}))
  await (netting.lab as any).reconcileLive(now);assert.ok(legs.every(p=>p.status==='closed'));assert.ok(Math.abs(legs.reduce((a,p)=>a+(p as any).net,0)-.08)<1e-8)
  // Live timed exits move from the fill-time mark, exactly as paper does: -7c at the fill, -9c later stays open; -16c exits.
  const mk=setup(),mrec:any={id:'M',strategy:'momentum',market:mk.m,outcome:'YES',quantity:1,createdAt:now-120000,status:'open',orderId:'17091:20',filled:0,exitFilled:0,entryCost:0,exitCost:0,fees:0,executions:{}}
  mk.s.live=[mrec];mk.s.quotes['201']=quote(201,.44)
  ;(mk.venue.getFills as any)=async()=>[{id:'m1',orderId:'17091:20',shares:1,price:.6,fee:.01}]
  ;(mk.venue.reader as any).completed=async()=>[{order:{clientId:17091,orderId:20,filledQuantity:1},state:{status:'Filled'}}]
  let markExits=0;(mk.engine.sellPosition as any)=async()=>{markExits++;return{orderId:'17091:21'}}
  await (mk.lab as any).reconcileLive(now);assert.ok(Math.abs(mrec.entryMark+.07)<1e-8,'mark fixed at the first fresh quote after the fill')
  mk.s.quotes['201']=quote(201,.46);await (mk.lab as any).reconcileLive(now);assert.equal(markExits,0,'-7c to -9c is a 2c move, not a stop')
  mk.s.quotes['201']=quote(201,.53);await (mk.lab as any).reconcileLive(now);assert.equal(markExits,1,'a 9c adverse move from the mark stops out')
  // GPT's reproduction: the first reconcile after the fill sees a STALE quote. The mark waits for a fresh one instead of
  // becoming permanently absent, and the -7c -> -9c case holds exactly as above.
  const st2=setup(),srec:any={...mrec,id:'S',orderId:'17091:30',status:'open',filled:0,exitFilled:0,entryCost:0,exitCost:0,fees:0,executions:{},entryMark:undefined,entryMarkAt:undefined,exitOrderId:undefined,exitOrderIds:undefined,lastExitAt:undefined,exitAttempt:undefined,market:st2.m}
  st2.s.live=[srec];st2.s.quotes['201']=quote(201,.44,10,now-3600000)
  ;(st2.venue.getFills as any)=async()=>[{id:'s1',orderId:'17091:30',shares:1,price:.6,fee:.01}]
  ;(st2.venue.reader as any).completed=async()=>[{order:{clientId:17091,orderId:30,filledQuantity:1},state:{status:'Filled'}}]
  let staleExits=0;(st2.engine.sellPosition as any)=async()=>{staleExits++;return{orderId:'17091:31'}}
  await (st2.lab as any).reconcileLive(now);assert.equal(srec.entryMark,undefined,'no mark from a stale quote')
  st2.s.quotes['201']=quote(201,.44);await (st2.lab as any).reconcileLive(now);assert.ok(Math.abs(srec.entryMark+.07)<1e-8,'mark taken at the first fresh quote')
  st2.s.quotes['201']=quote(201,.46);await (st2.lab as any).reconcileLive(now);assert.equal(staleExits,0,'-7c to -9c holds after a stale first quote too')
  st2.s.quotes['201']=quote(201,.53);await (st2.lab as any).reconcileLive(now);assert.equal(staleExits,1)
  // Paper: a position filled without a fresh opposing quote is marked on its first fresh one, never judged on absolute net.
  const pm=setup();const pp:any=addPosition(pm,{strategy:'momentum',entry:.6,entryFee:.01});pm.s.quotes['201']=quote(201,.46)
  ;(pm.lab as any).closePositions(now);assert.equal(pm.s.positions.length,1,'an unmarked paper position at -9c is marked, not stopped');assert.ok(Math.abs(pp.entryMark+.09)<1e-8)
  pm.s.quotes['201']=quote(201,.55);(pm.lab as any).closePositions(now);assert.equal(pm.s.positions.length,0,'a 9c adverse move from that mark exits')
  // The weather forecast banks only the matching station's matching calendar day, never yesterday's high.
  const originalFetch=globalThis.fetch
  try{
   let observationReads=0
   globalThis.fetch=(async(url:any)=>({ok:true,json:async()=>String(url).includes('/points/')?{properties:{forecastHourly:'https://example.test/hourly'}}:String(url).includes('/observations?')?(observationReads++,{features:[{properties:{timestamp:new Date(now-60000).toISOString(),temperature:{value:32}}}]}):{properties:{updateTime:new Date(now).toISOString(),periods:Array.from({length:48},(_,i)=>({startTime:new Date(now+i*3600000).toISOString(),temperature:75,temperatureUnit:'F'}))}}})) as any
   const wm={...market('UHLAX_091626_77',77),product:'UHLAX',question:'Will the highest temperature in Los Angeles (KLAX) exceed 77 F on September 16, 2026?',rulesUrl:'https://data.forecastex.com/regulatory/DailyTemperatureTermsandConditions.pdf'}
   const weather=await ibkrWeather(wm,now);assert.ok(weather&&weather.p>.9);assert.equal(observationReads,1)
   const tomorrow=await ibkrWeather({...wm,id:'UHLAX_091726_77'},now);assert.ok(tomorrow&&tomorrow.p<.5);assert.equal(observationReads,1)
   assert.equal(await ibkrWeather({...wm,question:'Different station (KLGA)'},now),undefined)
  }finally{globalThis.fetch=originalFetch}
  // A failed discovery waits instead of repeating on the next 30 s scan; with no universe at all it keeps trying.
  const backoff=setup();let discoveries=0
  ;(backoff.lab as any).sources.discover=async()=>{discoveries++;throw Error('Gateway API not available yet.')}
  backoff.s.markets=[backoff.m];backoff.s.discoveryAt=now-7*3600000
  await backoff.lab.scan();assert.equal(discoveries,1)
  now+=30000;await backoff.lab.scan();assert.equal(discoveries,1,'A failed discovery is not retried on the next scan')
  assert.match(backoff.s.notes._discovery,/Gateway API not available/)
  now+=10*60000;await backoff.lab.scan();assert.equal(discoveries,2,'The retry resumes after the back-off')
  const noUniverse=setup();let attempts=0
  ;(noUniverse.lab as any).sources.discover=async()=>{attempts++;throw Error('No exact ForecastEx/IBKR contract matches')}
  await noUniverse.lab.scan();now+=30000;await noUniverse.lab.scan()
  assert.equal(attempts,2,'With no discovered universe the lab keeps trying every scan')
  // A partial walk keeps the failed product's previous contracts and retries sooner than six hours.
  const partialWalk=setup(),fresh={...market('OTHER_091626_100'),product:'OTHER'};let walks=0
  ;(partialWalk.lab as any).sources.discover=async(_:number,report:(m:string)=>void)=>{walks++;report('TEST 2026-09: Error: IBKR request timed out');return [fresh]}
  partialWalk.s.markets=[partialWalk.m];partialWalk.s.discoveryAt=now-7*3600000
  await partialWalk.lab.scan();assert.deepEqual(partialWalk.s.markets.map((m:IbkrLabMarket)=>m.id).sort(),[fresh.id,partialWalk.m.id].sort(),'Failed product keeps its contracts')
  now+=31*60000;await partialWalk.lab.scan();assert.equal(walks,2,'A partial discovery is retried after 30 minutes')
  assert.match(noUniverse.lab.status().lastError!,/No exact ForecastEx/)
  class Api extends EventEmitter{
   connect(){queueMicrotask(()=>this.emit(EventName.nextValidId,1));return this}disconnect(){this.emit(EventName.disconnected);return this}
   reqMktData(id:number,c:any){if(c.conId===2){this.emit(EventName.error,Error('Unavailable contract'),200,id);return}this.emit(EventName.marketDataType,id,c.conId===3?3:1);this.emit(EventName.tickPrice,id,2,.42);this.emit(EventName.tickSize,id,3,7);this.emit(EventName.tickSnapshotEnd,id)}
  }
  const reader=new IbkrReader(()=>new Api() as any,async()=>({connected:true,port:4001,mode:'live',message:''}),50)
  const batch=await reader.quotes([1,2,3]);assert.equal(batch.length,3);assert.equal(batch[0].askSize,7);assert.match(batch[1].error!,/200/);assert.equal(freshAsk(batch[2],now),false)
  await assert.rejects(reader.quotes(Array(61).fill(1)),/1–60/)
  console.log(`IBKR laboratory passed: ${IBKR_STRATEGIES.length} reachable strategies, quote realism, settlement, fees, persistence, paper/live isolation, qualification, IOC reconciliation and recovery`)
 }finally{Date.now=actualNow}
}
main().catch(e=>{console.error(e);process.exitCode=1})
