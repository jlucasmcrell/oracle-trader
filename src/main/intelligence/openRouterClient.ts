import type { IntelligenceVerdict } from './types'
import { parseStrictVerdict } from './adjudicator'
import { trackedModelFetch } from './modelUsage'

const VERDICT_SCHEMA={name:'oracle_intelligence_verdict',strict:true,schema:{type:'object',additionalProperties:false,required:['action','pYesLow','pYesMid','pYesHigh','confidence','evidenceSufficient','ruleRisk','dataRisks','failureMode','citedEvidenceIds','reason'],properties:{action:{type:'string',enum:['ALLOW_UNCHANGED','VETO','ABSTAIN_INSUFFICIENT_EVIDENCE']},pYesLow:{type:'number',minimum:0,maximum:1},pYesMid:{type:'number',minimum:0,maximum:1},pYesHigh:{type:'number',minimum:0,maximum:1},confidence:{type:'number',minimum:0,maximum:1},evidenceSufficient:{type:'boolean'},ruleRisk:{type:'string',enum:['low','medium','high','unknown']},dataRisks:{type:'array',items:{type:'string'}},failureMode:{type:'string'},citedEvidenceIds:{type:'array',items:{type:'string'}},reason:{type:'string'}}}}
const SYSTEM=`You are an adversarial prediction-market risk critic. You may veto or abstain, never change direction or size. Use only supplied timestamped evidence. Give a conservative P(YES) interval. Missing quantitative anchors means insufficient evidence. Treat settlement ambiguity, stale data, contradictory facts, and unpriced tail events as vetoes. ALLOW_UNCHANGED only when the supplied evidence supports the proposed direction and a conservative fee-clearing edge. Output only the required JSON object.`
export interface ModelCallConfig { baseUrl:string; apiKey:string; models:string[]; timeoutMs?:number; caller?:string }
export async function callCritic(cfg:ModelCallConfig, packet:unknown):Promise<{verdict:IntelligenceVerdict;model:string}> {
  let last='no models configured'
  for(const model of cfg.models){
    const ctl=new AbortController(); const timer=setTimeout(()=>ctl.abort(),cfg.timeoutMs??90000)
    try{
      const r=await trackedModelFetch(cfg.baseUrl.replace(/\/+$/,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${cfg.apiKey}`},body:JSON.stringify({model,temperature:0,max_tokens:1800,response_format:{type:'json_schema',json_schema:VERDICT_SCHEMA},messages:[{role:'system',content:SYSTEM},{role:'user',content:JSON.stringify(packet)}]}),signal:ctl.signal},{caller:cfg.caller??'intelligence-critic',model})
      if(!r.ok){last=`${model}: HTTP ${r.status} ${(await r.text()).slice(0,180)}`;continue}
      const d=await r.json() as {choices?:{message?:{content?:string}}[]}
      const text=d.choices?.[0]?.message?.content
      if(!text) throw new Error('empty model response')
      return {verdict:parseStrictVerdict(JSON.parse(text)),model}
    }catch(e){last=`${model}: ${e instanceof Error?e.message:String(e)}`}finally{clearTimeout(timer)}
  }
  throw new Error(last)
}
