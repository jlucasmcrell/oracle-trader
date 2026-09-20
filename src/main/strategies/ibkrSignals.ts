import type { IbkrQuote } from '../../shared/ibkr'
import type { IbkrLabMarket } from '../../shared/ibkrLab'
export const IBKR_STRATEGIES = [
  {id:'fade',name:'Longshot fade',description:'Buy the opposite of a 3–12% longshot; test favorite-longshot calibration.'},
  {id:'favorite',name:'Favorite continuation',description:'Buy the 75–92% side with at least 4c of payout room after costs.'},
  {id:'calibration',name:'Probability recalibration',description:'Category log-odds slope from the Becker evaluation half (only Politics is compressed, 1.15; every other group is calibrated within band and yields no entry); enters when that fair value is at least 0.5c above the ask and holds to settlement, so the result measures the slope after costs.'},
  {id:'political-favorite',name:'Political underconfidence',description:'Recalibration restricted to election and government contracts.'},
  {id:'momentum',name:'Quote momentum',description:'Follow a 4c ten-minute move; distinct from the Kalshi trade-print rule.'},
  {id:'log-momentum',name:'Log-odds momentum',description:'Follow a 0.35 log-odds move over ten minutes.'},
  {id:'mean-reversion',name:'Quote mean reversion',description:'Fade an 8c ten-minute move with at least two hours remaining.'},
  {id:'breakout',name:'Quote range breakout',description:'Buy a 3c break beyond the preceding quote range.'},
  {id:'book-imbalance',name:'Paired-book imbalance',description:'Compare displayed YES and NO ask depth; executable synthetic bid/ask.'},
  {id:'microprice',name:'Depth-weighted pressure',description:'Follow a 0.5c depth-weighted shift from paired midpoint; tests future quote pressure, not a guaranteed arbitrage.'},
  {id:'maker',name:'Two-sided market making',description:'Rest both outcomes inside their asks; simulated fills require a later trade-through.'},
  {id:'fade-maker',name:'Passive longshot fade',description:'Same favorite-longshot rule with passive limit entry.'},
  {id:'ladder-value',name:'Neighbor-strike relative value',description:'Compare a strike with interpolation of adjacent same-event strikes.'},
  {id:'spot-first',name:'Crypto spot fair value',description:'Coinbase spot and measured five-minute return volatility versus CF crypto strikes; reference-basis risk applies.'},
  {id:'convergence',name:'Crypto near-expiry convergence',description:'Spot fair value during the final 2–6 minutes; no inference from quote alone.'},
  {id:'news',name:'News-assisted model forecast',description:'Existing configured model plus fresh headlines and the exact exchange question.'},
  {id:'market-conditioned',name:'Market-conditioned forecast',description:'70% market / 30% independently recorded model forecast.'},
  {id:'weather-forecast',name:'Station weather forecast',description:'NWS hourly forecasts plus station observations, with Weather Underground settlement basis explicitly retained.'},
  {id:'weather-morning',name:'Morning weather forecast',description:'Same station forecast, limited to before 10 AM local time.'},
  {id:'weather-maker',name:'Passive weather value',description:'Rest below forecast fair value; requires a later executable trade-through.'},
  {id:'benchmark',name:'Market-entry control',description:'One deterministic outcome per contract as a friction/control baseline; never promoted live.'},
] as const
export const IBKR_UNAVAILABLE = [
  {id:'volume-spike',name:'Trade-volume spikes',reason:'ForecastEx TWS feed has no trade prints or intraday traded-volume series. Quote sizes are not trade volume.'},
  {id:'flow-follow',name:'Large-trade following',reason:'ForecastEx TWS does not publish the required trade prints/aggressor side.'},
  {id:'cross-venue',name:'Cross-venue / 15-minute lead-lag',reason:'Oracle’s registered 15-minute crypto windows do not match ForecastEx daily contracts and settlement rules.'},
  {id:'consensus',name:'Wallet consensus / copy trading',reason:'IBKR exposes no public participant wallets or position feed for these contracts.'},
  {id:'sports-anchor',name:'Sharp sports / player props',reason:'The verified ForecastEx catalog has no matching sports instruments for Oracle’s sportsbook anchor.'},
  {id:'weather-locked',name:'Weather certain-outcome lock',reason:'ForecastEx resolves from Weather Underground daily history. NWS observations cannot certify that separate settlement source; forecast strategies test the basis risk instead.'},
  {id:'mention',name:'Transcript mention model',reason:'No matching mention-count instruments in the verified ForecastEx catalog.'},
  {id:'rewards',name:'Venue rewards / incentive farming',reason:'Kalshi and Polymarket incentive programs do not apply to ForecastEx.'},
  {id:'dutch',name:'YES/NO parity',reason:'ForecastEx quotes the pair above par by construction. Measured over 48,006 paired observations on 2026-09-18..20 with both legs quoted at size >= 1, the cheapest YES+NO pair was $1.0100 and the spread histogram floors at +1c: zero crossings, before the 4c of fees and slippage an entry would also have to clear (section 143).'},
  {id:'implication',name:'Strike implication basket',reason:'Same measurement on the same logs for the exhaustive two-strike pair: no pair of adjacent same-event strikes was ever quoted below par, so the basket has never existed here (section 143).'},
  {id:'cme',name:'CME event-contract feed',reason:'Gateway returned no ECES contract definition; the ES underlying option-chain probe also returned no EC event class. These instruments are outside the verified ForecastEx test universe.'},
] as const
/**
 * Settlement hypotheses are held to the exchange's final value. Timed exits turned them into one-hour scalps: on
 * 2026-09-16/17 fade went 0/25 and favorite 0/31, and one position in 163 ever reached settlement. The rest
 * (momentum, reversion, breakout, book pressure, maker) are quote-dynamics hypotheses and keep timed exits.
 */
/**
 * Arms STOPPED on their own evidence: they ran, they were measured, and their day-clustered band cleared the
 * lab's own promotion bar with the sign reversed. Unlike IBKR_UNAVAILABLE these keep their id, their ledger and
 * their cash - the evidence that justified the stop stays on the panel. Only new admission is refused.
 */
export const IBKR_RETIRED:ReadonlyMap<string,string>=new Map([
  ['microprice','Stopped 2026-09-20 (section 143): 47 closed, 18 events, 4 day-clusters, -6.23c/contract, band [-8.57,-3.90]. The lab\'s own promotion bar, met with the sign reversed. The handicap is the taker entry, not the signal: gross was -5.15c crossing out and -5.18c settling.'],
  ['book-imbalance','Stopped 2026-09-20 (section 143): 51 closed, 15 events, 4 day-clusters, -6.18c/contract, band [-9.73,-2.62]. Same bar, same sign, same cause. A passive re-seat is a different hypothesis and needs its own pre-registration.']
])
export const IBKR_HOLD_TO_SETTLEMENT:ReadonlySet<string>=new Set(['fade','favorite','calibration','political-favorite','fade-maker','ladder-value','spot-first','convergence','news','market-conditioned','weather-forecast','weather-morning','weather-maker','benchmark'])
/** A held position must be able to settle inside the test; the election contracts expire about 47 days out. Also
 *  bounds which contracts the daily model-forecast budget may be spent on (ibkrLab.runForecast). */
export const IBKR_HOLD_MAX_DAYS=60
export interface LabFrame {market:IbkrLabMarket;yes:IbkrQuote;no:IbkrQuote;history:{at:number;p:number}[];forecast?:{at:number;p:number};spot?:{price:number;annualVol:number;at:number};weather?:{p:number;morning:boolean;at:number}}
export interface LabSignal {strategy:string;marketId:string;outcome:'YES'|'NO';limit:number;maker:boolean;reason:string;basket?:string}
const logit=(p:number)=>Math.log(p/(1-p)),clamp=(p:number)=>Math.max(.001,Math.min(.999,p))
/**
 * Log-odds calibration slope by ForecastEx category, from docs/reports/backtest-calibration-slopes-2026-09-14.md
 * (Becker Kalshi data, EVALUATION half, all horizons). Politics 1.150 [1.115, 1.175] is the only group whose band
 * excludes 1.0; Finance 1.005, Crypto 1.011, Weather 1.008, Science/Tech 1.153 [0.981, 1.195] and Other 1.023 are
 * calibrated within band, so they get 1.0 and produce no recalibration entry. Round 121 replaced the single 1.15
 * that had been applied to every category.
 */
export const CALIBRATION_SLOPE:Record<string,number>={Elections:1.15,Government:1.15}
export const calibrationSlope=(category:string)=>CALIBRATION_SLOPE[category]??1
export const freshAsk=(q:IbkrQuote,now:number)=>q.dataType==='live'&&!q.error&&q.ask!==undefined&&q.ask>=.01&&q.ask<=.99&&Number.isFinite(q.askSize)&&q.askSize!>=1&&now-(q.askAt??0)<=30000&&now-(q.askAt??0)>=0
export function frameMid(f:LabFrame):number {return (f.yes.ask!+1-f.no.ask!)/2}
export function cryptoFair(spot:number,strike:number,annualVol:number,years:number):number {
  if(!(spot>0&&strike>0&&annualVol>0&&years>0))return NaN
  const z=(Math.log(spot/strike)-.5*annualVol*annualVol*years)/(annualVol*Math.sqrt(years))
  const t=1/(1+.2316419*Math.abs(z)),d=.3989422804*Math.exp(-z*z/2)
  const p=1-d*t*(.319381530+t*(-.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))))
  return z>=0?p:1-p
}
export function ibkrSignals(frames:LabFrame[],now:number):LabSignal[] {
  const out:LabSignal[]=[],valid=frames.filter(f=>freshAsk(f.yes,now)&&freshAsk(f.no,now)&&f.market.closeTime>now+60000)
  const add=(f:LabFrame,strategy:string,outcome:'YES'|'NO',reason:string,maker=false,basket?:string)=>{
    const hold=IBKR_HOLD_TO_SETTLEMENT.has(strategy)
    if(hold&&f.market.expiresAt-now>IBKR_HOLD_MAX_DAYS*86400000)return
    const ask=(outcome==='YES'?f.yes:f.no).ask!
    // Passive limits rest 2c inside the ask: 3c plus the one-tick trade-through needed a 4c fall inside the order's life.
    const limit=Math.round(Math.min(.99,Math.max(.01,ask+(maker?-.02:.01)))*100)/100
    if(!maker&&limit+.01>=1)return
    const opposite=(outcome==='YES'?f.no:f.yes).ask!
    // Round-trip admission applies only to positions that will be exited through the opposing ask.
    if(!basket&&!hold&&limit+opposite+.03-1>=.08-1e-8)return
    out.push({strategy,marketId:f.market.id,outcome,limit,maker,reason,basket})
  }
  for(const f of valid){
    const p=frameMid(f),spread=f.yes.ask!+f.no.ask!-1,hours=(f.market.closeTime-now)/3600000
    const favorite=p>.5?'YES':'NO',favCost=(favorite==='YES'?f.yes:f.no).ask!
    if(Math.min(p,1-p)>=.03&&Math.min(p,1-p)<=.12&&favCost<=.96){add(f,'fade',favorite,'Favorite-longshot hypothesis');add(f,'fade-maker',favorite,'Passive favorite-longshot hypothesis',true)}
    if(Math.max(p,1-p)>=.75&&Math.max(p,1-p)<=.92&&favCost<=.94)add(f,'favorite',favorite,'Favorite continuation')
    const fair=1/(1+Math.exp(-calibrationSlope(f.market.category)*logit(clamp(p))))
    const politicalFair=1/(1+Math.exp(-1.15*logit(clamp(p))))
    const edge=(id:string,estimate:number,minimum=.03)=>{
      if(estimate-f.yes.ask!-.02>=minimum)add(f,id,'YES',`Estimated P(YES) ${(estimate*100).toFixed(1)}%`)
      if(1-estimate-f.no.ask!-.02>=minimum)add(f,id,'NO',`Estimated P(YES) ${(estimate*100).toFixed(1)}%`)
    }
    edge('calibration',fair,-.015)
    if(/Election|Government/i.test(f.market.category))edge('political-favorite',politicalFair,-.015)
    const h=f.history.filter(h=>h.at>=now-20*60000&&h.at<now-60000)
    const anchor=h.find(h=>h.at<=now-10*60000)
    if(anchor&&h.length>=3&&spread<=.08){
      const move=p-anchor.p
      if(Math.abs(move)>=.04)add(f,'momentum',move>0?'YES':'NO','Ten-minute quote drift')
      if(Math.abs(logit(clamp(p))-logit(clamp(anchor.p)))>=.35)add(f,'log-momentum',move>0?'YES':'NO','Ten-minute log-odds drift')
      if(Math.abs(move)>=.08&&hours>=2&&p>.15&&p<.85)add(f,'mean-reversion',move>0?'NO':'YES','Fade ten-minute quote excursion')
      if(p>Math.max(...h.map(x=>x.p))+.03)add(f,'breakout','YES','Upward range breakout')
      if(p<Math.min(...h.map(x=>x.p))-.03)add(f,'breakout','NO','Downward range breakout')
    }
    const yesSize=f.yes.askSize!,noSize=f.no.askSize!,ratio=noSize/(yesSize+noSize)
    if(spread<=.06&&Math.min(yesSize,noSize)>=2&&p>.1&&p<.9){
      if(ratio>=.8||ratio<=.2)add(f,'book-imbalance',ratio>.5?'YES':'NO','Paired executable depth imbalance')
      const micro=((1-f.no.ask!)*yesSize+f.yes.ask!*noSize)/(yesSize+noSize)
      if(Math.abs(micro-p)>=.005)add(f,'microprice',micro>p?'YES':'NO','Depth-weighted quote pressure hypothesis')
    }
    if(spread>=.04&&spread<=.15&&p>.1&&p<.9){add(f,'maker','YES','Two-sided passive quote',true);add(f,'maker','NO','Two-sided passive quote',true)}
    if(f.spot&&now-f.spot.at<=30000&&f.market.direction&&/^CF(BTC|ETH|SOL|XRP)$/.test(f.market.product)){
      let fair=cryptoFair(f.spot.price,f.market.strike,f.spot.annualVol,(f.market.closeTime-now)/(365.25*86400000))
      if(f.market.direction==='below')fair=1-fair
      if(hours>=.1&&hours<=24)edge('spot-first',fair,.05)
      if(hours*60>=2&&hours*60<=6)edge('convergence',fair,.04)
    }
    if(f.forecast&&now-f.forecast.at<6*3600000){edge('news',f.forecast.p,.05);edge('market-conditioned',.7*p+.3*f.forecast.p,.02)}
    if(f.weather&&now-f.weather.at<30*60000){
      edge('weather-forecast',f.weather.p,.07)
      if(f.weather.morning)edge('weather-morning',f.weather.p,.07)
      for(const outcome of ['YES','NO'] as const){const fair=outcome==='YES'?f.weather.p:1-f.weather.p,ask=(outcome==='YES'?f.yes:f.no).ask!;if(fair-(ask-.02)-.01>=.07)add(f,'weather-maker',outcome,'Station forecast with settlement-basis margin',true)}
    }
    const hash=[...f.market.id].reduce((a,c)=>a+c.charCodeAt(0),0)
    if(spread<=.08)add(f,'benchmark',hash%2?'YES':'NO','Predefined friction control; not an edge claim')
  }
  for(const f of valid){
    if(!f.market.direction)continue
    const peers=valid.filter(g=>g.market.product===f.market.product&&g.market.id.split('_').slice(0,-1).join('_')===f.market.id.split('_').slice(0,-1).join('_')&&g.market.direction===f.market.direction).sort((a,b)=>a.market.strike-b.market.strike)
    const i=peers.indexOf(f)
    if(i>0&&i<peers.length-1){const left=peers[i-1],right=peers[i+1],fraction=(f.market.strike-left.market.strike)/(right.market.strike-left.market.strike),fair=frameMid(left)+(frameMid(right)-frameMid(left))*fraction
      if(fair-f.yes.ask!>.05)add(f,'ladder-value','YES','Neighbor-strike interpolation')
      if(1-fair-f.no.ask!>.05)add(f,'ladder-value','NO','Neighbor-strike interpolation')
    }
  }
  return out
}
