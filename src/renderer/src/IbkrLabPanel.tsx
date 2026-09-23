import {useState} from 'react'
import type {IbkrLabConfig,IbkrLabStatus} from '../../shared/ibkrLab'
const money=(n:number)=>n.toLocaleString(undefined,{style:'currency',currency:'USD'})
export default function IbkrLabPanel({data,configure,working,scan,liveView}:{data?:IbkrLabStatus;configure:(patch:Partial<IbkrLabConfig>)=>Promise<void>;working:boolean;scan:()=>void;liveView:boolean}){
  const [selected,setSelected]=useState<string[]>([])
  return <section className="panel ibkr-lab" style={{minWidth:0}}>
    <h2>IBKR automated strategy lab</h2>
    <p>Oracle paper accounts · Real IBKR ForecastEx quotes · $1,000 starting balance per strategy</p>
    {!data?<p>Loading strategy results…</p>:<>
      <p><strong>{data.config.mode==='paper'?'Paper trading':'Live strategies enabled; paper tests continue'}</strong> · {data.config.enabled?'Entries enabled':'Entries paused'} · {data.running?'Scanning markets…':`${data.scans} scans`} · {data.markets} matched markets · {data.freshQuotes} fresh outcome quotes</p>
      <p>{data.lastScanAt?`Last scan ${new Date(data.lastScanAt).toLocaleString()}`:'First market discovery is running.'} · Model forecasts today: {data.modelCalls}/8</p>
      <button disabled={working} onClick={()=>void configure({enabled:!data.config.enabled})}>{data.config.enabled?'Pause new entries':'Resume entries'}</button>{' '}
      <button disabled={working||data.running} onClick={scan}>Scan now</button>{' '}
      {data.config.mode==='live'&&<button disabled={working} onClick={()=>void configure({mode:'paper',liveStrategies:[]})}>Stop new live entries</button>}
      {liveView&&<button disabled={working||!selected.length} onClick={()=>void configure({mode:'live',liveStrategies:selected})}>Enable selected strategies with funded IBKR account</button>}
      {data.lastError&&<p role="alert">{data.lastError}</p>}
      {data.notes.map((note,i)=><p key={i}>{note}</p>)}
      <div style={{overflowX:'auto'}}><table><thead><tr><th>Strategy</th><th>Status</th><th>Open / pending</th><th>Closed</th><th>Wins / losses</th><th>Realized net</th><th>Open net estimate</th><th>Live qualification</th></tr></thead><tbody>
        {data.strategies.map(s=><tr key={s.id}><td title={s.reason}>{s.name}<details><summary>Method / latest signal</summary>{s.reason}</details></td><td>{s.status}</td><td>{s.open} / {s.pending}</td><td>{s.closed}{s.legacyClosed>0&&<div title="Opened under earlier rules; kept for history, not counted toward qualification">+{s.legacyClosed} old rules ({money(s.legacyRealized)})</div>}</td><td>{s.wins} / {s.losses}</td><td>{money(s.realized)}</td><td>{money(s.unrealized)}{s.unpriced>0&&` + ${s.unpriced} unpriced`}</td><td>{s.status==='Not applicable'?'—':s.id==='benchmark'||s.id==='settle-control'?'Control only':<><label><input type="checkbox" disabled={!s.liveEligible||working} checked={selected.includes(s.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,s.id]:ids.filter(id=>id!==s.id))}/>{s.liveEligible?'Qualified':`${s.closed}/30 closes · ${s.events}/10 events · ${s.days}/3 days`}</label>{s.confidenceLow!==undefined&&<div>Lower bound: {(s.confidenceLow*100).toFixed(1)}c / contract</div>}</>}</td></tr>)}
      </tbody></table></div>
      <p>Net includes 1c exchange fee per contract and 1c adverse slippage per taker leg. Passive fills require a later ask below the resting price; displayed size caps every fill. Open estimates use the opposing ask. Coupon income is excluded. Paper fills are simulated locally, not orders submitted to an IBKR paper account.</p>
      <p>Live qualification requires 30 closed trades across 10 events and 3 days, with a positive lower confidence bound across days. This screening rule is not proof of profitability.</p>
      <h3>Paper positions ({data.positions.length})</h3>
      {!!data.orders.length&&<details><summary>Pending paper orders ({data.orders.length})</summary><table><thead><tr><th>Strategy / contract</th><th>Side</th><th>Quantity</th><th>Limit</th><th>Entry type</th></tr></thead><tbody>{data.orders.map(o=><tr key={o.id}><td>{o.strategy}: {o.marketId}</td><td>{o.outcome}</td><td>{o.quantity}</td><td>{money(o.limit)}</td><td>{o.maker?'Passive':'Next executable quote'}</td></tr>)}</tbody></table></details>}
      {!data.positions.length?<p>No paper fills yet. Tests wait for executable quotes and their entry rules.</p>:<div style={{overflowX:'auto'}}><table><thead><tr><th>Strategy / event</th><th>Side</th><th>Quantity</th><th>Entry</th><th>Opened</th></tr></thead><tbody>{data.positions.map(p=><tr key={p.id}><td>{p.strategy}: {p.market.question}</td><td>{p.outcome}</td><td>{p.quantity}</td><td>{money(p.entry)}</td><td>{new Date(p.openedAt).toLocaleString()}</td></tr>)}</tbody></table></div>}
      <h3>Recent paper results</h3>
      {!data.trades.length?<p>No closed paper trades yet.</p>:<div style={{overflowX:'auto'}}><table><thead><tr><th>Strategy / event</th><th>Quantity</th><th>Net</th><th>Exit reason</th><th>Closed</th></tr></thead><tbody>{data.trades.map(t=><tr key={t.id}><td>{t.strategy}: {t.question}</td><td>{t.quantity}</td><td>{money(t.net)}</td><td>{t.reason}</td><td>{new Date(t.closedAt).toLocaleString()}</td></tr>)}</tbody></table></div>}
      {!!data.live.length&&<><h3>Live strategy orders</h3><table><thead><tr><th>Strategy / contract</th><th>Status</th><th>Filled / closed</th><th>Net</th></tr></thead><tbody>{data.live.map(p=><tr key={p.id}><td>{p.strategy}: {p.market.id}</td><td>{p.status} {p.message}</td><td>{p.filled} / {p.exitFilled}</td><td>{p.net===undefined?'Pending':money(p.net)}</td></tr>)}</tbody></table></>}
    </>}
  </section>
}
