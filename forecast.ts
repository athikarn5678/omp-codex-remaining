/**
 * Independent forecast from codex-reset.com only.
 * No blending, no fallback to another forecasting model.
 * A community prediction is NEVER a confirmed / scheduled reset.
 */
export const FORECAST_URL = "https://codex-reset.com/api/forecast";
export const FORECAST_REFRESH_MS = 20 * 60_000;
export const FORECAST_MAX_AGE_MS = 40 * 60_000;
export type ForecastData = {
  source: typeof FORECAST_URL;
  updatedAt: number;
  fetchedAt: number;
  p24?: number;
  p48?: number;
  confidence: string;
  mode: string;
  lastResetAt?: string;
  note?: string;
};
export type ForecastState =
  | { status: "loading" | "unavailable" | "no_forecast" }
  | { status: "estimated" | "stale"; data: ForecastData };
const object = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
function probability(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100
    ? Math.round(v) : undefined;
}
export function parseForecast(payload: unknown, now = Date.now()): ForecastState {
  const root = object(payload);
  if (!root) return { status: "unavailable" };
  const p = object(root.probabilities);
  const p24 = probability(p?.rounded_24h ?? p?.model_24h);
  const p48 = probability(p?.rounded_48h ?? p?.model_48h);
  const mode = typeof root.mode === "string" ? root.mode : "unknown";
  if (mode !== "model" || (p24 === undefined && p48 === undefined)) return { status: "no_forecast" };
  const updatedAt = typeof root.updated_at === "string" ? Date.parse(root.updated_at) : NaN;
  if (!Number.isFinite(updatedAt) || updatedAt > now + 5 * 60_000) return { status: "unavailable" };
  const confidence = typeof root.confidence === "string" ? root.confidence.slice(0, 30) : "unknown";
  const data: ForecastData = {
    source: FORECAST_URL, updatedAt, fetchedAt: now, p24, p48, confidence, mode,
    ...(typeof root.last_reset_at === "string" && Number.isFinite(Date.parse(root.last_reset_at))
      ? { lastResetAt: root.last_reset_at } : {}),
    ...(typeof root.confidence_note === "string" ? { note: root.confidence_note.slice(0, 200) } : {}),
  };
  return { status: now - updatedAt > FORECAST_MAX_AGE_MS ? "stale" : "estimated", data };
}
export function parseForecastCache(raw: unknown): ForecastData | undefined {
  const r = object(raw);
  if (!r || r.source !== FORECAST_URL || r.mode !== "model" ||
      typeof r.updatedAt !== "number" || !Number.isFinite(r.updatedAt) ||
      typeof r.fetchedAt !== "number" || !Number.isFinite(r.fetchedAt)) return;
  const p24 = probability(r.p24), p48 = probability(r.p48);
  if (p24 === undefined && p48 === undefined) return;
  return {
    source: FORECAST_URL, mode: "model", updatedAt:r.updatedAt, fetchedAt:r.fetchedAt,
    p24, p48,
    confidence: typeof r.confidence === "string" ? r.confidence.slice(0,30) : "unknown",
    ...(typeof r.lastResetAt === "string" ? { lastResetAt: r.lastResetAt } : {}),
    ...(typeof r.note === "string" ? { note: r.note.slice(0,200) } : {}),
  };
}
export function forecastInline(state: ForecastState, now = Date.now()): string {
  if (state.status === "loading") return "Forecast: loading…";
  if (state.status === "unavailable") return "Forecast: unavailable";
  if (state.status === "no_forecast") return "Forecast: no forecast";
  const parts = [
    state.data.p24 !== undefined ? "24h " + state.data.p24 + "%" : undefined,
    state.data.p48 !== undefined ? "48h " + state.data.p48 + "%" : undefined,
    state.data.confidence,
  ].filter(Boolean);
  const stale = state.status === "stale" || now - state.data.updatedAt > FORECAST_MAX_AGE_MS;
  return "Forecast: " + parts.join(" · ") + (stale ? " (stale)" : "");
}
export function forecastDetails(state: ForecastState, now = Date.now()): string {
  if (state.status === "unavailable" || state.status === "loading" || state.status === "no_forecast")
    return forecastInline(state, now) + " · Source: " + FORECAST_URL;
  return [
    forecastInline(state, now),
    "Updated: " + new Date(state.data.updatedAt).toLocaleString("en-GB", { timeZone:"Asia/Bangkok", hour12:false }) + " (Bangkok)",
    "Source: " + FORECAST_URL,
    "Experimental community prediction, not a guaranteed reset.",
    ...(state.data.note ? [state.data.note] : []),
  ].join(" · ");
}
export async function fetchForecast(request: typeof fetch = fetch, now = Date.now()): Promise<ForecastState> {
  try {
    const response = await request(FORECAST_URL,{
      headers: { Accept:"application/json", "User-Agent":"omp-codex-remaining (+https://github.com/athikarn5678/omp-codex-remaining)" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return { status: "unavailable" };
    return parseForecast(await response.json(), now);
  } catch {
    return { status: "unavailable" };
  }
}
