import {FORECAST_URL,fetchForecast,parseForecast,parseForecastCache,forecastInline,forecastDetails} from "../forecast.ts";
import {buildQuotaPresentation,frameRemaining,calculateTiboNotifications,parseTiboAlertMarkers,parseUpdatePreferences} from "../codex-remaining.ts";
import {parseSecondaryTimeline,parseTiboPayload,tiboInline,type TiboSummary} from "../tibo.ts";
const assert=(v:unknown,msg:string)=>{if(!v)throw Error(msg)};
const now=Date.parse("2026-10-11T00:00:00Z");
const example={mode:"model",updated_at:new Date(now).toISOString(),probabilities:{rounded_24h:20,rounded_48h:35},
 confidence:"low",confidence_note:"Experimental: backtest not calibrated",last_reset_at:"2026-10-07T03:35:09Z"};
const good=parseForecast(example,now);
assert(good.status==="estimated" && good.data.p24===20 && good.data.p48===35,"parse real 24/48 API schema");
assert(forecastInline(good,now)==="Forecast: 24h 20% · 48h 35% · low","compact formatting exact");
assert(forecastDetails(good).includes(FORECAST_URL),"details cite single forecast source");
assert(!forecastInline(good,now).includes("7d"),"never invent seven-day forecast");
const stale=parseForecast({...example,updated_at:new Date(now-61*60_000).toISOString()},now);
assert(stale.status==="stale" && forecastInline(stale,now).includes("(stale)"),"old API response labeled stale");
assert(parseForecast({...example,mode:"disabled"},now).status==="no_forecast","no forecast != network outage");
assert(parseForecast({...example,probabilities:{}},now).status==="no_forecast","absent probability != 0%");
assert(parseForecast({...example,probabilities:{rounded_24h:140}},now).status==="no_forecast","reject outside bounds");
assert(parseForecast(undefined,now).status==="unavailable","malformed data unavailable");
assert(forecastInline({status:"loading"}).includes("loading"),"loading state");
assert(forecastInline({status:"unavailable"}).includes("unavailable"),"offline state");
assert(forecastInline({status:"no_forecast"}).includes("no forecast"),"no prediction state");
assert(parseForecastCache(good.data)?.p48===35,"cache valid");
assert(parseForecastCache({source:"https://untrusted.site",mode:"model",p24:50,updatedAt:now,fetchedAt:now})===undefined,"cache source pinned");
const prefs=parseUpdatePreferences({});
assert(prefs.tiboAlerts && prefs.tiboEnabled && prefs.forecastEnabled && prefs.quotaAlerts && prefs.updateChecks,
  "all independent optional features default ON");
assert(parseUpdatePreferences({tiboEnabled:false,tiboAlerts:false,forecastEnabled:false}).forecastEnabled===false,
  "explicit user OFF respected");
assert(parseUpdatePreferences({forecastCached:good.data}).forecastCached?.p24===20,"forecast cache persisted");
const line=buildQuotaPresentation({lastSuccessAt:0,lastAttemptFailed:false,nextAttempt:0},"bars",x=>x,x=>x,x=>x,
  now,"Tibo: Reset 7 Oct · Banked 8 Oct",forecastInline(good,now)).line!;
assert(line.includes("│  Forecast: 24h 20% · 48h 35% · low") && line.indexOf("Tibo:")<line.indexOf("Forecast:"),
  "forecast after distinct Tibo separator");
assert(!buildQuotaPresentation({lastSuccessAt:0,lastAttemptFailed:false,nextAttempt:0},"bars",x=>x,x=>x,x=>x,now,"Tibo: Reset 7 Oct").line?.includes("Forecast"),
  "hide forecast without hiding Tibo");
for(const width of [45,60,85,140]) {
  const rows=frameRemaining(line,x=>x,width);
  assert(rows.every(s=>Bun.stringWidth(s)<=width),"wrapped widget must fit "+width);
  assert(rows.some(s=>s.includes("Forecast:")),"forecast remains visible on "+width+" columns");
}
const planned= await fetchForecast((async(url:string,opts?:any)=>{
 assert(url===FORECAST_URL,"single forecast endpoint only");
 assert(opts?.signal instanceof AbortSignal,"request has timeout");
 return Response.json(example);
}) as typeof fetch,now);
assert(planned.status==="estimated","fetch forecast works");
let calls=0;
const absent=await fetchForecast((async()=>{calls++;throw Error("offline")}) as typeof fetch,now);
assert(absent.status==="unavailable" && calls===1,"no fallback when API fails");
console.log("PASS single-source 24h/48h forecast, stale/offline/no forecast, all-on defaults and ordering");

const e=(type:"regular"|"banked",date:string)=>({type,announcedAt:date,url:"https://x.com/thsottiaux/status/123"});
const fresh:TiboSummary={regular:e("regular","2026-10-07T03:35:09Z"),banked:e("banked","2026-10-08T03:44:55Z"),
 fetchedAt:now,stale:false,source:"codex-resets.com"};
const baseline=calculateTiboNotifications({},fresh);
assert(baseline.announcements.length===0 && baseline.next.regular && baseline.next.banked,
  "first install establishes baseline without retrospective notifications");
const repeat=calculateTiboNotifications(baseline.next,fresh);
assert(repeat.announcements.length===0,"same event never notifies twice");
const newer={...fresh,banked:e("banked","2026-10-11T03:44:55Z")};
const changed=calculateTiboNotifications(baseline.next,newer);
assert(changed.announcements.length===1 && changed.announcements[0]!.includes("banked"),"new banked only once");
assert(calculateTiboNotifications(changed.next,newer).announcements.length===0,"persistent dedupe");
assert(calculateTiboNotifications(changed.next,{...fresh,stale:true}).announcements.length===0,
  "stale data cannot notify");
assert(parseTiboAlertMarkers({regular:"bad",banked:changed.next.banked}).banked===changed.next.banked,
  "persist valid markers only");
const timeline={updated_at:new Date(now).toISOString(),events:[
 {group:"reset",announcement_state:"none",confirmed:false,announced_at:"2026-10-10T00:00:00Z"},
 {group:"reset",announcement_state:"announced",confirmed:true,announced_at:"2026-10-07T03:35:09Z",summary:"reset",url:"https://x.com/thsottiaux/status/22"},
 {group:"credits",reset_kind:"banked",confirmed:true,announced_at:"2026-10-07T23:24:55Z",summary:"credits"},
]};
const parsed=parseSecondaryTimeline(timeline,now);
assert(parsed?.regular?.announcedAt.startsWith("2026-10-07") && parsed.banked && parsed.source==="codex-reset.com",
 "secondary confirmed-only and banked credits");
assert(parseSecondaryTimeline({...timeline,updated_at:"2026-09-01T00:00:00Z"},now)?.stale===true,
 "secondary freshness respected");
console.log("PASS reset notifications default ON, baseline/dedup, confirmed-only fallback, stale safety");
