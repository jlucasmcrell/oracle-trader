import {useEffect,useState} from 'react'
import type {PolyPaperStatus} from '../../shared/polyPaper'
const money=(n:number)=>n.toLocaleString(undefined,{style:'currency',currency:'USD'})
/** The Polymarket US "Paper (simulated)" account is the eight-arm paper lab, not the engine's paper ledger (which
 *  nothing on this venue trades while every arm is on operator hold). Same shape as the live card (§125). */
export function PolyPaperAccountCard(){
  const [data,setData]=useState<PolyPaperStatus>(),[error,setError]=useState('')
  useEffect(()=>{let active=true;const update=()=>void window.api.settings.polyPaperStatus().then(s=>{if(active){setData(s);setError('')}}).catch(e=>{if(active)setError(String(e))});update();const timer=setInterval(update,5000);return()=>{active=false;clearInterval(timer)}},[])
  if(!data)return <div className="muted">{error?`Paper lab unavailable: ${error}`:'Loading...'}</div>
  const arms=data.strategies,start=data.startingCash*arms.length
  const cash=arms.reduce((a,s)=>a+s.cash,0),realized=arms.reduce((a,s)=>a+s.net,0),unrealized=arms.reduce((a,s)=>a+s.unrealized,0),unpriced=arms.reduce((a,s)=>a+s.unpriced,0)
  // Account value = cash + open positions at their mark. A fill takes entry+fee from cash and mark is the net of exiting
  // on the last quote, so entry+fee+mark is what the position would return now (one contract per entry).
  const value=cash+data.positions.reduce((a,p)=>a+p.entry+p.fee+(p.mark??0),0),net=value-start
  const signed=(v:number)=>`${v>=0?'+':'-'}$${Math.abs(v).toFixed(2)}`,tone=(v:number)=>v>=0?'bt-pos':'bt-neg'
  return <>
    <div className="acct-mode acct-paper">PAPER · simulated · {arms.length} strategy accounts of {money(data.startingCash)}</div>
    <div className="acct-headline">
      <div><div className="stat-label">Account value</div><div className="big">${value.toFixed(2)} <span>USD</span></div><div className="muted">cash + open positions at current prices, all accounts</div></div>
      <div style={{textAlign:'right'}}><div className="stat-label">Net result</div><div className={`big ${tone(net)}`}>{signed(net)}</div><div className="muted">since {new Date(data.started).toLocaleDateString(undefined,{month:'short',day:'numeric'})}, after modelled fees</div></div>
    </div>
    <div className="acct-stats acct-grid">
      <span className="stat" title="Closed paper trades, after modelled fees and rebates."><span className="stat-label">Realized</span><span className={`stat-val ${tone(realized)}`}>{signed(realized)}</span></span>
      <span className="stat" title="Open paper positions at their last fresh quote."><span className="stat-label">Open P&amp;L</span><span className={`stat-val ${tone(unrealized)}`}>{signed(unrealized)}{unpriced?` (${unpriced} unpriced)`:''}</span></span>
      <span className="stat"><span className="stat-label">Open positions</span><span className="stat-val">{data.positions.length}</span></span>
      <span className="stat"><span className="stat-label">Resting orders</span><span className="stat-val">{data.orders.length}</span></span>
      <span className="stat"><span className="stat-label">Closed trades</span><span className="stat-val">{arms.reduce((a,s)=>a+s.closed,0)}</span></span>
      <span className="stat"><span className="stat-label">Scans</span><span className="stat-val">{data.scans}</span></span>
    </div>
    <div className="section-label">Accounts ({arms.length})</div>
    <ul className="positions">
      {arms.map(s=><li key={s.id}><span>{s.name}</span><span className={tone(s.net+s.unrealized)}>{signed(s.net+s.unrealized)}</span><span className="muted">{s.open} open · {s.closed} closed · {s.assessment}</span></li>)}
    </ul>
    <p className="muted">Details, rules and the per-arm verdicts are in the paper strategy tests panel. No broker orders.</p>
  </>
}

export default function PolyPaperPanel(){
  const [data,setData]=useState<PolyPaperStatus>(),[error,setError]=useState(''),[working,setWorking]=useState(false)
  useEffect(()=>{let active=true;const update=()=>void window.api.settings.polyPaperStatus().then(s=>{if(active)setData(s)}).catch(e=>{if(active)setError(String(e))});update();const timer=setInterval(update,5000);return()=>{active=false;clearInterval(timer)}},[])
  const toggle=async()=>{if(!data)return;setWorking(true);try{setData(await window.api.settings.polyPaperEnabled(!data.enabled));setError('')}catch(e){setError(String(e))}finally{setWorking(false)}}
  return <section className="panel" style={{gridColumn:'1 / -1',minWidth:0}} aria-label="Polymarket US paper laboratory">
    <h2>Polymarket US · Paper strategy tests</h2>
    {error&&<p role="alert">{error}</p>}
    {!data?<p>Loading paper tests…</p>:<>
      <p>Eight independent {money(data.startingCash)} simulated accounts · One contract per entry · Live market data · No broker orders</p>
      <p><strong>{data.enabled?'Paper entries enabled':'Paper entries paused'}</strong> · {data.running?'Scanning…':`${data.scans} scans`} · {data.discovered} catalog candidates · {data.tracked} tracked · {data.fresh} fresh books</p>
      <p>{data.lastScan?`Last scan ${new Date(data.lastScan).toLocaleString()}`:'First scan is starting.'} · Running since {new Date(data.started).toLocaleString()}</p>
      <button disabled={working} onClick={()=>void toggle()}>{data.enabled?'Pause paper entries':'Resume paper entries'}</button>
      <p className="muted">Independent of the global Paper/Live switch. Pausing removes pending simulated entries; open paper positions continue to be managed.</p>
      {data.lastError&&<p role="alert">{data.lastError}</p>}
      <div style={{overflowX:'auto'}}><table><thead><tr><th>Strategy</th><th>Cash</th><th>Open / pending</th><th>Closed</th><th>Realized net</th><th>Open net estimate</th><th>Evidence</th><th>Assessment</th></tr></thead><tbody>
        {data.strategies.map(s=><tr key={s.id}><td>{s.name}<details><summary>Entry rule</summary>{s.rule}</details></td><td>{money(s.cash)}</td><td>{s.open} / {s.pending}</td><td>{s.closed}{s.legacyClosed>0&&<div title="Opened under earlier rules; kept for history, not counted in the assessment">+{s.legacyClosed} old rules ({money(s.legacyNet)})</div>}</td><td>{money(s.net)}</td><td>{money(s.unrealized)}{s.unpriced>0&&` + ${s.unpriced} unpriced`}</td><td>{s.days}/7 days · {s.markets}/10 event groups · {s.closed}/100 closes{s.lower!==undefined&&<div>Day-based range: {(s.lower*100).toFixed(2)} to {(s.upper!*100).toFixed(2)}¢</div>}</td><td>{s.assessment}</td></tr>)}
      </tbody></table></div>
      <p className="muted">Passive fills require a later ask strictly below the resting limit. Takers pay the next executable ask plus 1¢ slippage; exits use bid minus 1¢. Published US taker fees apply, including tonight’s increase; the maker rebate (0.0125 x p(1-p)) is credited at the venue formula and rounds to zero at one contract; the liquidity incentive program is not modelled. Four open/pending entries and a $5 realized daily loss cap per strategy. Minute snapshots cannot prove queue priority or high-frequency profitability.</p>
      <p className="muted">Longshot and favorite controls hold to venue settlement. Other arms exit after 15 minutes, +3¢ net or −5¢ net. Early results are exploratory; day-based ranges are descriptive and multiple strategies are being compared. No result enables live trading automatically.</p>
      <details><summary>Open paper positions ({data.positions.length}) and pending orders ({data.orders.length})</summary><table><thead><tr><th>Strategy / market</th><th>Side</th><th>Entry / limit</th><th>Status</th></tr></thead><tbody>{[...data.positions,...data.orders].map(p=><tr key={p.id}><td>{p.strategy}: {p.market.question}</td><td>{p.side}</td><td>{money('entry' in p?Number(p.entry):p.limit)}</td><td>{'entry' in p?'Open':'Pending'}</td></tr>)}</tbody></table></details>
      <details><summary>Recent closed paper trades</summary><table><thead><tr><th>Strategy / market</th><th>Net</th><th>Exit</th></tr></thead><tbody>{data.trades.map(t=><tr key={t.id}><td>{t.strategy}: {t.market.question}</td><td>{money(t.net)}</td><td>{t.reason} · {new Date(t.closed).toLocaleString()}</td></tr>)}</tbody></table></details>
    </>}
  </section>
}
