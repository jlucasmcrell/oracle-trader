import { OrderAction, OrderType, TimeInForce, type Order } from '@stoqey/ib'
import { randomUUID } from 'node:crypto'
import type { VenueAdapter } from '../../shared/venue'
import type { AccountInfo, MarketSearchQuery, OrderRequest, OrderResult, Position, SellRequest, VenueFill, VenueMarket } from '../../shared/types'
import type { IbkrPreview } from '../../shared/ibkr'
import { IbkrReader, ibkrInstrument } from './ibkr'

/** IB returns execution times in the timezone selected at Gateway login. Never guess a missing zone. */
export function ibkrExecutionTime(value: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})[ -]+(\d{2}):(\d{2}):(\d{2})(?:\s+(.+))?$/.exec(value)
  if (!m) throw new Error(`Unrecognized IBKR execution time: ${value}`)
  const zone = m[7] || (value[8] === '-' ? 'UTC' : '')
  if (!zone) throw new Error('IBKR execution timezone missing; configure Gateway API timestamps to UTC before reconciliation')
  const target = Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6])
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' })
  let result = target
  for (let i=0; i<3; i++) {
    const p = Object.fromEntries(fmt.formatToParts(result).map(p => [p.type,p.value]))
    result += target - Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)
  }
  return result
}

export class IbkrAdapter implements VenueAdapter {
  readonly id = 'ibkr' as const
  readonly name = 'Interactive Brokers'
  readonly currency = 'USD'
  readonly capabilities = { liveTrading: true, realMoney: true, socialExposure: false }
  private writes: Promise<unknown> = Promise.resolve()
  constructor(readonly reader = new IbkrReader()) {}
  async init() {} // Gateway authentication belongs to the already-running desktop session.

  async searchMarkets(query: MarketSearchQuery): Promise<VenueMarket[]> {
    const rows = await this.reader.markets(query.term?.trim() || 'FF')
    return rows.filter(r => r.outcome === 'YES').slice(0, query.limit ?? 100).map(r => ({ venue:this.id, id:String(r.conId), question:r.description, description:r.name, status:'open', outcomeType:'BINARY', tickSize:.01, minTradeQty:1 }))
  }
  async getMarket(id: string): Promise<VenueMarket> {
    const d = await this.reader.contract(Number(id)), r = ibkrInstrument(d.contract,d)
    return { venue:this.id, id, question:r.description, description:r.name, status:'open', outcomeType:'BINARY', tickSize:.01, minTradeQty:1 }
  }
  private async resolve(marketId: string, outcome: string) {
    if (!['YES','NO'].includes(outcome)) throw new Error('Choose YES or NO')
    const d = await this.reader.contract(Number(marketId))
    const row = ibkrInstrument(d.contract,d)
    if (row.outcome === outcome) return row
    const month = /^\d{6}/.exec(d.contract.lastTradeDateOrContractMonth ?? '')?.[0]
    if (!month) throw new Error('IBKR contract expiry unavailable')
    const rows = await this.reader.markets(row.symbol, `${month.slice(0,4)}-${month.slice(4)}`)
    const matches = rows.filter(r => r.outcome === outcome && r.strike === row.strike && r.lastTradeTime === row.lastTradeTime)
    if (matches.length !== 1) throw new Error('Cannot uniquely identify opposing ForecastEx contract')
    return matches[0]
  }
  async getPrice(marketId: string, outcome = 'YES') {
    const c = await this.resolve(marketId,outcome), q = await this.reader.quote(c.conId)
    if (q.dataType !== 'live' || q.ask === undefined) throw new Error('No live executable IBKR ask')
    return { venue:this.id, marketId, outcome, price:q.ask, probability: outcome === 'YES' ? q.ask : 1-q.ask, timestamp:Date.parse(q.at) }
  }
  async getAccount(): Promise<AccountInfo> {
    const s = await this.reader.snapshot()
    if (s.mode !== 'live') throw new Error('Oracle IBKR live venue requires live Gateway port 4001')
    const accounts = [...new Set(s.accounts.map(r => r.account))]
    if (accounts.length !== 1) throw new Error('IBKR execution requires exactly one account')
    const value = (tag:string) => Number(s.accounts.find(r => r.tag === tag && r.currency === 'USD')?.value)
    const balance = Math.min(value('AvailableFunds'),value('TotalCashValue'))
    if (!Number.isFinite(balance)) throw new Error('IBKR USD cash or available funds missing')
    return {venue:this.id,userId:accounts[0],balance,currency:'USD',realMoney:true}
  }
  async getPositions(): Promise<Position[]> {
    const s = await this.reader.snapshot()
    if (s.mode !== 'live') throw new Error('Live Gateway required')
    return s.positions.filter(p=>p.instrument.exchange === 'FORECASTX').map(p=>({venue:this.id,marketId:String(p.instrument.conId),marketQuestion:p.instrument.description,outcome:p.instrument.outcome ?? '',shares:p.quantity,avgPrice:p.averageCost ?? 0}))
  }
  async getOpenOrders() {
    const s = await this.reader.snapshot()
    if (s.mode !== 'live') throw new Error('Live Gateway required')
    return s.orders.filter(o=>o.instrument.exchange==='FORECASTX').map(o=>({orderId:`${o.clientId}:${o.id}`,clientOrderId:o.orderRef,permId:o.permId,marketId:String(o.instrument.conId),outcome:o.instrument.outcome!,yesPrice:o.instrument.outcome==='YES' ? o.limitPrice! : 1-o.limitPrice!,initialCount:o.quantity,fillCount:0,remainingCount:o.quantity,status:'resting' as const}))
  }
  private async prepare(req: OrderRequest): Promise<{preview:IbkrPreview; order:Order}> {
    if (req.venue !== this.id || req.postOnly || req.expirationTs || req.answerId || req.timeInForce === 'fill_or_kill') throw new Error('Unsupported IBKR order options')
    const price = req.limitPrice, quantity = req.contracts
    if (!Number.isFinite(price) || price! < .01 || price! > .99 || Math.abs(price!*100-Math.round(price!*100)) > 1e-8) throw new Error('IBKR limit must be 1–99 cents in whole cents')
    if (!Number.isSafeInteger(quantity) || quantity! < 1 || quantity! > 10000) throw new Error('IBKR requires 1–10000 whole contracts')
    if (!Number.isFinite(req.amount) || req.amount < quantity!*price!) throw new Error('Contract cost exceeds the order budget')
    const c = await this.resolve(req.marketId,req.outcome)
    if (req.closeFrom) {
      const held = (await this.getPositions()).find(p=>p.marketId===req.closeFrom)
      const opposite = held && await this.resolve(req.closeFrom,held.outcome==='YES'?'NO':'YES')
      if (!held || held.shares < quantity! || opposite?.conId !== c.conId) throw new Error('Closing position changed; refresh before submitting')
      if ((await this.getOpenOrders()).some(o=>o.marketId===String(c.conId))) throw new Error('Opposing order already pending; duplicate close blocked')
    }
    const account = await this.getAccount()
    const order:Order = {action:OrderAction.BUY,orderType:OrderType.LMT,totalQuantity:quantity,lmtPrice:price,tif:req.timeInForce==='immediate_or_cancel'?TimeInForce.IOC:TimeInForce.GTC,account:account.userId,orderRef:req.clientOrderId ?? randomUUID(),transmit:true,whatIf:true}
    const {state} = await this.reader.submit(c.conId,order)
    const commission = state.commissionCurrency === 'USD' ? [state.maxCommission,state.commission].find(f=>Number.isFinite(f) && f! >= 0 && f! < 1e6) : undefined
    // ForecastEx public schedule: $0 broker commission + $0.01 exchange fee per contract.
    // Gateway can omit commission entirely; expose that estimate and also honor its larger margin reserve.
    const feeReserve = Math.max(commission ?? 0,quantity!*.01)
    const reserve = [state.initMarginChange,state.maintMarginChange].filter((v):v is number=>Number.isFinite(v) && v!>=0 && v!<1e6)
    return { preview:{account:account.userId,conId:c.conId,quantity:quantity!,limitPrice:price!,maxCost:Math.ceil(Math.max(quantity!*price!+feeReserve,...reserve)*100-1e-8)/100,commission,feeReserve,feeSource:commission===undefined?'published schedule':'broker',warning:state.warningText},order }
  }
  async preview(req:OrderRequest):Promise<IbkrPreview> { return (await this.prepare(req)).preview }
  placeOrder(req:OrderRequest):Promise<OrderResult> {
    const job = this.writes.then(async()=>{
      const {preview:p,order} = await this.prepare(req)
      if (p.maxCost > req.amount + 1e-8) throw new Error('Including commission, order exceeds its budget')
      const account = await this.getAccount()
      if (account.userId !== p.account || p.maxCost > account.balance) throw new Error('Insufficient available IBKR cash for cost and commission')
      const {id,state} = await this.reader.submit(p.conId,{...order,whatIf:false},req.onSubmit)
      // Execution callbacks are reconciled separately: acknowledgement is not a fill.
      return {venue:this.id,orderId:`17091:${id}`,marketId:String(p.conId),outcome:req.outcome,amount:0,shares:0,avgPrice:0,status:'open' as const,venueStatus:state.status,timestamp:Date.now()}
    })
    this.writes = job.catch(()=>undefined)
    return job
  }
  async closeAsBuy(req:SellRequest):Promise<OrderRequest> {
    const held = (await this.getPositions()).find(p=>p.marketId===req.marketId && p.outcome===req.outcome)
    const quantity = req.shares ?? held?.shares
    if (!held || !Number.isSafeInteger(quantity) || quantity! <= 0 || quantity! > held.shares) throw new Error('Close quantity exceeds the held position')
    const opposite = req.outcome==='YES'?'NO':'YES'
    const c = await this.resolve(req.marketId,opposite)
    if ((await this.getOpenOrders()).some(o=>o.marketId===String(c.conId))) throw new Error('An opposing order already exists; reconcile it before closing again')
    const limit = req.limitPrice === undefined ? undefined : req.outcome==='YES' ? 1-req.limitPrice : req.limitPrice
    if (limit === undefined) throw new Error('Closing an IBKR position requires a limit price')
    const request:OrderRequest = {venue:this.id,marketId:String(c.conId),outcome:opposite,contracts:quantity,limitPrice:Math.round(limit*100)/100,amount:quantity!*limit+quantity!*.02,timeInForce:req.timeInForce,ref:req.ref ?? 'ibkr-close',closeFrom:req.marketId}
    return request
  }
  async sellPosition(_req:SellRequest):Promise<OrderResult> { throw new Error('ForecastEx closes must route through the engine as opposing buys') }
  async cancelOrder(orderId:string) {
    const match = /^17091:(\d+)$/.exec(orderId)
    if (!match) throw new Error('Only orders owned by Oracle IBKR client 17091 can be canceled here')
    const s = await this.reader.snapshot()
    if (!s.orders.some(o=>o.clientId===17091 && o.id===+match[1] && o.instrument.exchange==='FORECASTX')) throw new Error('Oracle ForecastEx order is no longer open')
    await this.reader.cancel(+match[1])
  }
  async findOrderByClientId(ref:string) {
    const s = await this.reader.snapshot()
    if (s.mode !== 'live') throw new Error('Order recovery requires live Gateway port 4001')
    const open = s.orders.find(o=>o.orderRef===ref && o.clientId===17091)
    if (open) return {orderId:`17091:${open.id}`}
    const complete = (await this.reader.completed()).find(o=>o.order.orderRef===ref && o.order.clientId===17091)
    if (complete?.order.orderId !== undefined) return {orderId:`17091:${complete.order.orderId}`}
    const fill = (await this.reader.executions()).find(r=>r.execution.orderRef===ref && r.execution.clientId===17091)
    return fill ? {orderId:`17091:${fill.execution.orderId}`} : undefined
  }
  async getFills():Promise<VenueFill[]> {
    const rows = await this.reader.executions()
    return rows.map(({contract:c,execution:e,commission:fee})=>{
      if (!e.execId || !c.conId || !['C','P'].includes(c.right??'') || e.side!=='BOT' || !Number.isFinite(e.shares) || !Number.isFinite(e.price) || fee.currency!=='USD' || !Number.isFinite(fee.commission) || fee.commission! < 0 || fee.commission! > 1e6) throw new Error('Incomplete IBKR execution or commission; reconciliation held')
      if (/\.0[2-9]$/.test(e.execId)) throw new Error('IBKR execution correction requires ledger review before ingestion')
      return {id:e.execId,marketId:String(c.conId),outcome:c.right==='C'?'YES':'NO',side:'buy',shares:e.shares!,price:e.price!,fee:fee.commission!,isTaker:false,orderId:`${e.clientId}:${e.orderId}`,timestamp:ibkrExecutionTime(e.time??'')}
    })
  }
  async getTopHolders(){return []}
  async getLeaderboard(){return []}
  async getUserBets(){return []}
  async getUserHoldings(){return []}
  async getUserPortfolio():Promise<never>{throw new Error('IBKR does not expose social portfolios')}
}
