import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AutoSignal, AutoTraderConfig } from '../../shared/ipc'
import type { OrderBook, VenueMarket } from '../../shared/types'
import { buildCandidatePacket } from './candidatePacket'
import { callCritic } from './openRouterClient'
import { REVIEW_GEMINI } from './nightlyReview'
import { geminiKey } from './gemini'
import { adjudicate } from './adjudicator'
import { IntelligenceAuditStore } from './auditStore'
import type { IntelligenceReview } from './types'
import { ExternalEvidenceService } from './externalEvidence'

export interface PaidCriticBudget { date: string; n: number }

/** Paid calls still allowed today given the persisted record. Pure, for tests. */
export function paidBudgetRemaining(rec:PaidCriticBudget|undefined,today:string,cap:number):number{
  const n=rec&&rec.date===today?rec.n:0
  return Math.max(0,cap-n)
}

/** The day's record, or a zeroed one when the file is missing, stale or malformed. */
export function readPaidBudget(path:string,today:string):PaidCriticBudget{
  try{
    if(existsSync(path)){
      const parsed=JSON.parse(readFileSync(path,'utf8')) as Partial<PaidCriticBudget>
      if(parsed.date===today) return {date:today,n:Number(parsed.n)||0}
    }
  }catch{
    // Reset malformed telemetry; this file contains no credentials.
  }
  return {date:today,n:0}
}

export function writePaidBudget(path:string,rec:PaidCriticBudget):void{
  mkdirSync(dirname(path),{recursive:true})
  const tmp=`${path}.tmp`
  writeFileSync(tmp,JSON.stringify(rec),'utf8')
  renameSync(tmp,path)
}

export class OracleIntelligenceEngine {
  private audit: IntelligenceAuditStore
  private external: ExternalEvidenceService
  private defaultReviewCache = new Map<string,{at:number;review:IntelligenceReview}>()
  /**
   * Paid critic calls made today (UTC), so a silent failover to the router cannot run away again.
   * PERSISTED: the app restarts many times a day (267 boots in the 15 days to 2026-09-11), and an
   * in-memory counter made this a cap per PROCESS, not per day — 09-08 spent 307 paid calls.
   * The in-memory copy is only a same-day cache of the file.
   */
  private budgetPath:string
  private paidToday:PaidCriticBudget={date:'',n:0}
  private loadPaid():PaidCriticBudget{
    const today=new Date().toISOString().slice(0,10)
    if(this.paidToday.date!==today)this.paidToday=readPaidBudget(this.budgetPath,today)
    return this.paidToday
  }
  private paidBudgetLeft(cfg:AutoTraderConfig):number{
    const rec=this.loadPaid()
    return paidBudgetRemaining(rec,rec.date,cfg.intelligenceMaxPaidPerDay??60)
  }
  /** Count BEFORE the call, and on disk, so a crash mid-call cannot uncount it. */
  private recordPaidCall():void{
    const rec=this.loadPaid()
    this.paidToday={date:rec.date,n:rec.n+1}
    try{
      writePaidBudget(this.budgetPath,this.paidToday)
    }catch{
      // A telemetry write failure must not block a call already counted in memory.
    }
  }
  constructor(userData:string){
    this.audit=new IntelligenceAuditStore(join(userData,'intelligence','decisions.jsonl'))
    this.external=new ExternalEvidenceService(userData)
    this.budgetPath=join(userData,'intelligence','critic-budget.json')
  }
  async review(cfg:AutoTraderConfig,args:{signal:AutoSignal;market?:VenueMarket;book?:OrderBook;balance?:number;openPositions:number;dailyTradesLeft:number;stake:number;headlines?:string[];venue?:string}):Promise<IntelligenceReview>{
    const packet=buildCandidatePacket(args); const started=Date.now()
    const caller=`intelligence-critic:${args.venue??'kalshi'}:${args.signal.strategy}:${cfg.intelligenceMode??'unknown'}`
    await this.external.enrich(packet)
    const envKey=process.env.OPENROUTER_API_KEY?.trim()??''
    const useRouter=Boolean(envKey)||/openrouter/i.test(cfg.llmBaseUrl)
    const baseUrl=useRouter?'https://openrouter.ai/api/v1':cfg.llmBaseUrl
    const apiKey=envKey||cfg.llmApiKey.trim()
    const models=useRouter?[cfg.intelligencePrimaryModel||'openai/gpt-5.6-sol',cfg.intelligenceSecondaryModel||'deepseek/deepseek-v4-pro',cfg.intelligenceFallbackModel||'z-ai/glm-5.3']:[cfg.llmModel]
    try{
      // Shadow verdicts have shown no skill yet (2026-09-07, 45 settled: vetoed
      // candidates still +2.9c/contract vs +10c for the rest), so the
      // measurement runs on the free local Ollama models first and the paid
      // router is only the fallback. scripts/critic-skill.py re-measures.
      let called
      try{
        const gkey=geminiKey()
        if(!gkey) throw new Error('no GEMINI_API_KEY configured')
        called=await callCritic({baseUrl:REVIEW_GEMINI.base,apiKey:gkey,models:REVIEW_GEMINI.models,timeoutMs:60_000,caller},packet)
      }catch(e){
        if(!apiKey) throw e
        // The free path has NEVER served a review — 0 of 1,025 in the recorded history — because Ollama's
        // cloud-backed models are metered and the account is weekly-limited. Every one fell through to
        // gpt-5.6-sol at ~$0.22 a call: 899 of them, $198 of a $230 grant, for a SHADOW measurement that
        // cannot act and whose verdicts have shown no skill (2026-09-07: vetoed candidates +2.9c/contract
        // against +10c for the rest). So shadow drops the premium model and buys only the cheap ones; veto
        // mode keeps the full chain, because there the verdict actually gates a real order.
        const paid=cfg.intelligenceMode==='veto'?[...new Set(models)]:[...new Set(models.slice(1))]
        if(paid.length===0) throw e
        // A cap, because the failure was never the price of one call — it was that nothing was counting.
        if(this.paidBudgetLeft(cfg)<=0) throw new Error(`paid critic budget spent for today (${cfg.intelligenceMaxPaidPerDay??60}); free path: ${e instanceof Error?e.message:String(e)}`)
        this.recordPaidCall()
        called=await callCritic({baseUrl,apiKey,models:paid,caller},packet)
      }
      const review={packet,verdict:called.verdict,adjudication:adjudicate(packet,called.verdict,cfg.intelligenceMinEdgeCents??2),model:called.model,latencyMs:Date.now()-started}
      this.audit.append(review); return review
    }catch(e){
      const msg=e instanceof Error?e.message:String(e)
      const review:IntelligenceReview={packet,adjudication:{eligible:false,action:'ABSTAIN_INSUFFICIENT_EVIDENCE',conservativeEdgeCents:-Infinity,reason:msg,errors:[msg]},latencyMs:Date.now()-started,apiError:msg}
      this.audit.append(review); return review
    }
  }

  /** Shadow review for independent strategy engines. It uses OpenRouter defaults and never controls execution. */
  async reviewDefault(args:{signal:AutoSignal;market?:VenueMarket;book?:OrderBook;balance?:number;openPositions:number;dailyTradesLeft:number;stake:number;headlines?:string[];venue?:string}):Promise<IntelligenceReview>{
    // Independent maker engines may refresh the same quote repeatedly. One
    // review per venue/market/side/cent every six hours is enough for shadow
    // measurement and prevents duplicate premium-model spend.
    const key = `${args.venue??'unknown'}|${args.signal.marketId}|${args.signal.outcome}|${Math.round(args.signal.price*100)}`
    const cached = this.defaultReviewCache.get(key)
    if(cached && Date.now()-cached.at < 6*3600_000) return cached.review
    const cfg = {
      llmBaseUrl:'https://openrouter.ai/api/v1', llmApiKey:'', llmModel:'openai/gpt-5.6-sol',
      intelligencePrimaryModel:'openai/gpt-5.6-sol',
      intelligenceSecondaryModel:'deepseek/deepseek-v4-pro',
      intelligenceFallbackModel:'z-ai/glm-5.3', intelligenceMinEdgeCents:2
    } as AutoTraderConfig
    const review=await this.review(cfg,args)
    this.defaultReviewCache.set(key,{at:Date.now(),review})
    return review
  }
}
