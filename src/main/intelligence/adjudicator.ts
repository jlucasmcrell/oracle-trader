import type { Adjudication, CandidatePacket, IntelligenceVerdict } from './types'
const finite01=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1
export function parseStrictVerdict(raw: unknown): IntelligenceVerdict {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('verdict is not an object')
  const o=raw as Record<string,unknown>
  const allowed=new Set(['action','pYesLow','pYesMid','pYesHigh','confidence','evidenceSufficient','ruleRisk','dataRisks','failureMode','citedEvidenceIds','reason'])
  for(const k of Object.keys(o)) if(!allowed.has(k)) throw new Error(`unknown verdict field: ${k}`)
  if(!['ALLOW_UNCHANGED','VETO','ABSTAIN_INSUFFICIENT_EVIDENCE'].includes(String(o.action))) throw new Error('invalid action')
  if(!finite01(o.pYesLow)||!finite01(o.pYesMid)||!finite01(o.pYesHigh)||!finite01(o.confidence)) throw new Error('invalid probability/confidence')
  if(o.pYesLow>o.pYesMid||o.pYesMid>o.pYesHigh) throw new Error('probability interval is unordered')
  if(typeof o.evidenceSufficient!=='boolean') throw new Error('evidenceSufficient required')
  if(!['low','medium','high','unknown'].includes(String(o.ruleRisk))) throw new Error('invalid ruleRisk')
  if(!Array.isArray(o.dataRisks)||!o.dataRisks.every(x=>typeof x==='string')) throw new Error('invalid dataRisks')
  if(!Array.isArray(o.citedEvidenceIds)||!o.citedEvidenceIds.every(x=>typeof x==='string')) throw new Error('invalid citedEvidenceIds')
  if(typeof o.failureMode!=='string'||typeof o.reason!=='string') throw new Error('reason/failureMode required')
  return o as unknown as IntelligenceVerdict
}
export function adjudicate(packet: CandidatePacket, v: IntelligenceVerdict, minEdgeCents=2): Adjudication {
  const errors:string[]=[]
  const known=new Set(packet.evidence.map(e=>e.id))
  if(v.citedEvidenceIds.some(id=>!known.has(id))) errors.push('verdict cites evidence not in packet')
  if(!v.evidenceSufficient) errors.push('evidence insufficient')
  if(v.ruleRisk==='high'||v.ruleRisk==='unknown') errors.push(`rule risk ${v.ruleRisk}`)
  const q=packet.order
  const gross=q.direction==='YES' ? v.pYesLow-q.executablePrice : (1-v.pYesHigh)-q.executablePrice
  const edge=gross*100-q.feeCents-q.slippageReserveCents
  if(edge<minEdgeCents) errors.push(`conservative edge ${edge.toFixed(2)}c < ${minEdgeCents.toFixed(2)}c`)
  if(v.action!=='ALLOW_UNCHANGED') errors.push(`model action ${v.action}`)
  return {eligible:errors.length===0,action:v.action,conservativeEdgeCents:Math.round(edge*100)/100,reason:errors[0]??v.reason,errors}
}
