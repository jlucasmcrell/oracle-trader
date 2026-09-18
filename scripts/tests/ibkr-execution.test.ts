import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventName } from '@stoqey/ib'
import { IbkrReader } from '../../src/main/venues/ibkr'
import { IbkrAdapter, ibkrExecutionTime } from '../../src/main/venues/ibkrAdapter'
import { TradingEngine } from '../../src/main/engine/engine'
import { HistoryStore } from '../../src/main/store/history'
import { FillReconciler } from '../../src/main/store/fillReconciler'
import { IbkrWatchTrader } from '../../src/main/strategies/ibkrWatch'
import type { OrderRequest } from '../../src/shared/types'

const yes = {conId:7,symbol:'FF',secType:'OPT',exchange:'FORECASTX',currency:'USD',right:'C',strike:4.125,lastTradeDateOrContractMonth:'20260916 13:00:00 US/Central'}
const no = {...yes,conId:8,right:'P'}
class Api extends EventEmitter {
  closed=false
  submitted:any[]=[]
  cash=10
  port=4001
  nextId=100
  loseAck=false
  rejectOrder=false
  feeMissing=false
  invalidContract=false
  lateCommission=false
  fills=false
  open:any[]=[]
  complete:any[]=[]
  cancelled:number[]=[]
  connect(){queueMicrotask(()=>this.emit(EventName.nextValidId,this.nextId++));return this}
  disconnect(){this.closed=true;this.emit(EventName.disconnected);return this}
  reqContractDetails(id:number,c:any){this.emit(EventName.contractDetails,id,{contract:this.invalidContract?{...yes,exchange:'SMART'}:c.conId===8?no:yes});if(!c.conId)this.emit(EventName.contractDetails,id,{contract:no});this.emit(EventName.contractDetailsEnd,id)}
  reqAccountSummary(id:number){for(const tag of ['AvailableFunds','TotalCashValue'])this.emit(EventName.accountSummary,id,'TEST',tag,String(this.cash),'USD');this.emit(EventName.accountSummaryEnd,id)}
  cancelAccountSummary(){}
  reqPositions(){this.emit(EventName.position,'TEST',yes,2,.4);this.emit(EventName.positionEnd)}
  cancelPositions(){}
  reqAllOpenOrders(){for(const o of this.open)this.emit(EventName.openOrder,o.id,no,o.order,{status:'Submitted'});this.emit(EventName.openOrderEnd)}
  placeOrder(id:number,contract:any,order:any){
    this.submitted.push({id,contract,order})
    if(this.rejectOrder&&!order.whatIf){this.emit(EventName.error,new Error('Order rejected'),201,id);return}
    if(this.loseAck&&!order.whatIf)return
    this.emit(EventName.openOrder,id,contract,order,{status:order.whatIf?'PreSubmitted':'Submitted',commission:this.feeMissing?undefined:.01,maxCommission:this.feeMissing?undefined:.01,commissionCurrency:'USD'})
  }
  cancelOrder(id:number){this.cancelled.push(id);this.emit(EventName.error,new Error('Order canceled'),202,id);this.emit(EventName.orderStatus,id,'Cancelled',0,0,0)}
  reqExecutions(id:number){
    if(this.fills)this.emit(EventName.execDetails,id,yes,{execId:'abc.01',orderId:101,clientId:17091,acctNumber:'TEST',orderRef:'ref',side:'BOT',shares:2,price:.4,time:'20260916-08:00:00'})
    if(this.lateCommission)this.emit(EventName.execDetailsEnd,id)
    if(this.fills)this.emit(EventName.commissionReport,{execId:'abc.01',commission:.02,currency:'USD'})
    if(!this.lateCommission)this.emit(EventName.execDetailsEnd,id)
  }
  reqCompletedOrders(){for(const o of this.complete)this.emit(EventName.completedOrder,yes,o,{status:'Filled'});this.emit(EventName.completedOrdersEnd)}
}
function setup(){
  const api = new Api()
  // One emitter here models the same broker across new connections; remove old listeners on each session.
  const reader = new IbkrReader(()=>{api.removeAllListeners();return api as any},async()=>({connected:true,port:api.port as 4001,mode:'live',message:''}),25)
  return {api,reader,adapter:new IbkrAdapter(reader)}
}
const request:OrderRequest={venue:'ibkr',marketId:'7',outcome:'YES',contracts:2,limitPrice:.4,amount:.82}
async function main(){
  const {api,reader,adapter}=setup()
  const p=await adapter.preview(request)
  assert.equal(p.maxCost,.82)
  assert.equal(api.submitted[0].order.whatIf,true)
  assert.equal(api.submitted[0].order.action,'BUY')
  assert.deepEqual(api.submitted[0].contract,{conId:7,exchange:'FORECASTX'})
  let hook=0
  const result=await adapter.placeOrder({...request,onSubmit:()=>hook++})
  assert.equal(hook,1);assert.equal(result.shares,0);assert.equal(result.status,'open')
  assert.equal(api.submitted.at(-1).order.whatIf,false)
  for(const patch of [{contracts:1.5},{limitPrice:.401},{limitPrice:NaN},{amount:.1},{postOnly:true},{timeInForce:'fill_or_kill'},{outcome:'BAD'}])await assert.rejects(adapter.placeOrder({...request,...patch} as OrderRequest))
  api.cash=0
  const liveCount=()=>api.submitted.filter(x=>!x.order.whatIf).length
  const before=liveCount()
  await assert.rejects(adapter.placeOrder(request),/Insufficient/);assert.equal(liveCount(),before)
  api.cash=10;api.feeMissing=true
  assert.equal((await adapter.preview(request)).feeSource,'published schedule')
  api.feeMissing=false;api.invalidContract=true
  await assert.rejects(adapter.placeOrder(request),/ForecastEx/)
  api.invalidContract=false;api.port=4002
  await assert.rejects(reader.submit(7,{}),/port 4001/)
  api.port=4001
  api.open=[{id:10,order:{clientId:5,orderRef:'external',account:'TEST',totalQuantity:1,lmtPrice:.4}}]
  await assert.rejects(adapter.cancelOrder('5:10'),/owned/)
  api.open[0].order.clientId=17091
  await adapter.cancelOrder('17091:10');assert.deepEqual(api.cancelled,[10])
  api.open=[];api.fills=true;api.lateCommission=true
  const fills=await adapter.getFills()
  assert.equal(fills[0].fee,.02);assert.equal(fills[0].shares,2);assert.equal(fills[0].orderId,'17091:101')
  assert.equal(fills[0].timestamp,Date.parse('2026-09-16T08:00:00Z'))
  assert.equal(ibkrExecutionTime('20260916 04:00:00 America/New_York'),Date.parse('2026-09-16T08:00:00Z'))
  assert.throws(()=>ibkrExecutionTime('20260916 04:00:00'),/timezone/)
  api.complete=[{orderRef:'recover-me',clientId:17091,orderId:90}]
  assert.deepEqual(await adapter.findOrderByClientId('recover-me'),{orderId:'17091:90'})
  const close = await adapter.closeAsBuy({venue:'ibkr',marketId:'7',outcome:'YES',shares:2,limitPrice:.6})
  assert.equal(close.marketId,'8');assert.equal(close.outcome,'NO');assert.equal(close.limitPrice,.4);assert.equal(close.closeFrom,'7')
  await adapter.placeOrder(close)
  assert.equal(api.submitted.at(-1).contract.conId,8)
  assert.equal(api.submitted.at(-1).order.action,'BUY')
  await assert.rejects(adapter.closeAsBuy({venue:'ibkr',marketId:'7',outcome:'YES',shares:3,limitPrice:.6}),/exceeds/)
  api.open=[{id:12,order:{clientId:17091,totalQuantity:1,lmtPrice:.4}}]
  await assert.rejects(adapter.placeOrder(close),/duplicate close/)
  api.open=[]

  const dir=mkdtempSync(join(tmpdir(),'oracle-ibkr-'))
  const registry={get:()=>adapter,list:()=>[adapter]}
  const history=new HistoryStore(join(dir,'history.json'))
  const engine=new TradingEngine(registry as any,history,{paperStateDir:dir})
  await engine.init();engine.setExecutionMode('live');engine.setRiskLimits({maxStakePerBet:1,maxOpenPositions:5})
  await assert.rejects(engine.routedAdapter('ibkr','test-strategy').placeOrder({...request,amount:2}),/max stake/)
  const r=await engine.routedAdapter('ibkr','test-strategy').placeOrder(request)
  assert.equal(engine.orderStrategy('ibkr',r.orderId),'test-strategy')
  assert.equal(api.submitted.at(-1).order.orderRef,engine.orderAttribution('ibkr',r.orderId)!.clientOrderId)
  api.rejectOrder=true
  await assert.rejects(engine.placeOrder(request),/Order rejected/)
  api.rejectOrder=false
  await engine.placeOrder(request) // A definitive broker rejection releases the journal reservation.
  const reconciler=new FillReconciler(engine,history,join(dir,'fills.json'),'ibkr',()=>{})
  await reconciler.run();await reconciler.run()
  assert.equal(reconciler.status().ingested,1)
  const restored=new FillReconciler(engine,history,join(dir,'fills.json'),'ibkr',()=>{})
  await restored.run();assert.equal(restored.status().ingested,1)
  assert.equal(readFileSync(join(dir,'fills.json.fills.jsonl'),'utf8').trim().split('\n').length,1)

  api.loseAck=true
  await assert.rejects(engine.placeOrder(request),/timed out/)
  const transmitted=liveCount()
  const restarted=new TradingEngine(registry as any,history,{paperStateDir:dir})
  restarted.setExecutionMode('live')
  await assert.rejects(restarted.placeOrder(request),/Unresolved submission/)
  assert.equal(liveCount(),transmitted)
  let quotePrice=.5, watchSubmits=0, watchFail=false
  const watchEngine={getExecutionMode:()=> 'live',routedAdapter:()=>({placeOrder:async()=>{watchSubmits++;if(watchFail)throw new Error('Lost acknowledgement');return {orderId:'17091:999',status:'open'}}})}
  let watchCash=10
  const watchVenue={preview:async()=>p,getPrice:async()=>({price:quotePrice,timestamp:Date.now()}),getAccount:async()=>({balance:watchCash})}
  const watchPath=join(dir,'watches.json')
  const watches=new IbkrWatchTrader(watchEngine as any,watchVenue as any,watchPath)
  await watches.add(request,Date.now()+60000)
  await watches.tick();assert.equal(watchSubmits,0)
  quotePrice=.39
  watchCash=0;await watches.tick();assert.equal(watchSubmits,0)
  watchCash=10
  await watches.tick();await watches.tick();assert.equal(watchSubmits,1)
  const watchRestart=new IbkrWatchTrader(watchEngine as any,watchVenue as any,watchPath)
  await watchRestart.tick();assert.equal(watchSubmits,1)
  watchFail=true
  await watchRestart.add({...request,marketId:'8',outcome:'NO'},Date.now()+60000)
  await watchRestart.tick();await watchRestart.tick();assert.equal(watchSubmits,2)
  assert.equal(watchRestart.list()[1].state,'uncertain')
  await assert.rejects(watchRestart.add({...request,marketId:'8',outcome:'NO'},Date.now()+60000),/unresolved/)
  const stopRow=await watchRestart.add({...request,marketId:'9'},Date.now()+60000)
  watchRestart.stop(stopRow[2].id);await watchRestart.tick();assert.equal(watchSubmits,2)
  await assert.rejects(watchRestart.add(request,Date.now()-1),/expiration/)
  const persisted=JSON.parse(readFileSync(watchPath,'utf8'))
  persisted[0].state='submitting';writeFileSync(watchPath,JSON.stringify(persisted))
  const interrupted=new IbkrWatchTrader(watchEngine as any,watchVenue as any,watchPath)
  assert.equal(interrupted.list()[0].state,'uncertain');await interrupted.tick();assert.equal(watchSubmits,2)
  writeFileSync(watchPath,'broken json')
  const corrupt=new IbkrWatchTrader(watchEngine as any,watchVenue as any,watchPath)
  await corrupt.tick();assert.equal(watchSubmits,2);assert.throws(()=>corrupt.list())
  console.log('IBKR execution: preview, validation, funds, identity, cancellation ownership, delayed commission, reconciliation dedupe/restart, routed risk limits and ambiguous-submission restart protection passed')
  console.log('IBKR automation: threshold, one-shot submission, stop, expiry, restart and uncertain-order no-retry checks passed')
}
main().catch(e=>{console.error(e);process.exitCode=1})
