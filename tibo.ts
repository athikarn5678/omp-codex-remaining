/**
 * Read-only community reset announcements from TIBO (tibo.cc).
 * Public community records are NOT per-account quota or official delivery proof.
 * No Codex access token or local usage is sent to this endpoint.
 */
export const TIBO_REFRESH_MS = 20 * 60_000;
export type TiboKind = "regular" | "banked";
export type TiboEvent = { type: TiboKind; announcedAt: string; url?: string; text?: string };
export type TiboSummary = {
  regular?: TiboEvent;
  banked?: TiboEvent;
  scheduled?: { type: TiboKind; scheduledFor: string; url?: string };
  fetchedAt: number;
  stale: boolean;
};
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function date(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const time=Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
function event(value: unknown): TiboEvent | undefined {
  const record=object(value);if(!record)return;
  const type=record.reset_type;
  const announcedAt=date(record.announced_at);
  if ((type!=="regular"&&type!=="banked")||!announcedAt) return;
  const src=object(record.source);
  const url=src?.url;
  return {
    type,announcedAt,
    ...(typeof url==="string" && /^https:\/\/(x\.com|twitter\.com)\//.test(url) ? {url} : {}),
    ...(typeof record.text==="string" ? {text:record.text.slice(0,500)} : {}),
  };
}
export function parseTiboPayload(status: unknown, history: unknown, now=Date.now()): TiboSummary | undefined {
  const s=object(status), h=object(history);
  if(!s || !h) return;
  const data=object(s.data);
  const records=Array.isArray(h.data) ? h.data : [];
  const events=records.map(event).filter((e):e is TiboEvent=>!!e);
  const latest=event(data?.latest_reset);
  if(latest && !events.some(e=>e.type===latest.type && e.announcedAt===latest.announcedAt)) events.push(latest);
  const choose=(kind:TiboKind)=>events.filter(e=>e.type===kind).sort((a,b)=>Date.parse(b.announcedAt)-Date.parse(a.announcedAt))[0];
  const upcoming=object(data?.scheduled_reset);
  const scheduledType=upcoming?.reset_type;
  const scheduledDate=date(upcoming?.scheduled_for);
  const scheduledSource=object(upcoming?.source)?.url;
  const scheduled=scheduledDate && Date.parse(scheduledDate)>now && !s.stale &&
    (scheduledType==="regular"||scheduledType==="banked")
    ? {type:scheduledType as TiboKind,scheduledFor:scheduledDate,
      ...(typeof scheduledSource==="string" && /^https:\/\/(x\.com|twitter\.com)\//.test(scheduledSource) ? {url:scheduledSource} : {})}
    : undefined;
  if(!choose("regular")&&!choose("banked")&&!scheduled) return;
  return {
    regular:choose("regular"),banked:choose("banked"),scheduled,
    fetchedAt:now,stale:s.stale===true || h.stale===true,
  };
}
const day=(iso:string)=>new Intl.DateTimeFormat("en-GB",{day:"numeric",month:"short",timeZone:"Asia/Bangkok"}).format(Date.parse(iso));
/** Keep the community information visibly separate from account credits. */
export function tiboInline(summary: TiboSummary|undefined, loading=false, now=Date.now()): string {
  if (!summary) return loading ? "Tibo: checking…" : "Tibo: unavailable";
  const parts:string[]=[];
  if (summary.regular) parts.push("Reset "+day(summary.regular.announcedAt));
  if (summary.banked) parts.push("Banked "+day(summary.banked.announcedAt));
  const stale=summary.stale || now-summary.fetchedAt>TIBO_REFRESH_MS*2;
  if (summary.scheduled && !stale && Date.parse(summary.scheduled.scheduledFor)>now)
    parts.push("Next "+summary.scheduled.type+" by "+day(summary.scheduled.scheduledFor));
  return "Tibo: "+parts.join(" · ")+(stale ? " (stale)" : "");
}
export async function fetchTiboSummary(
  request: typeof fetch = fetch,
  now=Date.now(),
): Promise<TiboSummary | undefined> {
  const controller=AbortSignal.timeout(6_000);
  const opts={headers:{Accept:"application/json"},signal:controller};
  const [status,history]=await Promise.all([
    request("https://tibo.cc/api/v1/status",opts),
    request("https://tibo.cc/api/v1/resets?limit=20",opts),
  ]);
  if(!status.ok||!history.ok) return;
  return parseTiboPayload(await status.json(),await history.json(),now);
}
export function parseTiboCache(value:unknown): TiboSummary|undefined {
  const r=object(value);
  if(!r || typeof r.fetchedAt!=="number" || !Number.isFinite(r.fetchedAt) || r.fetchedAt<=0) return;
  const regular=event(r.regular && {...object(r.regular),reset_type:object(r.regular)?.type,announced_at:object(r.regular)?.announcedAt,source:{url:object(r.regular)?.url}});
  const banked=event(r.banked && {...object(r.banked),reset_type:object(r.banked)?.type,announced_at:object(r.banked)?.announcedAt,source:{url:object(r.banked)?.url}});
  if(!regular&&!banked)return;
  const schedule=object(r.scheduled);
  const scheduledType=schedule?.type;
  const scheduledDate=date(schedule?.scheduledFor);
  const scheduled=scheduledDate && Date.parse(scheduledDate)>Date.now() && !r.stale &&
    (scheduledType==="regular"||scheduledType==="banked")
    ? {type:scheduledType as TiboKind,scheduledFor:scheduledDate} : undefined;
  return {fetchedAt:r.fetchedAt,stale:r.stale===true,regular,banked,scheduled};
}
