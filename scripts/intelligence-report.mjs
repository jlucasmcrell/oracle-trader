import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const root=process.env.APPDATA||''
const file=join(root,'oracle-trader','intelligence','decisions.jsonl')
if(!existsSync(file)){console.log('No intelligence decisions recorded yet. Shadow engine waits for rules-eligible candidates.');process.exit(0)}
const rows=readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).flatMap(x=>{try{return [JSON.parse(x)]}catch{return []}})
const by=(key)=>Object.entries(rows.reduce((a,r)=>{const k=key(r);const x=a[k]??={n:0,eligible:0,errors:0,edge:0,edgeN:0};x.n++;if(r.adjudication?.eligible)x.eligible++;if(r.apiError)x.errors++;const e=r.adjudication?.conservativeEdgeCents;if(Number.isFinite(e)){x.edge+=e;x.edgeN++}a[k]=x;return a},{}))
console.log(`Oracle Intelligence shadow report: ${rows.length} decisions`)
for(const [label,key] of [['model',r=>r.model||'unavailable'],['strategy',r=>r.packet?.strategy||'unknown'],['action',r=>r.verdict?.action||'ERROR']]){
 console.log(`\nBy ${label}:`);for(const [k,x] of by(key)) console.log(`  ${k}: n=${x.n} eligible=${x.eligible} apiErrors=${x.errors} meanConservativeEdge=${x.edgeN?(x.edge/x.edgeN).toFixed(2):'n/a'}c`)
}
console.log('\nThis report is decision telemetry, not profitability. Settlement-linked counterfactual grading begins after outcomes exist.')
