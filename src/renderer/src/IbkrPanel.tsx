import { useEffect, useState } from 'react'
import type { IbkrInstrument, IbkrQuote, IbkrSnapshot, IbkrPreview, IbkrWatch } from '../../shared/ibkr'
import IbkrLabPanel from './IbkrLabPanel'
import type { IbkrLabConfig, IbkrLabStatus } from '../../shared/ibkrLab'
import type { OrderRequest } from '../../shared/types'

const labels: Record<string, string> = { NetLiquidation: 'Account value', TotalCashValue: 'Cash', AvailableFunds: 'Available funds', BuyingPower: 'Buying power' }
const price = (n?: number) => n === undefined ? 'Unavailable' : `${(n * 100).toFixed(1)}¢`

export default function IbkrPanel() {
  const [lab,setLab]=useState<IbkrLabStatus>()
  const [accountView,setAccountView]=useState<'paper'|'live'>('paper')
  const [labError,setLabError]=useState(''),[labWorking,setLabWorking]=useState(false)
  useEffect(()=>{let active=true,first=true;const update=()=>void window.api.settings.ibkrLabStatus().then(s=>{if(active){setLab(s);if(first){setAccountView(s.config.mode);first=false}}}).catch(e=>{if(active)setLabError(String(e))});update();const timer=setInterval(update,5000);return()=>{active=false;clearInterval(timer)}},[])
  const configureLab=async(patch:Partial<IbkrLabConfig>)=>{setLabWorking(true);try{const s=await window.api.settings.ibkrLabConfigure(patch);setLab(s);if(patch.mode)setAccountView(s.config.mode);setLabError('')}catch(e){setLabError(String(e))}finally{setLabWorking(false)}}
  const paperStrategies=lab?.strategies.filter(s=>s.status!=='Not applicable')??[]
  const [snapshot, setSnapshot] = useState<IbkrSnapshot | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [symbol, setSymbol] = useState('FF')
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const [markets, setMarkets] = useState<IbkrInstrument[]>([])
  const [marketStatus, setMarketStatus] = useState('')
  const [searching, setSearching] = useState(false)
  const [quote, setQuote] = useState<IbkrQuote | null>(null)
  const [selected, setSelected] = useState<IbkrInstrument | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteError, setQuoteError] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [limit, setLimit] = useState(1)
  const [preview, setPreview] = useState<IbkrPreview | null>(null)
  const [working, setWorking] = useState(false)
  const [orderStatus, setOrderStatus] = useState('')
  const [closing, setClosing] = useState<IbkrSnapshot['positions'][number] | null>(null)
  const [watches,setWatches] = useState<IbkrWatch[]>([])
  const [reconciliation,setReconciliation] = useState<{lastRunAt?:number;lastError?:string;ingested:number}|null>(null)
  const availableCash = Math.min(...['AvailableFunds','TotalCashValue'].map(tag=>Number(snapshot?.accounts.find(r=>r.account===preview?.account&&r.tag===tag&&r.currency==='USD')?.value)))
  const watch = async()=>{
    setWorking(true)
    try{setWatches(await window.api.settings.ibkrWatchAdd(request(),Date.now()+3600_000));setPreview(null);setOrderStatus('Watching for up to one hour. One submission only; partial or unfilled orders are not retried.')}
    catch(e){setOrderStatus(String(e))}finally{setWorking(false)}
  }
  const stopWatch = async(id:string)=>{
    try{setWatches(await window.api.settings.ibkrWatchStop(id))}catch(e){setOrderStatus(String(e))}
  }
  const request = ():OrderRequest => ({venue:'ibkr',marketId:String(selected!.conId),outcome:closing ? (closing.instrument.outcome==='YES'?'NO':'YES') : selected!.outcome!,contracts:quantity,limitPrice:limit/100,amount:preview?.maxCost ?? quantity*(limit/100+.02),ref:closing?'ibkr-close':'ibkr-manual'})
  const previewOrder = async () => {
    setWorking(true); setPreview(null); setOrderStatus('Checking with IBKR…')
    try { const p = await window.api.settings.ibkrPreview(request()); setPreview(p); setOrderStatus('Broker preview received. No order has been submitted.') }
    catch(err){setOrderStatus(String(err))}
    finally{setWorking(false)}
  }
  const submit = async () => {
    setWorking(true); setOrderStatus('Submitting…')
    try {
      if ((await window.api.engine.getState()).executionMode !== 'live') throw new Error('Switch Oracle to Live before submitting an IBKR order')
      const result = closing ? await window.api.engine.sellPosition({venue:'ibkr',marketId:String(closing.instrument.conId),outcome:closing.instrument.outcome!,shares:quantity,limitPrice:closing.instrument.outcome==='YES'?1-limit/100:limit/100}) : await window.api.engine.placeOrder(request())
      setPreview(null); setOrderStatus(`Order ${result.orderId}: ${result.venueStatus ?? result.status}. Fills are recorded separately.`); await refresh()
    } catch(err){setPreview(null);setOrderStatus(`${String(err)}. Refresh orders before trying again.`)}
    finally{setWorking(false)}
  }
  const cancel = async(id:string) => {
    setWorking(true)
    try {await window.api.settings.ibkrCancel(id); setOrderStatus('Cancellation checked with IBKR.'); await refresh()}
    catch(err){setOrderStatus(String(err))}
    finally{setWorking(false)}
  }
  const refresh = async () => {
    setBusy(true); setError('')
    try { setSnapshot(await window.api.settings.ibkrSnapshot()); setWatches(await window.api.settings.ibkrWatches()) }
    catch (err) { setError(String(err)) }
    finally { setBusy(false) }
  }
  const search = async () => {
    setSearching(true); setMarkets([]); setMarketStatus('Loading contracts from IBKR…'); setSelected(null); setQuote(null); setPreview(null); setClosing(null)
    try {
      const rows = await window.api.settings.ibkrMarkets(symbol, month)
      setMarkets(rows); setMarketStatus(`${rows.length} contracts returned by IBKR`)
    } catch (err) { setMarketStatus(String(err)) }
    finally { setSearching(false) }
  }
  const loadQuote = async (row: IbkrInstrument) => {
    setSelected(row); setQuote(null); setQuoteError(''); setQuoting(true); setClosing(null); setPreview(null); setOrderStatus('')
    try { const q=await window.api.settings.ibkrQuote(row.conId); setQuote(q); if(q.ask!==undefined)setLimit(Math.round(q.ask*100)) }
    catch (err) { setQuoteError(String(err)) }
    finally { setQuoting(false) }
  }
  useEffect(() => { void refresh(); void search() }, [])
  useEffect(()=>{const update=()=>{void window.api.settings.ibkrWatches().then(setWatches).catch(e=>setError(String(e)));void window.api.settings.ibkrReconciliation().then(setReconciliation).catch(e=>setError(String(e)))};update();const timer=setInterval(update,15000);return()=>clearInterval(timer)},[])
  return <main className="ibkr-layout">
    <aside className="panel ibkr-account">
      <h2>Account · IBKR</h2>
      <div className="mode-toggle" aria-label="IBKR account view">
        <button className={accountView==='paper'?'active':''} aria-pressed={accountView==='paper'} onClick={()=>setAccountView('paper')}>Paper (simulated)</button>
        <button className={accountView==='live'?'active':''} aria-pressed={accountView==='live'} onClick={()=>setAccountView('live')}>Real account</button>
      </div>
      <div className={`acct-mode ${lab?.config.mode==='live'?'acct-live':'acct-paper'}`}>{lab?lab.config.mode==='live'?'LIVE strategies enabled · real money':'PAPER only · no real-money orders':'Loading trading status…'}</div>
      <p className="muted">The buttons above switch what this panel shows, not how Oracle trades.</p>
      {labError&&<p role="alert">{labError}</p>}
      {accountView==='paper'?<>
        <p>{paperStrategies.length} simulated accounts, $1,000 each · real IBKR quotes</p>
        {lab&&(()=>{const realized=paperStrategies.reduce((n,s)=>n+s.realized,0),open=paperStrategies.reduce((n,s)=>n+s.unrealized,0),legacy=paperStrategies.reduce((n,s)=>n+s.legacyRealized,0),legacyClosed=paperStrategies.reduce((n,s)=>n+s.legacyClosed,0),signed=(v:number)=>`${v>=0?'+':'-'}$${Math.abs(v).toFixed(2)}`
          return <>
          <div className="stat-label">Paper net result (current rules)</div>
          <div className={`big ${realized+open>=0?'bt-pos':'bt-neg'}`}>{signed(realized+open)}</div>
          <p>Settled/closed {signed(realized)} · open {signed(open)}{paperStrategies.reduce((n,s)=>n+s.unpriced,0)>0&&` (+ ${paperStrategies.reduce((n,s)=>n+s.unpriced,0)} positions without a current price)`}</p>
          {legacyClosed>0&&<p className="muted">Before the 17 Sep rule change: {legacyClosed} closed trades, {signed(legacy)} (history only, not counted)</p>}
          </>})()}
        {lab&&<>
          <p>{lab.positions.length} open positions · {lab.orders.length} pending orders</p>
          <details><summary>Cash by strategy</summary><table><tbody>{paperStrategies.map(s=><tr key={s.id}><td>{s.name}</td><td>${s.cash.toFixed(2)}</td></tr>)}</tbody></table></details>
          {lab.config.mode==='live'&&<><p>Paper tests continue alongside live trading.</p><button disabled={labWorking} onClick={()=>void configureLab({mode:'paper',liveStrategies:[]})}>Switch trading to Paper</button><p className="muted">Stops new live strategy entries. Existing live positions remain managed.</p></>}
        </>}
        <p className="muted">Simulated funds and fills stay in Oracle; these are not brokerage paper-account orders.</p>
      </>:<>
      {snapshot&&(()=>{const value=snapshot.accounts.find(r=>r.tag==='NetLiquidation')??snapshot.accounts.find(r=>r.tag==='TotalCashValue');const n=value?Number(value.value):NaN
        return <><div className="stat-label">Real IBKR account value</div>
        <div className="big">{Number.isFinite(n)?`$${n.toFixed(2)}`:'Unavailable'} <span>{value?.currency??''}</span></div>
        {Number.isFinite(n)&&n<=0&&<p role="status"><strong>Not funded.</strong> No real-money IBKR trading is possible until the account is funded.</p>}</>})()}
      <p>{lab?.strategies.filter(s=>s.liveEligible).length??0} strategies qualified for live trading.</p>
      <p className="muted">Select qualified strategies in the lab, then enable them with a funded account. Viewing Live does not start trading.</p>
      <button onClick={refresh} disabled={busy}>{busy ? 'Loading account…' : 'Refresh account'}</button>
      {error && <p role="alert">{error} {snapshot && 'The last successful snapshot is shown below.'}</p>}
      {snapshot && <>
        <p>{snapshot.mode === 'live' ? 'Live account' : 'Paper account'} · Updated {new Date(snapshot.at).toLocaleString()}</p>
        <table><thead><tr><th>Account</th><th>Balance</th><th>Value</th></tr></thead><tbody>
          {snapshot.accounts.map(row => <tr key={`${row.account}-${row.tag}-${row.currency}`}><td>{row.account}</td><td>{labels[row.tag] ?? row.tag}</td><td>{row.value} {row.currency}</td></tr>)}
        </tbody></table>
        <h3>Positions ({snapshot.positions.length})</h3>
        {!snapshot.positions.length ? <p>No open positions reported by IBKR.</p> : <table><thead><tr><th>Contract</th><th>Account</th><th>Quantity</th><th>Average cost</th></tr></thead><tbody>
          {snapshot.positions.map(row => <tr key={`${row.account}-${row.instrument.conId}`}><td>{row.instrument.description}{row.instrument.exchange==='FORECASTX' && row.instrument.outcome && <button disabled={working||quoting} onClick={()=>{setClosing(row);setSelected(row.instrument);setQuote(null);setPreview(null);setQuantity(row.quantity);setOrderStatus('Choose the maximum price to pay for the opposing contract.')}}>Prepare close</button>}</td><td>{row.account}</td><td>{row.quantity}</td><td>{row.averageCost ?? 'Unavailable'} {row.instrument.currency}</td></tr>)}
        </tbody></table>}
        <h3>Open orders ({snapshot.orders.length})</h3>
        {!snapshot.orders.length ? <p>No open orders reported by IBKR.</p> : <table><thead><tr><th>Contract</th><th>Action</th><th>Quantity</th><th>Limit</th><th>Status</th></tr></thead><tbody>
          {snapshot.orders.map(row => <tr key={`${row.account}-${row.clientId}-${row.id}`}><td>{row.instrument.description}</td><td>{row.action}</td><td>{row.quantity}</td><td>{row.limitPrice ?? 'Unavailable'}</td><td>{row.status}{row.clientId===17091 && row.instrument.exchange==='FORECASTX' && <button disabled={working} onClick={()=>void cancel(`${row.clientId}:${row.id}`)}>Cancel order</button>}</td></tr>)}
        </tbody></table>}
      </>}
      </>}
    </aside>
    <div className="ibkr-content">
    <IbkrLabPanel data={lab} configure={configureLab} working={labWorking} liveView={accountView==='live'} scan={()=>void window.api.settings.ibkrLabScan().then(setLab).catch(e=>setLabError(String(e)))} />
    {accountView==='live'&&<section className="panel">
      <h2>ForecastEx prediction markets</h2>
      <p><strong>Broker order tools · Real money</strong></p>
      <p>Search by product symbol. FF is the Fed Funds rate. YES and NO are separate contracts.</p>
      <form onSubmit={e => { e.preventDefault(); void search() }}>
        <label>Product symbol <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} maxLength={16} disabled={searching || quoting} /></label>
        <label>Contract month <input type="month" value={month} onChange={e => setMonth(e.target.value)} disabled={searching || quoting} /></label>
        <button disabled={working || searching || quoting || !symbol.trim()}>{searching ? 'Searching…' : 'Find markets'}</button>
      </form>
      <p role="status">{marketStatus}</p>
      {selected && <div><h3>{selected.description}</h3>
        {quoting ? <p>Fetching quote…</p> : quoteError ? <p role="alert">{quoteError}</p> : quote && <p>Highest bid: {price(quote.bid)} · Buy now: {price(quote.ask)} · {quote.dataType} snapshot at {new Date(quote.at).toLocaleTimeString()}</p>}
        <p className="muted">Quotes are snapshots. Missing prices mean no quote was supplied. Limit orders remain open until filled or canceled.</p>
        <h3>{closing ? `Close by buying ${closing.instrument.outcome==='YES'?'NO':'YES'}` : `Buy ${selected.outcome}`}</h3>
        <label>Contracts <input aria-label="Contracts" type="number" min="1" max={closing?.quantity ?? 10000} step="1" value={quantity} disabled={working} onChange={e=>{setQuantity(Number(e.target.value));setPreview(null)}} /></label>
        <label>Maximum price (cents) <input aria-label="Maximum price (cents)" type="number" min="1" max="99" step="1" value={limit} disabled={working} onChange={e=>{setLimit(Number(e.target.value));setPreview(null)}} /></label>
        <button disabled={working||quoting||!selected.outcome} onClick={()=>void previewOrder()}>Preview with IBKR</button>
        {preview && <p>Account {preview.account} · {preview.quantity} contracts · cash reserved ${preview.maxCost.toFixed(2)} · fee reserve ${preview.feeReserve.toFixed(2)} ({preview.feeSource}{preview.commission===undefined?'; broker did not quote commission':''}). {preview.warning}<br/>{(!Number.isFinite(availableCash)||availableCash<preview.maxCost)&&<>Insufficient available cash. Refresh the account after funding.<br/></>}<button disabled={working||snapshot?.mode!=='live'||!Number.isFinite(availableCash)||availableCash<preview.maxCost} onClick={()=>void submit()}>Submit live {closing?'closing ':''}order</button>{!closing&&<button disabled={working||snapshot?.mode!=='live'} onClick={()=>void watch()}>Watch and buy once · 1 hour</button>}</p>}
      </div>}
      {orderStatus && <p role="status">{orderStatus}</p>}
      <h3>Automatic entry rules</h3>
      <p className="muted">Checks every minute for a live ask at or below your limit, then submits once through Oracle's risk controls. Requires Oracle Live mode. These rules follow your price target; they do not estimate a profitable price.</p>
      {!watches.length?<p>No automatic entry rules.</p>:<ul>{watches.map(w=><li key={w.id}>{w.request.outcome} · {w.request.contracts} contracts at ≤ {price(w.request.limitPrice)} · {w.state} · {w.message} {w.state==='watching'&&<button onClick={()=>void stopWatch(w.id)}>Stop watching</button>}</li>)}</ul>}
      <p className="muted">Execution history is reconciled every minute while Oracle is running. IBKR's execution feed has limited history; this is not a complete account P&amp;L statement.</p>
      {reconciliation&&<p role={reconciliation.lastError?'alert':'status'}>Fill reconciliation: {reconciliation.lastError??(reconciliation.lastRunAt?`checked ${new Date(reconciliation.lastRunAt).toLocaleTimeString()} · ${reconciliation.ingested} fills recorded`:'waiting for first check')}</p>}
      <div style={{ maxHeight: 520, overflow: 'auto' }}><table><thead><tr><th>Market</th><th>Outcome</th><th>Strike</th><th>Last trading time</th><th>Quote</th></tr></thead><tbody>
        {markets.map(row => <tr key={row.conId}><td>{row.name}<br/><small>{row.description}</small></td><td>{row.outcome ?? 'Unknown'}</td><td>{row.strike}</td><td>{row.lastTradeTime}</td><td><button disabled={working || quoting || searching} onClick={() => void loadQuote(row)}>Get quote</button></td></tr>)}
      </tbody></table></div>
    </section>}
    </div>
  </main>
}
