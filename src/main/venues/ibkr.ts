import { IBApi, EventName, SecType, type Contract, type ContractDetails, type Order, type OrderState, type Execution, type CommissionReport } from '@stoqey/ib'
import type { IbkrInstrument, IbkrQuote, IbkrSnapshot } from '../../shared/ibkr'
import { detectIbkrGateway } from './ibkrGateway'
import { HttpError } from '../util/http'

export function ibkrInstrument(c: Contract, d?: ContractDetails): IbkrInstrument {
  return { conId: c.conId ?? 0, symbol: c.symbol ?? '', name: d?.longName ?? c.symbol ?? '',
    description: c.localSymbol ?? c.symbol ?? '', exchange: c.exchange ?? '', currency: c.currency ?? '',
    securityType: c.secType ?? '', outcome: c.exchange === 'FORECASTX' ? (c.right === 'C' ? 'YES' : c.right === 'P' ? 'NO' : undefined) : undefined,
    strike: c.strike, expiry: d?.realExpirationDate ?? c.lastTradeDate ?? '', lastTradeTime: c.lastTradeDateOrContractMonth ?? '' }
}

/** Read-only TWS sessions. Sequential requests avoid reusing the client ID while a session closes. */
export class IbkrReader {
  private queue: Promise<unknown> = Promise.resolve()
  private contracts = new Map<number, Contract>()
  constructor(
    private readonly create = (port: number) => new IBApi({ host: '127.0.0.1', port, clientId: 17091 }),
    private readonly detect = detectIbkrGateway,
    private readonly timeoutMs = 25_000
  ) {}

  private run<T>(start: (ib: IBApi, port: number, done: (value: T) => void, nextId: number, fail: (err: Error) => void) => void, handledError?: (message:string,code:number,id:number) => boolean, onTimeout?: () => T | undefined): Promise<T> {
    const job = this.queue.then(async () => {
      const gateway = await this.detect()
      if (!gateway.port) throw new Error(gateway.message)
      const port = gateway.port
      return new Promise<T>((resolve, reject) => {
        const ib = this.create(port)
        let finished = false
        const finish = (err?: Error, value?: T) => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          ib.disconnect()
          if (err) reject(err); else resolve(value as T)
        }
        // A request that has already answered for SOME ids carries partial truth; `onTimeout` returns it instead of
        // throwing the whole batch away. Returning nothing keeps the error, so a wedged or unauthorised Gateway is
        // never reported as an empty answer.
        const timer = setTimeout(() => {
          const partial = onTimeout?.()
          finish(partial === undefined ? new Error('IBKR request timed out before a complete response. Check Gateway login and API permissions.') : undefined, partial)
        }, this.timeoutMs)
        ib.on(EventName.error, (err: Error, code: number, id: number) => {
          if ([202, 2104, 2106, 2107, 2108, 2158].includes(code)) return
          const message = `IBKR ${code ?? ''}: ${err.message}`
          if (handledError?.(message,code,id)) return
          finish([201,321].includes(code) ? new HttpError(422,message) : new Error(message))
        })
        ib.on(EventName.disconnected, () => finish(new Error('Gateway disconnected before the request completed.')))
        ib.once(EventName.nextValidId, (nextId: number) => {
          try { start(ib, port, value => finish(undefined, value), nextId, err => finish(err)) } catch (err) { finish(err instanceof Error ? err : new Error(String(err))) }
        })
        try { ib.connect() } catch (err) { finish(err instanceof Error ? err : new Error(String(err))) }
      })
    })
    this.queue = job.catch(() => undefined)
    return job
  }

  snapshot(): Promise<IbkrSnapshot> {
    return this.run((ib, port, done) => {
      const result: IbkrSnapshot = { at: '', port, mode: port === 4002 ? 'paper' : 'live', accounts: [], positions: [], orders: [] }
      const complete = new Set<string>()
      const end = (name: string) => {
        complete.add(name)
        if (complete.size === 3) { result.at = new Date().toISOString(); done(result) }
      }
      ib.on(EventName.accountSummary, (id, account, tag, value, currency) => {
        if (id === 1) result.accounts.push({ account, tag, value, currency })
      })
      ib.on(EventName.accountSummaryEnd, id => { if (id === 1) { ib.cancelAccountSummary(1); end('accounts') } })
      ib.on(EventName.position, (account, contract, quantity, averageCost) => {
        if (quantity !== 0) result.positions.push({ account, instrument: ibkrInstrument(contract), quantity, averageCost })
      })
      ib.on(EventName.positionEnd, () => { ib.cancelPositions(); end('positions') })
      ib.on(EventName.openOrder, (id, contract, order, state) => {
        result.orders.push({ id, clientId: order.clientId, orderRef: order.orderRef, permId: order.permId, account: order.account ?? '', instrument: ibkrInstrument(contract), action: order.action ?? '',
          quantity: order.totalQuantity ?? 0, limitPrice: Number.isFinite(order.lmtPrice) && (order.lmtPrice ?? 0) < 1e100 ? order.lmtPrice : undefined, status: state.status ?? '' })
      })
      ib.on(EventName.openOrderEnd, () => end('orders'))
      ib.reqAccountSummary(1, 'All', 'NetLiquidation,TotalCashValue,AvailableFunds,BuyingPower')
      ib.reqPositions()
      ib.reqAllOpenOrders()
    })
  }

  markets(symbol: unknown, month: unknown = new Date().toISOString().slice(0, 7)): Promise<IbkrInstrument[]> {
    if (typeof symbol !== 'string' || !/^[A-Z0-9.]{1,16}$/.test(symbol.trim().toUpperCase())) return Promise.reject(new Error('Enter a ForecastEx product symbol, for example FF.'))
    if (typeof month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) return Promise.reject(new Error('Select a valid contract month.'))
    return this.run((ib, _port, done) => {
      const rows = new Map<number, IbkrInstrument>()
      ib.on(EventName.contractDetails, (id, d) => {
        if (id !== 2 || d.contract.exchange !== 'FORECASTX' || d.contract.secType !== SecType.OPT || !d.contract.conId) return
        const row = ibkrInstrument(d.contract, d)
        rows.set(row.conId, row)
        this.contracts.set(row.conId, d.contract)
      })
      ib.on(EventName.contractDetailsEnd, id => {
        if (id === 2) done([...rows.values()].sort((a, b) => a.lastTradeTime.localeCompare(b.lastTradeTime) || (a.strike ?? 0) - (b.strike ?? 0) || a.description.localeCompare(b.description)))
      })
      ib.reqContractDetails(2, { symbol: symbol.trim().toUpperCase(), secType: SecType.OPT, exchange: 'FORECASTX', currency: 'USD', lastTradeDateOrContractMonth: month.replace('-', '') })
    })
  }

  quote(conId: unknown): Promise<IbkrQuote> {
    if (typeof conId !== 'number' || !Number.isSafeInteger(conId) || !this.contracts.has(conId)) return Promise.reject(new Error('Select a contract returned by the ForecastEx search first.'))
    const contract = this.contracts.get(conId)!
    return this.run((ib, _port, done) => {
      const result: IbkrQuote = { conId, at: '', dataType: 'live' }
      ib.on(EventName.marketDataType, (id, type) => { if (id === 3) result.dataType = ({ 1: 'live', 2: 'frozen', 3: 'delayed', 4: 'delayed frozen' } as Record<number, string>)[type] ?? 'unknown' })
      ib.on(EventName.tickPrice, (id, field, price) => {
        if (id !== 3 || !Number.isFinite(price) || price <= 0 || price > 1) return
        if (field === 1 || field === 66) result.bid = price
        if (field === 2 || field === 67) result.ask = price
      })
      ib.on(EventName.tickSnapshotEnd, id => {
        if (id === 3) { result.at = new Date().toISOString(); done(result) }
      })
      ib.reqMktData(3, { conId: contract.conId, exchange: 'FORECASTX' }, '', true, false)
    })
  }

  /** Bounded simultaneous snapshots; one unavailable contract does not hide the others. */
  quotes(conIds: number[]): Promise<IbkrQuote[]> {
    if (!conIds.length || conIds.length>60 || conIds.some(id=>!Number.isSafeInteger(id)||id<=0)) return Promise.reject(new Error('Quote batches require 1–60 valid contract IDs'))
    const rows=new Map<number,IbkrQuote>(), ended=new Set<number>()
    let finish:()=>void=()=>{}
    return this.run((ib,_port,done)=>{
      for(let i=0;i<conIds.length;i++)rows.set(1000+i,{conId:conIds[i],at:'',dataType:'live'})
      finish=()=>{if(ended.size===rows.size)done([...rows.values()])}
      ib.on(EventName.marketDataType,(id,type)=>{const q=rows.get(id);if(q)q.dataType=({1:'live',2:'frozen',3:'delayed',4:'delayed frozen'} as Record<number,string>)[type]??'unknown'})
      ib.on(EventName.tickPrice,(id,field,price)=>{
        const q=rows.get(id);if(!q)return
        const value=Number.isFinite(price)&&price>0&&price<1?price:undefined
        if(field===1||field===66){q.bid=value;q.bidAt=Date.now()}
        if(field===2||field===67){q.ask=value;q.askAt=Date.now()}
      })
      ib.on(EventName.tickSize,(id,field,size)=>{
        const q=rows.get(id);if(!q)return
        const value=typeof size==='number'&&Number.isFinite(size)&&size>=0?Math.floor(size):undefined
        if(field===0||field===69)q.bidSize=value
        if(field===3||field===70)q.askSize=value
      })
      ib.on(EventName.tickSnapshotEnd,id=>{const q=rows.get(id);if(q){q.at=new Date().toISOString();ended.add(id);finish()}})
      for(const [id,q] of rows)ib.reqMktData(id,{conId:q.conId,exchange:'FORECASTX'},'',true,false)
    },(message,_code,id)=>{
      const q=rows.get(id);if(!q)return false
      q.error=message;q.at=new Date().toISOString();ended.add(id);finish();return true
    },()=>{
      // One ForecastEx contract that never sends tickSnapshotEnd used to reject all 60 and abort the lab scan with
      // them - 24 lost scans over 2026-09-20..25 (incident 2026-09-25T23-50). Mark the silent ids, keep the answers.
      if(!ended.size)return undefined
      const at=new Date().toISOString()
      for(const [id,q] of rows)if(!ended.has(id)){q.error='No snapshot within the request timeout';q.at=at}
      return [...rows.values()]
    })
  }

  contract(conId: number): Promise<ContractDetails> {
    if (!Number.isSafeInteger(conId) || conId <= 0) return Promise.reject(new Error('Invalid contract ID'))
    return this.run((ib, _port, done, _id, fail) => {
      const rows: ContractDetails[] = []
      ib.on(EventName.contractDetails, (id, d) => { if (id === 2) rows.push(d) })
      ib.on(EventName.contractDetailsEnd, id => {
        if (id !== 2) return
        const d = rows[0]
        if (rows.length !== 1 || d.contract.exchange !== 'FORECASTX' || d.contract.secType !== SecType.OPT || d.contract.currency !== 'USD' || !['C', 'P'].includes(d.contract.right ?? '')) return fail(new Error('Contract is not a unique USD ForecastEx outcome'))
        this.contracts.set(conId, d.contract); done(d)
      })
      ib.reqContractDetails(2, { conId, exchange: 'FORECASTX' })
    })
  }

  /** whatIf orders request broker validation and never enter the market. */
  submit(conId: number, order: Order, beforeSubmit?: () => void): Promise<{ id: number; state: OrderState }> {
    return this.run((ib, port, done, id, fail) => {
      if (port !== 4001) throw new Error('IBKR live execution requires Gateway port 4001; paper Gateway will not be substituted')
      ib.on(EventName.openOrder, (oid, _contract, returned, state) => {
        if (oid !== id || returned.orderRef !== order.orderRef) return
        if (order.whatIf || ['Submitted', 'PreSubmitted', 'Filled'].includes(state.status)) done({ id, state })
        else if (['Inactive', 'Cancelled', 'ApiCancelled'].includes(state.status)) fail(new Error(`IBKR order ${state.status}: ${state.warningText ?? ''}`))
      })
      ib.on(EventName.orderStatus, (oid, status) => {
        if (oid === id && !order.whatIf && ['Submitted', 'PreSubmitted', 'Filled', 'Cancelled', 'ApiCancelled'].includes(status)) done({ id, state: { status } })
      })
      beforeSubmit?.()
      ib.placeOrder(id, { conId, exchange: 'FORECASTX' }, order)
    })
  }

  cancel(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id < 0) return Promise.reject(new Error('Invalid order ID'))
    return this.run((ib, port, done) => {
      if (port !== 4001) throw new Error('IBKR cancellation requires live Gateway')
      ib.on(EventName.orderStatus, (oid, status) => {
        if (oid === id && ['Cancelled', 'ApiCancelled', 'Filled'].includes(status)) done()
      })
      ib.cancelOrder(id)
    })
  }

  executions(): Promise<{ contract: Contract; execution: Execution; commission: CommissionReport }[]> {
    return this.run((ib, port, done) => {
      if (port !== 4001) throw new Error('Live execution reconciliation requires Gateway port 4001')
      const rows = new Map<string, { contract: Contract; execution: Execution }>()
      const fees = new Map<string, CommissionReport>()
      let ended = false
      const finish = () => {
        if (ended && [...rows.keys()].every(id => fees.has(id))) done([...rows].map(([id, row]) => ({ ...row, commission: fees.get(id)! })))
      }
      ib.on(EventName.execDetails, (id, contract, execution) => {
        if (id === 4 && contract.exchange === 'FORECASTX' && execution.execId) rows.set(execution.execId, { contract, execution })
      })
      ib.on(EventName.commissionReport, report => { if (report.execId) fees.set(report.execId, report); finish() })
      ib.on(EventName.execDetailsEnd, id => { if (id === 4) { ended = true; finish() } })
      ib.reqExecutions(4, { secType: SecType.OPT, exchange: 'FORECASTX' })
    })
  }

  completed(): Promise<{ contract: Contract; order: Order; state: OrderState }[]> {
    return this.run((ib, _port, done) => {
      const rows: { contract: Contract; order: Order; state: OrderState }[] = []
      ib.on(EventName.completedOrder, (contract, order, state) => { if (contract.exchange === 'FORECASTX') rows.push({ contract, order, state }) })
      ib.on(EventName.completedOrdersEnd, () => done(rows))
      ib.reqCompletedOrders(true)
    })
  }
}
