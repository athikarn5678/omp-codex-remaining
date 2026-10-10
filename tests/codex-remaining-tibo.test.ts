import { fetchTiboSummary, parseTiboCache, parseTiboPayload, tiboInline } from "../tibo.ts";
import { createQuotaPoller, parseQuotaSnapshot, parseUpdatePreferences, buildQuotaPresentation } from "../codex-remaining.ts";
const assert=(condition:unknown, message:string)=>{if(!condition) throw Error(message);};
const now=Date.parse("2026-10-11T00:00:00Z");
const event=(type:string,announced_at:string)=>({id:"test",reset_type:type,announced_at,text:"Tibo public announcement",
  source:{url:"https://x.com/thsottiaux/status/1234"}});
const status={data:{latest_reset:event("banked","2026-10-08T03:44:55Z"),
  scheduled_reset:{...event("regular","2026-10-09T00:00:00Z"),scheduled_for:"2026-10-12T00:00:00Z"}},
  stale:false};
const history={data:[event("banked","2026-10-08T03:44:55Z"),
  event("regular","2026-10-07T03:35:09Z"),event("regular","2026-10-02T21:18:48Z")],stale:false};
const parsed=parseTiboPayload(status,history,now);
assert(parsed?.regular?.announcedAt==="2026-10-07T03:35:09.000Z","latest regular");
assert(parsed?.banked?.announcedAt==="2026-10-08T03:44:55.000Z","latest banked");
assert(parsed?.scheduled?.type==="regular","known future schedule");
const inline=tiboInline(parsed,false,now);
assert(inline.includes("Reset 7 Oct") && inline.includes("Banked 8 Oct"),"both reset categories visible");
assert(inline.includes("Next regular by 12 Oct"),"scheduled deadline labeled by, not guaranteed arrival");
assert(!inline.includes("stale"),"fresh data");
const old=parseTiboPayload({...status,stale:true},history,now);
assert(tiboInline(old,false,now).includes("(stale)"),"stale explicitly labeled");
assert(!old?.scheduled,"stale scheduled announcement must not appear as upcoming");
assert(tiboInline(parsed,false,now+3*60*60_000).includes("stale"),"expired local cache labeled");
assert(tiboInline(undefined,true,now).includes("checking"),"loading placeholder");
assert(tiboInline(undefined,false,now).includes("unavailable"),"network absence isn't fake no resets");
const restored=parseTiboCache(parsed);
assert(restored?.banked?.announcedAt===parsed?.banked?.announcedAt,"banked status can restore from disk");
assert(restored?.regular?.url===parsed?.regular?.url,"source URL preserved");
assert(parseTiboPayload({data:{latest_reset:null},stale:false},{data:[]},now)===undefined,"empty data is unavailable");
assert(parseTiboPayload({data:{latest_reset:event("banked","broken")}},history,now)?.banked!==undefined,"invalid timestamp safely ignored");
console.log("PASS Tibo regular/banked, scheduled deadline, stale, unavailable, cache, source URL");
let requestCount=0;
const response=async(url:string,options?:any)=>{
 requestCount++;
 assert(url.startsWith("https://tibo.cc/api/v1/"),"only Tibo public endpoints used");
 assert(options?.signal instanceof AbortSignal,"network timeout");
 return Response.json(url.includes("status") ? status: history);
};
const fetched=await fetchTiboSummary(response as typeof fetch,now);
assert(requestCount===2 && fetched?.regular?.type==="regular","parallel read-only endpoints");
assert(await fetchTiboSummary((async()=>new Response("bad",{status:503})) as typeof fetch,now)===undefined,"HTTP errors handled without fake data");
console.log("PASS live-request contract and errors");

const quota={provider:"openai-codex",metadata:{planType:"plus"},limits:[
  {scope:{windowId:"5h"},amount:{remainingFraction:0.5},window:{resetsAt:now+3600_000}},
  {scope:{windowId:"7d"},amount:{remainingFraction:0.7},window:{resetsAt:now+7*86400_000}}],
  resetCredits:{availableCount:3,credits:[{status:"available",expiresAt:"2026-10-23T00:00:00Z"}]},
};
const snapshot=parseQuotaSnapshot(quota);
assert(snapshot?.resetCredits?.availableCount===3,"cache preserves credits");
const prefs=parseUpdatePreferences({mode:"bars",tiboCached:parsed,tiboEnabled:true,lastQuotaReport:snapshot,lastQuotaSuccessAt:now});
assert(prefs.lastQuotaReport?.limits?.length===2 && !!prefs.tiboCached,"old session restores both caches");
const poller=createQuotaPoller(async()=>quota,()=>now);
poller.seedCached(prefs.lastQuotaReport!,prefs.lastQuotaSuccessAt);
const state=poller.getState();
assert(state.report && state.lastAttemptFailed,"persisted quota is intentionally labeled stale");
let viewed=buildQuotaPresentation(state,"bars",x=>x,x=>x,x=>x,now,tiboInline(parsed,false,now));
assert(viewed.line?.includes("Plus") && viewed.line.includes("✦ 3") && viewed.line.indexOf("│  Tibo:")>viewed.line.indexOf("✦ 3"),
 "Tibo after plan/credits with visible separator");
assert(viewed.line?.includes("stale quota"),"restored snapshot is not disguised as live quota");
viewed=buildQuotaPresentation(state,"compact",x=>x,x=>x,x=>x,now,undefined);
assert(!viewed.line?.includes("Tibo"),"toggle hides community data without hiding Codex");
assert(parseQuotaSnapshot({provider:"openai-codex",limits:[]})===undefined,"invalid cache rejected");
console.log("PASS instant stale quota cache and separated opt-in Tibo placement");
