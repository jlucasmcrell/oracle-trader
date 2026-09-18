import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeFileAtomic } from '../store/json'
import type { TradingEngine } from '../engine/engine'
import type { IbkrAdapter } from '../venues/ibkrAdapter'
import type { OrderRequest } from '../../shared/types'
import type { IbkrWatch } from '../../shared/ibkr'

/** One-shot entry rules, not an estimated fair-value model. No automatic resubmission. */
export class IbkrWatchTrader {
  private rows: IbkrWatch[] = []
  private running=false
  private failure?:string
  constructor(private engine:TradingEngine,private venue:IbkrAdapter,private path:string) {
    try {
      if(existsSync(path)) {
        const rows=JSON.parse(readFileSync(path,'utf8'))
        if(!Array.isArray(rows)||rows.some(r=>!r.id||r.request?.venue!=='ibkr'||!Number.isFinite(r.expiresAt)||!['watching','submitting','submitted','stopped','expired','uncertain'].includes(r.state)))throw new Error('Invalid IBKR watch ledger')
        this.rows=rows
      }
      for(const row of this.rows)if(row.state==='submitting'){row.state='uncertain';row.message='Restart during submission. Reconcile orders before creating another rule.'}
    }catch(e){this.failure=String(e)}
  }
  list(){ if(this.failure)throw new Error(this.failure); return structuredClone(this.rows) }
  private save(){try{writeFileAtomic(this.path,JSON.stringify(this.rows,null,2))}catch(e){this.failure='IBKR watch ledger could not be saved; automation stopped';throw e}}
  async add(request:OrderRequest,expiresAt:number){
    if(this.failure)throw new Error(this.failure)
    if(!Number.isFinite(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+24*3600_000)throw new Error('Watch expiration must be within 24 hours')
    if(request.venue!=='ibkr'||request.closeFrom)throw new Error('Watch rules support new IBKR entries only')
    if(this.rows.some(r=>['watching','submitting','uncertain'].includes(r.state)&&r.request.marketId===request.marketId))throw new Error('A rule or unresolved submission already exists for this contract')
    if(this.rows.filter(r=>r.state==='watching').length>=4)throw new Error('Maximum four active IBKR watch rules')
    await this.venue.preview(request)
    // Preview yields to other IPC requests; recheck before reserving a rule.
    if(this.rows.some(r=>['watching','submitting','uncertain'].includes(r.state)&&r.request.marketId===request.marketId))throw new Error('A rule or unresolved submission already exists for this contract')
    if(this.rows.filter(r=>r.state==='watching').length>=4)throw new Error('Maximum four active IBKR watch rules')
    const clean:OrderRequest={venue:'ibkr',marketId:request.marketId,outcome:request.outcome,amount:request.amount,contracts:request.contracts,limitPrice:request.limitPrice,timeInForce:'immediate_or_cancel',ref:'ibkr-limit-watch'}
    this.rows.push({id:randomUUID(),request:clean,expiresAt,state:'watching',message:'Waiting for a live ask at or below the limit.'});this.save();return this.list()
  }
  stop(id:string){
    if(this.failure)throw new Error(this.failure)
    const row=this.rows.find(r=>r.id===id)
    if(row?.state==='watching'){row.state='stopped';row.message='Stopped before submission.';this.save()}
    return this.list()
  }
  async tick(){
    if(this.running||this.failure)return
    this.running=true
    try {
      for(const row of this.rows.filter(r=>r.state==='watching')){
        if(Date.now()>=row.expiresAt){row.state='expired';row.message='Expired without submission.';this.save();continue}
        if(this.engine.getExecutionMode()!=='live'){row.message='Waiting for Oracle Live mode.';continue}
        try {
          const quote=await this.venue.getPrice(row.request.marketId,row.request.outcome)
          if(row.state!=='watching')continue
          if(Date.now()>=row.expiresAt){row.state='expired';this.save();continue}
          if(quote.price>row.request.limitPrice! || Date.now()-quote.timestamp>30_000)continue
          if((await this.venue.getAccount()).balance<row.request.amount){row.message='Waiting for sufficient available cash.';this.save();continue}
          if(row.state!=='watching')continue
          if(Date.now()>=row.expiresAt){row.state='expired';this.save();continue}
          row.state='submitting';row.message='Submitting once through Oracle risk checks.';this.save()
          try {
            const result=await this.engine.routedAdapter('ibkr','ibkr-limit-watch').placeOrder(row.request)
            row.state='submitted';row.orderId=result.orderId;row.message=`Broker status: ${result.venueStatus??result.status}. No automatic retry.`
          }catch(e){row.state='uncertain';row.message=`${String(e)}. Rule will not retry; check orders and the journal.`}
          this.save()
        }catch(e){row.message=String(e);this.save()}
      }
    }finally{this.running=false}
  }
}
