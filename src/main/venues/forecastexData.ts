import type { IbkrLabMarket } from '../../shared/ibkrLab'
import type { IbkrReader } from './ibkr'
import { ibkrExecutionTime } from './ibkrAdapter'
interface PublicContract {
  contract_id:string;product_id:string;category:string;question:string;last_trade_date:string
  expiration_date:string;open_interest:number;exchange_spec_url:string;last_yes_price:number|null
}
export function forecastTime(value:string):number {
  if(/[Zz]|[+-]\d\d:\d\d$/.test(value))return Date.parse(value)
  const m=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/.exec(value)
  if(!m)throw new Error('Invalid ForecastEx timestamp')
  return ibkrExecutionTime(`${m[1]}${m[2]}${m[3]} ${m[4]}:${m[5]}:${m[6]} America/Chicago`)
}
async function json(url:string){const r=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`ForecastEx HTTP ${r.status}`);return r.json()}
export async function forecastCatalog():Promise<PublicContract[]> {
  const rows:PublicContract[]=[]
  for(let page=1;page<=40;page++){
    const r=await json(`https://forecastex.com/api/contracts?page=${page}&pageSize=1000`)
    if(r.statusCode!==200||typeof r.body?.data!=='string')throw new Error('Invalid ForecastEx catalog response')
    const data=JSON.parse(r.body.data)
    if(!Array.isArray(data))throw new Error('Invalid ForecastEx contracts')
    rows.push(...data)
    if(!r.body.next_page)return rows
    if(r.body.next_page!==page+1)throw new Error('Unexpected ForecastEx pagination')
  }
  throw new Error('ForecastEx catalog exceeded pagination limit')
}
/** Match exact exchange contract IDs, not fuzzy titles or merely similar settlement dates. */
export async function discoverForecastMarkets(reader:IbkrReader,now:number,report:(message:string)=>void):Promise<IbkrLabMarket[]> {
  const all=(await forecastCatalog()).filter(r=>r.contract_id&&r.product_id&&forecastTime(r.last_trade_date)>now+300000&&forecastTime(r.last_trade_date)<now+366*86400000)
  const byProduct=new Map<string,PublicContract[]>()
  for(const r of all){const rows=byProduct.get(r.product_id)??[];rows.push(r);byProduct.set(r.product_id,rows)}
  const priority=['FF','CFBTC','CFETH','CFSOL','CFXRP','IJC','CPIY','UNR','PREMP','RGDP','UHLAX','ULLAX','UHPHX']
  const ranked=[...byProduct].sort((a,b)=>{
    const pa=priority.indexOf(a[0]),pb=priority.indexOf(b[0])
    return (pa<0?100:pa)-(pb<0?100:pb)||Math.max(...b[1].map(r=>r.open_interest))-Math.max(...a[1].map(r=>r.open_interest))
  })
  // A bounded universe still covers every listed category, including elections outside the next month.
  const representatives=[...new Set(all.map(r=>r.category))].flatMap(category=>ranked.filter(([,rows])=>rows[0].category===category).slice(0,2))
  const products=[...new Map([...ranked.filter(([p])=>priority.includes(p)),...representatives,...ranked]).entries()].slice(0,36)
  const result:IbkrLabMarket[]=[]
  for(const [product,rows] of products){
    const ids=new Map(rows.map(r=>[r.contract_id,r]))
    // Contract month can name the observation month rather than last trading month (e.g. CPI).
    const months=[...new Set(rows.map(r=>{
      const code=r.contract_id.split('_')[1]??''
      const m=code.length===4?/^(\d{2})(\d{2})$/.exec(code):/^(\d{2})\d{2}(\d{2})/.exec(code)
      return m&&+m[1]>=1&&+m[1]<=12?`20${m[2]}-${m[1]}`:r.last_trade_date.slice(0,7)
    }))].sort().slice(0,2)
    const instruments=[]
    for(const month of months)try{instruments.push(...await reader.markets(product,month))}catch(e){report(`${product} ${month}: ${String(e)}`)}
    const pairs=new Map<string,{yes?:typeof instruments[number];no?:typeof instruments[number]}>()
    for(const c of instruments){const id=c.description.replace(/_(YES|NO)$/,'');if(!ids.has(id))continue;const p=pairs.get(id)??{};if(c.outcome==='YES')p.yes=c;if(c.outcome==='NO')p.no=c;pairs.set(id,p)}
    const available=[...pairs].filter(([,p])=>p.yes&&p.no).sort((a,b)=>{
      const ra=ids.get(a[0])!,rb=ids.get(b[0])!
      return forecastTime(ra.last_trade_date)-forecastTime(rb.last_trade_date)||(rb.open_interest??0)-(ra.open_interest??0)
    })
    // Include central and tail strikes rather than only an alphabetic low-strike slice.
    const selected=available.length<=12?available:Array.from({length:12},(_,i)=>available[Math.round(i*(available.length-1)/11)])
    for(const [id,p] of selected){const r=ids.get(id)!;result.push({id,product,question:r.question,category:r.category,rulesUrl:r.exchange_spec_url,closeTime:forecastTime(r.last_trade_date),expiresAt:forecastTime(r.expiration_date),strike:p.yes!.strike!,direction:/\b(above|exceed|more than|greater than|over)\b/i.test(r.question)?'above':/\b(below|less than|under)\b/i.test(r.question)?'below':undefined,yes:p.yes!,no:p.no!})}
    report(`${product}: ${selected.length} matched contracts`)
  }
  if(!result.length)throw new Error('No exact ForecastEx/IBKR contract matches; entries remain paused')
  return result
}
/** Parse exchange CSV without treating quoted commas as column separators. */
export function csvRows(text:string):string[][] {
  const rows:string[][]=[];let row:string[]=[],field='',quoted=false
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++}else quoted=!quoted}else if(c===','&&!quoted){row.push(field);field=''}else if(c==='\n'&&!quoted){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field=''}else field+=c}
  if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row)}
  if(quoted)throw new Error('Truncated ForecastEx CSV')
  return rows
}
export function finalSettlements(text:string,date:string,now:number):Map<string,number> {
  const rows=csvRows(text),header=rows.shift()??[],idx=(name:string)=>header.indexOf(name)
  for(const name of ['event_contract','subtype','expiration_date','settlement_price'])if(idx(name)<0)throw new Error('ForecastEx settlement schema changed')
  const result=new Map<string,number>(),pairs=new Map<string,{yes?:number;no?:number}>()
  for(const row of rows){const raw=row[idx('settlement_price')];if(!['YES','NO'].includes(row[idx('subtype')])||!['0','1','0.00','1.00','0.0','1.0'].includes(raw))continue
    const expiry=forecastTime(row[idx('expiration_date')]);if(!Number.isFinite(expiry)||expiry>now||expiry>forecastTime(`${date}T23:59:59`))continue
    const id=row[idx('event_contract')],p=pairs.get(id)??{}
    if(row[idx('subtype')]==='YES')p.yes=Number(raw);else p.no=Number(raw)
    pairs.set(id,p)
  }
  for(const [id,p] of pairs)if(p.yes!==undefined&&p.no!==undefined&&p.yes+p.no===1)result.set(id,p.yes)
  return result
}
export async function loadFinalSettlements(now:number,from:number):Promise<Map<string,number>> {
  const result=new Map<string,number>()
  // Seven days on every pass covers weekends; the persisted oldest unresolved expiry drives a longer backfill.
  const days=Math.min(90,Math.max(7,Math.ceil((now-from)/86400000)+2))
  for(let i=0;i<days;i++){
    const date=new Date(now-i*86400000).toISOString().slice(0,10)
    const r=await fetch(`https://data.forecastex.com/prices/daily_prices_${date.replace(/-/g,'')}.csv`,{signal:AbortSignal.timeout(15000)})
    if(r.status===404)continue
    if(!r.ok)throw new Error(`ForecastEx settlements HTTP ${r.status}`)
    for(const [id,p] of finalSettlements(await r.text(),date,now))if(!result.has(id))result.set(id,p)
  }
  return result
}
