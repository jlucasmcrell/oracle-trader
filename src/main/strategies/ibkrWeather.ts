import type {IbkrLabMarket} from '../../shared/ibkrLab'
import {fetchHourlyForecast,forecastSigma,remainingExtremes,normalCdf,STATION_COORDS} from './weatherForecast'
import {localDate,stationTimeZone} from './weatherDay'
const cache=new Map<string,{at:number;pending:Promise<{mu:number;morning:boolean;hours:number}|undefined>}>()
/** ForecastEx's WU settlement differs from NWS. This is a forecast with a wide error band, never a locked outcome. */
export async function ibkrWeather(m:IbkrLabMarket,now:number):Promise<{p:number;morning:boolean;at:number}|undefined>{
  const match=/^U([HL])([A-Z]{3})_(\d{2})(\d{2})(\d{2})_/.exec(m.id)
  if(!match||!m.rulesUrl.endsWith('/DailyTemperatureTermsandConditions.pdf')||!m.question.includes(`(K${match[2]})`)||m.direction!=='above')return
  const [,kind,airport,month,date,year]=match,station=({DCA:'DC',MDW:'CHI',SAT:'SATX',MSY:'NOLA'} as Record<string,string>)[airport]??airport
  if(!STATION_COORDS[station])return
  const tz=stationTimeZone(`KXHIGHT${station}`),eventDate=`20${year}-${month}-${date}`
  if(!tz)return
  const key=`${kind}:${station}:${eventDate}`,old=cache.get(key)
  let data:typeof old
  if(old&&now-old.at<10*60000)data=old
  else{
    const pending=(async()=>{
      const forecast=await fetchHourlyForecast(station,now)
      if(!forecast||now-forecast.updatedAt>6*3600000)return
      const ext=remainingExtremes(forecast,eventDate,tz,now)
      if(!ext)return
      const temperatures:number[]=[]
      if(localDate(now,tz)===eventDate){
        const url=`https://api.weather.gov/stations/K${airport}/observations?start=${encodeURIComponent(new Date(now-36*3600000).toISOString())}&limit=500`
        const r=await fetch(url,{headers:{'User-Agent':'oracle-trader weather paper research','Accept':'application/geo+json'},signal:AbortSignal.timeout(10000)})
        if(!r.ok)throw new Error(`NWS station observations HTTP ${r.status}`)
        const body=await r.json(),observations=(body.features??[]).map((v:any)=>({at:Date.parse(v.properties?.timestamp),c:v.properties?.temperature?.value})).filter((v:any)=>Number.isFinite(v.at)&&typeof v.c==='number'&&v.at<=now&&localDate(v.at,tz)===eventDate)
        const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'numeric',hourCycle:'h23'}).format(now))
        if(hour>=2&&(!observations.length||now-Math.max(...observations.map((v:any)=>v.at))>90*60000))return
        temperatures.push(...observations.map((v:any)=>v.c*9/5+32))
      }else if(eventDate<localDate(now,tz))return
      const mu=kind==='H'?Math.max(ext.max,...temperatures):Math.min(ext.min,...temperatures)
      const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'numeric',hourCycle:'h23'}).format(now))
      return {mu,morning:eventDate>localDate(now,tz)||hour<10,hours:ext.hours}
    })()
    data={at:now,pending};cache.set(key,data)
  }
  const value=await data.pending
  if(!value)return
  // BACKLOG 241, read 2026-09-29: the flat 3 degrees was the day-out forecast error charged all day, so the model
  // stayed as unsure at 4 PM - with the day's extreme already banked in the observations above - as it was at dawn.
  // The Kalshi weather model has narrowed with the remaining hours since round 30 (`forecastSigma`, 3.0 -> 0.9); the
  // lab now uses the same curve on the same inputs. Sigma is the FORECAST error only: ForecastEx settles on Weather
  // Underground, and that basis is what this arm exists to measure, so it is not padded in here by guesswork.
  const p=1-normalCdf((m.strike+.5-value.mu)/forecastSigma(value.hours))
  return {p:Math.max(.02,Math.min(.98,p)),morning:value.morning,at:data.at}
}
