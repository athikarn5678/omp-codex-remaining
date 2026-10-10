/**
 * Codex Remaining (OMP 18.8.7+) — five-level ANSI color, theme-aware reset timer.
 *
 * The built-in `status` segment sanitizes ANSI and applies one accent to the
 * entire string. Instead use the officially supported, styled single-line widget
 * below the editor. The rest of OMP's native status line remains unchanged.
 *
 * Standalone: no installation into OMP's bundled JavaScript is needed.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AutocompleteProvider } from "@oh-my-pi/pi-tui";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fetchTiboSummary, parseTiboCache, tiboInline, TIBO_REFRESH_MS, type TiboSummary } from "./tibo.ts";
import { fetchForecast, forecastDetails, forecastInline, parseForecastCache, FORECAST_REFRESH_MS, type ForecastData, type ForecastState } from "./forecast.ts";

const WIDGET_KEY = "codex-remaining";
const STATUS_KEY = "codex-remaining"; // clear legacy status from the prior version
const REFRESH_MS = 5 * 60_000;
const TICK_MS = 30_000;
const ANSI_DEFAULT_FG = "\x1b[39m";
export const EXTENSION_VERSION = "0.1.8";
const UPDATE_CHECK_MS = 24 * 60 * 60_000;
const NPM_LATEST_URL = "https://registry.npmjs.org/omp-codex-remaining/latest";
export type DisplayMode = "compact" | "bars";
const SETTINGS_PATH = join(homedir(), ".omp", "agent", "codex-remaining-settings.json");

type Limit = {
  scope?: { windowId?: string };
  window?: { id?: string; resetsAt?: number };
  amount?: { remainingFraction?: number; usedFraction?: number };
};
export type Report = {
  provider?: string;
  limits?: Limit[];
  metadata?: { planType?: string };
  resetCredits?: {
    availableCount?: number;
    credits?: Array<{ status?: string; expiresAt?: string }>;
  };
};
type QuotaWindow = { label: string; pct: number; reset: string; resetAt?: number };

function resetLabel(timestamp: number | undefined, short: boolean, now: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "";
  const mins = Math.max(0, Math.ceil((timestamp - now) / 60_000));
  if (short) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
  }
  const hours = Math.ceil(mins / 60);
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return d ? `${d}d${h ? ` ${h}h` : ""}` : `${h}h`;
}

function quotaWindows(report: Report, now: number): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const kinds = [
    { id: "5h", label: "5h", short: true },
    { id: "1d", label: "1d", short: true },
    { id: "7d", label: "7d", short: false },
    { id: "monthly", label: "mo", short: false },
  ];
  for (const kind of kinds) {
    const limit = report.limits?.find(x => (x.scope?.windowId ?? x.window?.id) === kind.id);
    if (!limit?.amount) continue;
    const frac = limit.amount.remainingFraction ??
      (typeof limit.amount.usedFraction === "number" ? 1 - limit.amount.usedFraction : undefined);
    if (typeof frac !== "number" || !Number.isFinite(frac)) continue;
    windows.push({
      label: kind.label,
      pct: Math.round(Math.max(0, Math.min(1, frac)) * 100),
      reset: resetLabel(limit.window?.resetsAt, kind.short, now),
      resetAt: limit.window?.resetsAt,
    });
  }
  return windows;
}

function resetCreditsText(report: Report, now: number): string | undefined {
  const credits = report.resetCredits;
  if (!credits || typeof credits.availableCount !== "number" || credits.availableCount <= 0) {
    return undefined;
  }
  let text = `✦ ${credits.availableCount}`;
  const expiry = (credits.credits ?? [])
    .filter(x => x.status === "available")
    .map(x => Date.parse(x.expiresAt ?? ""))
    .filter(x => Number.isFinite(x) && x > now);
  if (expiry.length) text += ` exp ${resetLabel(Math.min(...expiry), false, now)}`;
  return text;
}

/** Visible displayed percentage determines its inclusive 5-level threshold. */
export function remainingHex(pct: number): string {
  if (pct <= 20) return "#EF4444"; // red, 0–20
  if (pct <= 40) return "#F97316"; // orange, 21–40
  if (pct <= 60) return "#EAB308"; // yellow, 41–60
  if (pct <= 80) return "#84CC16"; // light green, 61–80
  return "#22C55E";               // green, 81–100
}

function rgbPercent(text: string, pct: number): string {
  const hex = remainingHex(pct);
  const rgb = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
  return `\x1b[38;2;${rgb.join(";")}m${text}${ANSI_DEFAULT_FG}`;
}

/** Plain (uncolored) representation for tests / non-rich surfaces. */
export function formatRemaining(report: Report, now = Date.now()): string | undefined {
  if (report.provider !== "openai-codex") return undefined;
  const parts: string[] = [];
  const tier = report.metadata?.planType?.trim();
  if (tier) parts.push(tier[0]!.toUpperCase() + tier.slice(1));
  for (const window of quotaWindows(report, now)) {
    parts.push(`${window.label} ${window.pct}%${window.reset ? ` (${window.reset})` : ""}`);
  }
  const credits = resetCreditsText(report, now);
  if (credits) parts.push(credits);
  return parts.length ? `⏱ ${parts.join(" · ")}` : undefined;
}

/**
 * Rich single-line text. The full window (label, percent, reset timer) shares
 * one of five RGB colors. Tier uses the theme accent; credits use theme success.
 * Callbacks are evaluated on every update to follow runtime theme changes.
 */
export function formatRemainingColored(
  report: Report,
  accent: (text: string) => string,
  now = Date.now(),
  success: (text: string) => string = accent,
  mode: DisplayMode = "compact",
): string | undefined {
  if (report.provider !== "openai-codex") return undefined;
  const parts: string[] = [];
  const tier = report.metadata?.planType?.trim();
  if (tier) parts.push(accent(tier[0]!.toUpperCase() + tier.slice(1)));
  const windows = quotaWindows(report, now);
  if (mode === "compact") {
    for (const window of windows) {
      const timer = window.reset ? ` (${window.reset})` : "";
      // Compact mode matches the original single-line status.
      parts.push(rgbPercent(`${window.label} ${window.pct}%${timer}`, window.pct));
    }
  } else if (!tier && windows.length > 0) {
    // Bars need a header even when OMP omits the subscription plan.
    parts.push(accent("Codex quotas"));
  }
  const credits = resetCreditsText(report, now);
  if (credits) parts.push(success(credits));
  return parts.length ? `⏱ ${parts.join(" · ")}` : undefined;
}

/**
 * Thin three-row frame for the one-line quota widget.
 * The outline uses the current OMP theme's border color and resizes with the
 * terminal. ANSI escapes and Unicode graphemes are measured as display cells.
 */
function fitAnsi(text: string, maxCells: number): string {
  if (Bun.stringWidth(text) <= maxCells) return text;
  const budget = Math.max(0, maxCells - 1); // save one cell for ellipsis
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const sgr = /\x1b\[[0-9;]*m/g;
  let result = "";
  let used = 0;
  let previous = 0;

  const addPlain = (part: string): boolean => {
    for (const { segment } of segments.segment(part)) {
      const cells = Bun.stringWidth(segment);
      if (used + cells > budget) return false;
      result += segment;
      used += cells;
    }
    return true;
  };

  for (const match of text.matchAll(sgr)) {
    if (!addPlain(text.slice(previous, match.index))) return result + ANSI_DEFAULT_FG + "…";
    result += match[0];
    previous = match.index + match[0].length;
  }
  if (!addPlain(text.slice(previous))) return result + ANSI_DEFAULT_FG + "…";
  return result;
}

export type RemainingProgress = {
  label: string;
  pct: number;
  resetAt?: number;
  reset?: string;
};

export function formatResetDateTime(timestamp: number | undefined): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(timestamp)).replace(",", "");
}

/** Reject invalid settings instead of trusting a user-edited JSON file. */
export function parseDisplayMode(value: unknown): DisplayMode {
  return value === "compact" ? "compact" : "bars";
}

export function frameRemaining(
  coloredLine: string,
  border: (text: string) => string,
  terminalWidth: number,
  progress: readonly RemainingProgress[] = [],
  muted: (text: string) => string = text => text,
): string[] {
  const available = Math.max(0, Math.floor(terminalWidth));
  if (available < 6) return [fitAnsi(coloredLine, available)];

  const maxContentCells = available - 4;
  // Keep the logical order on one line when possible; on narrower terminals,
  // wrap only at the explicit source separators so Forecast isn't truncated
  // just because it follows the real account credits and reset history.
  const sections = Bun.stringWidth(coloredLine) <= maxContentCells
    ? [coloredLine]
    : coloredLine.split("  │  ").map((part, index) => index ? "│ " + part : part);
  const headerRows=sections.map(part => fitAnsi(part, maxContentCells));

  // Both bars always represent the same *remaining* fraction as the figures
  // above. Filled portion = remaining; muted track = used.
  const barRows = progress.map(({ label, pct, resetAt, reset }) => {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    const date = formatResetDateTime(resetAt);
    const resetDetails = date
      ? `  ↻ ${date}${reset ? ` (in ${reset})` : ""}`
      : (reset ? `  ↻ in ${reset}` : "");
    // Reserve room for the calendar date where possible. On narrow terminals,
    // the row is truncated safely rather than overflowing the editor.
    const barWidth = Math.min(24, Math.max(1,
      maxContentCells - 4 - 5 - Bun.stringWidth(resetDetails)
    ));
    const filled = Math.round(barWidth * clamped / 100);
    const colored = rgbPercent(label.padEnd(3) + " " + "█".repeat(filled), clamped);
    const empty = muted("░".repeat(barWidth - filled));
    const percentAndReset = rgbPercent(` ${clamped}%${resetDetails}`, clamped);
    return fitAnsi(colored + empty + percentAndReset, maxContentCells);
  });

  const content = [...headerRows, ...barRows];
  const innerWidth = Math.max(...content.map(row => Bun.stringWidth(row))) + 2;
  const title = "─ Codex Remaining ";
  const topRule = innerWidth >= Bun.stringWidth(title)
    ? title + "─".repeat(innerWidth - Bun.stringWidth(title))
    : "─".repeat(innerWidth);
  return [
    border("╭" + topRule + "╮"),
    ...content.map(row =>
      border("│") + " " + row + " ".repeat(1 + innerWidth - Bun.stringWidth(row) - 2) + border("│")
    ),
    border("╰" + "─".repeat(innerWidth) + "╯"),
  ];
}

/**
 * Locate the OMP executable without assuming Windows, Bun's install prefix,
 * or the current user's profile. Supports PATH installations and executable
 * paths when the CLI itself was launched outside PATH.
 */
export function resolveOmpExecutable(
  which: (name: string) => string | null | undefined = name => Bun.which(name),
  candidates: string[] = [process.execPath, process.argv[0] ?? ""],
): string | undefined {
  const onPath = process.platform === "win32"
    ? (which("omp.exe") ?? which("omp"))
    : (which("omp") ?? which("omp.exe"));
  if (onPath) return onPath;
  return candidates.find(path => ["omp", "omp.exe"].includes(basename(path).toLowerCase()));
}

type OmpCommand = (args: string[]) => Promise<string>;

async function runOmp(args: string[]): Promise<string> {
  const exe = resolveOmpExecutable();
  if (!exe) throw new Error("OMP executable not found. Install OMP and ensure omp is on PATH.");
  const proc = Bun.spawn([exe, ...args], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* Process may have exited while the timer fired. */ }
  }, 30_000);
  try {
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (timedOut) throw new Error("OMP CLI timed out after 30 seconds");
    if (exitCode !== 0) {
      // Do not leak error output that might contain credentials.
      throw new Error(`omp ${args[0] ?? ""} failed (exit ${exitCode})`);
    }
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

export type UsageReconciliation = { ready: boolean; changed: boolean; reason?: string };

/**
 * Read-only check for duplicated native usage. Never rewrite user OMP config:
 * removing its built-in usage could hide quota information for other providers.
 * A custom status line that already includes usage keeps the widget paused
 * until the user explicitly edits their own configuration.
 */
export async function reconcileNativeUsage(command: OmpCommand): Promise<UsageReconciliation> {
  const preset = (await command(["config", "get", "statusLine.preset"])).trim();
  if (preset !== "custom") return { ready: true, changed: false };

  const keys = ["statusLine.leftSegments", "statusLine.rightSegments"] as const;
  const readings = await Promise.all(keys.map(key => command(["config", "get", key])));
  let segments: unknown[];
  try {
    segments = readings.map(raw => JSON.parse(raw) as unknown);
  } catch {
    return { ready: false, changed: false, reason: "Could not read custom status segments. OMP config was not changed." };
  }
  if (!segments.every(value => Array.isArray(value) && value.every(x => typeof x === "string"))) {
    return { ready: false, changed: false, reason: "Unexpected custom status segments. OMP config was not changed." };
  }
  if (segments.some(items => (items as string[]).includes("usage"))) {
    return {
      ready: false,
      changed: false,
      reason: "Custom status line already includes native usage. Codex Remaining is paused; remove that segment manually if you want the widget. OMP config was not changed.",
    };
  }
  return { ready: true, changed: false };
}

async function getReport(): Promise<Report | undefined> {
  const body = await runOmp(["usage", "--provider", "openai-codex", "--json", "--redact"]);
  const parsed = JSON.parse(body) as { reports?: Report[] };
  return parsed.reports?.find(x => x.provider === "openai-codex");
}

export type QuotaPollState = {
  report?: Report;
  lastSuccessAt: number;
  lastAttemptFailed: boolean;
  nextAttempt: number;
};

/** Keep the last good quotas on transient errors, throttle retries, and dedupe concurrent requests. */
export function createQuotaPoller(
  fetchReport: () => Promise<Report | undefined>,
  clock: () => number = Date.now,
) {
  let report: Report | undefined;
  let lastSuccessAt = 0;
  let lastAttemptFailed = false;
  let nextAttempt = 0;
  let pending: Promise<boolean> | undefined;

  return {
    getState(): QuotaPollState {
      return { report, lastSuccessAt, lastAttemptFailed, nextAttempt };
    },
    seedCached(cached: Report, fetchedAt: number): void {
      // Startup may render the saved snapshot instantly, but must fetch a fresh
      // copy without treating this persisted value as current live usage.
      if (report || !cached || cached.provider !== "openai-codex" ||
          quotaWindows(cached, clock()).length === 0) return;
      report = cached;
      lastSuccessAt = fetchedAt;
      lastAttemptFailed = true;
      nextAttempt = 0;
    },
    async refresh(force = false): Promise<boolean> {
      if (pending) return pending;
      if (!force && clock() < nextAttempt) return !lastAttemptFailed && !!report;

      const attempt = (async () => {
        try {
          const latest = await fetchReport();
          // A response with no usable quota is not a successful refresh.
          if (!latest || latest.provider !== "openai-codex" || quotaWindows(latest, clock()).length === 0) {
            throw new Error("No usable Codex quota windows");
          }
          report = latest;
          lastSuccessAt = clock();
          nextAttempt = lastSuccessAt + REFRESH_MS;
          lastAttemptFailed = false;
          return true;
        } catch {
          nextAttempt = clock() + 60_000;
          lastAttemptFailed = true;
          return false;
        }
      })();
      pending = attempt;
      try {
        return await attempt;
      } finally {
        if (pending === attempt) pending = undefined;
      }
    },
  };
}

/** Show failures without confusing old quota values for fresh usage. */
export function quotaAvailabilityNote(state: QuotaPollState, now = Date.now()): string | undefined {
  if (!state.lastAttemptFailed) return undefined;
  if (!state.report) return "⚠ quota unavailable · retrying";
  const ageMinutes = Math.max(1, Math.ceil((now - state.lastSuccessAt) / 60_000));
  const age = ageMinutes < 60
    ? `${ageMinutes}m`
    : `${Math.floor(ageMinutes / 60)}h${ageMinutes % 60 ? ` ${ageMinutes % 60}m` : ""}`;
  return `⚠ stale quota · updated ${age} ago`;
}

export type QuotaAlertLevel = "warning" | "critical";
export type QuotaAlertState = Record<string, { level: QuotaAlertLevel; resetAt?: number }>;
export type UpdatePreferences = {
  mode: DisplayMode;
  updateChecks: boolean;
  lastUpdateCheckAt: number;
  lastNotifiedVersion?: string;
  quotaAlerts: boolean;
  quotaWarningPercent: number;
  lastQuotaAlerts: QuotaAlertState;
  tiboEnabled: boolean;
  tiboAlerts: boolean;
  lastTiboAlertEvents: { regular?: string; banked?: string };
  tiboCached?: TiboSummary;
  forecastEnabled: boolean;
  forecastCached?: ForecastData;
  lastQuotaReport?: Report;
  lastQuotaSuccessAt: number;
};

type Version = { major: number; minor: number; patch: number; prerelease?: string[] };

function parseVersion(text: string): Version | undefined {
  const matched = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!matched) return undefined;
  const nums = matched.slice(1, 4).map(Number);
  if (nums.some(x => !Number.isSafeInteger(x))) return undefined;
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, prerelease: matched[4]?.split(".") };
}

/** Compare SemVer without dependencies; ignore build metadata and compare prereleases correctly. */
export function isNewerVersion(installed: string, latest: string): boolean {
  const a = parseVersion(installed);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return b[key] > a[key];
  }
  if (!a.prerelease) return false; // Stable release outranks any prerelease.
  if (!b.prerelease) return true;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return true;
    if (y === undefined) return false;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x), yNum = /^\d+$/.test(y);
    if (xNum && yNum) return BigInt(y) > BigInt(x);
    if (xNum !== yNum) return !yNum; // Numeric identifiers have lower precedence.
    return y > x;
  }
  return false;
}

/** Validate a compact, local-only quota snapshot before using it in the TUI. */
export function parseQuotaSnapshot(value: unknown): Report | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Report;
  if (input.provider !== "openai-codex" || !Array.isArray(input.limits)) return;
  const limits: Limit[] = [];
  for (const item of input.limits.slice(0, 8)) {
    const id = item?.scope?.windowId ?? item?.window?.id;
    if (!["5h", "1d", "7d", "monthly"].includes(id ?? "")) continue;
    const frac = item?.amount?.remainingFraction;
    const used = item?.amount?.usedFraction;
    if (!(typeof frac === "number" && Number.isFinite(frac)) &&
        !(typeof used === "number" && Number.isFinite(used))) continue;
    const reset = item?.window?.resetsAt;
    limits.push({
      scope: { windowId: id },
      amount: { ...(typeof frac === "number" ? { remainingFraction: frac } : { usedFraction: used }) },
      window: typeof reset === "number" && Number.isFinite(reset) ? { resetsAt: reset } : {},
    });
  }
  if (!limits.length) return;
  const credits = input.resetCredits;
  const creditList = Array.isArray(credits?.credits) ? credits!.credits.slice(0, 30).map(c => ({
    status: c.status === "available" ? "available" : undefined,
    expiresAt: typeof c.expiresAt === "string" ? c.expiresAt : undefined,
  })) : [];
  const count = credits?.availableCount;
  const tier = input.metadata?.planType;
  return {
    provider: "openai-codex", limits,
    ...(typeof tier === "string" ? { metadata: { planType: tier.slice(0, 50) } } : {}),
    ...(typeof count === "number" && Number.isFinite(count) && count >= 0
      ? { resetCredits: { availableCount: count, credits: creditList } } : {}),
  };
}

/** Only announce NEW public events; never replay history on first install. */
export function parseTiboAlertMarkers(input: unknown): {regular?: string; banked?: string} {
  const r=input && typeof input==="object" && !Array.isArray(input) ? input as Record<string,unknown> : {};
  const result: {regular?:string;banked?:string}={};
  for(const kind of ["regular","banked"] as const) {
    const value=r[kind];
    if(typeof value==="string" && Number.isFinite(Date.parse(value))) result[kind]=value;
  }
  return result;
}
export function calculateTiboNotifications(
  previous: {regular?:string;banked?:string},
  fresh: TiboSummary,
): {next:{regular?:string;banked?:string}; announcements:string[]} {
  const next={...previous};
  const announcements:string[]=[];
  if(fresh.stale) return {next,announcements};
  for(const kind of ["regular","banked"] as const) {
    const event=fresh[kind];
    if(!event) continue;
    const timestamp=event.announcedAt;
    if(!Number.isFinite(Date.parse(timestamp))) continue;
    if(!next[kind] || Date.parse(timestamp)>Date.parse(next[kind])) {
      if(next[kind]) announcements.push(
        (kind==="banked"?"New banked reset-credit announcement":"New regular reset announcement")+
        " · "+timestamp.slice(0,10)+(event.url ? " · "+event.url : "")+
        " · community source, not per-account confirmation"
      );
      next[kind]=timestamp;
    }
  }
  return {next,announcements};
}

export function parseUpdatePreferences(input: unknown): UpdatePreferences {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const timestamp = record.lastUpdateCheckAt;
  const version = record.lastNotifiedVersion;
  const warning = record.quotaWarningPercent;
  const savedAlerts = record.lastQuotaAlerts;
  const lastQuotaAlerts: QuotaAlertState = Object.create(null);
  if (savedAlerts && typeof savedAlerts === "object" && !Array.isArray(savedAlerts)) {
    for (const label of ["5h", "7d"]) {
      const item = (savedAlerts as Record<string, unknown>)[label];
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const state = item as Record<string, unknown>;
      if (state.level !== "warning" && state.level !== "critical") continue;
      const resetAt = state.resetAt;
      if (resetAt !== undefined && (typeof resetAt !== "number" || !Number.isFinite(resetAt))) continue;
      lastQuotaAlerts[label] = {
        level: state.level,
        ...(typeof resetAt === "number" ? { resetAt } : {}),
      };
    }
  }
  return {
    mode: parseDisplayMode(record.mode),
    updateChecks: typeof record.updateChecks === "boolean" ? record.updateChecks : true,
    lastUpdateCheckAt: typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0,
    lastNotifiedVersion: typeof version === "string" && parseVersion(version) ? version : undefined,
    quotaAlerts: typeof record.quotaAlerts === "boolean" ? record.quotaAlerts : true,
    quotaWarningPercent: typeof warning === "number" && Number.isInteger(warning) && warning >= 10 && warning <= 90
      ? warning : 20,
    lastQuotaAlerts,
    tiboEnabled: typeof record.tiboEnabled === "boolean" ? record.tiboEnabled : true,
    tiboAlerts: typeof record.tiboAlerts === "boolean" ? record.tiboAlerts : true,
    lastTiboAlertEvents: parseTiboAlertMarkers(record.lastTiboAlertEvents),
    forecastEnabled: typeof record.forecastEnabled === "boolean" ? record.forecastEnabled : true,
    forecastCached: parseForecastCache(record.forecastCached),
    tiboCached: parseTiboCache(record.tiboCached),
    lastQuotaReport: parseQuotaSnapshot(record.lastQuotaReport),
    lastQuotaSuccessAt: typeof record.lastQuotaSuccessAt === "number" &&
      Number.isFinite(record.lastQuotaSuccessAt) && record.lastQuotaSuccessAt > 0
      ? record.lastQuotaSuccessAt : 0,
  };
}

export type QuotaAlertEvent = { window: "5h" | "7d"; pct: number; level: QuotaAlertLevel };

/**
 * Generate at most one warning and one critical alert per window/reset.
 * Recoveries clear the previous level. State is persisted before notification
 * so restarting OMP does not repeat the same low-quota message.
 */
export function evaluateQuotaAlerts(
  report: Report,
  preferences: Pick<UpdatePreferences, "quotaAlerts" | "quotaWarningPercent" | "lastQuotaAlerts">,
  now = Date.now(),
): { events: QuotaAlertEvent[]; next: QuotaAlertState; changed: boolean } {
  const next: QuotaAlertState = { ...preferences.lastQuotaAlerts };
  const events: QuotaAlertEvent[] = [];
  if (!preferences.quotaAlerts || report.provider !== "openai-codex") {
    return { events, next, changed: false };
  }
  let changed = false;
  for (const window of quotaWindows(report, now)) {
    if (window.label !== "5h" && window.label !== "7d") continue;
    const id = window.label;
    const prior = next[id];
    const sameReset = prior?.resetAt === window.resetAt;
    const level: QuotaAlertLevel | undefined = window.pct <= 10
      ? "critical"
      : window.pct <= preferences.quotaWarningPercent ? "warning" : undefined;
    if (!level) {
      if (prior) { delete next[id]; changed = true; }
      continue;
    }
    const shouldNotify = !prior || !sameReset || (level === "critical" && prior.level === "warning");
    if (shouldNotify) {
      next[id] = { level, ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}) };
      events.push({ window: id, pct: window.pct, level });
      changed = true;
    }
  }
  return { events, next, changed };
}

export function formatQuotaAlert(event: QuotaAlertEvent, threshold: number): string {
  return event.level === "critical"
    ? `Codex ${event.window} critically low: ${event.pct}% remaining (10% or less).`
    : `Codex ${event.window} low: ${event.pct}% remaining (warning threshold ${threshold}%).`;
}

/** Persisted timestamps avoid repeated npm checks across OMP restarts. */
export function shouldAutoCheckUpdates(settings: UpdatePreferences, now = Date.now()): boolean {
  return settings.updateChecks
    && settings.lastUpdateCheckAt <= now
    && (settings.lastUpdateCheckAt === 0 || now - settings.lastUpdateCheckAt >= UPDATE_CHECK_MS);
}

/** Only public npm metadata is requested. No user tokens or model usage are transmitted. */
export async function fetchLatestNpmVersion(request: typeof fetch = fetch): Promise<string | undefined> {
  const response = await request(NPM_LATEST_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return undefined;
  const data = await response.json() as unknown;
  if (!data || typeof data !== "object" || !("version" in data)) return undefined;
  const version = (data as { version?: unknown }).version;
  return typeof version === "string" && parseVersion(version) ? version : undefined;
}

const COMMAND_PREFIX = "/codex-remaining";
const SUBCOMMANDS = [
  { label: "help", description: "Show all Codex Remaining commands" },
  { label: "compact", description: "Single-line quota summary" },
  { label: "bars", description: "Two quota bars with reset times" },
  { label: "toggle", description: "Switch between compact and bars" },
  { label: "refresh", description: "Force-refresh Codex usage now" },
  { label: "updates", description: "Configure and check npm update notifications" },
  { label: "alerts", description: "Configure low Codex quota warnings" },
  { label: "tibo", description: "Public regular/banked reset announcements (toggle or refresh)" },
] as const;
const UPDATE_ACTIONS = [
  { label: "on", description: "Enable daily npm update notifications" },
  { label: "off", description: "Disable automatic npm update checks" },
  { label: "check", description: "Check npm for an update right now" },
] as const;
const ALERT_ACTIONS = [
  { label: "on", description: "Enable low-quota alerts for 5h and 7d" },
  { label: "off", description: "Disable low-quota alerts" },
  { label: "threshold", description: "Set warning threshold (10-90%, critical fixed at 10%)" },
] as const;
const ALERT_THRESHOLD_PRESETS = [10, 15, 20, 25, 30, 50] as const;
const TIBO_ACTIONS = [
  { label: "on", description: "Show Tibo reset announcements after your account credits" },
  { label: "off", description: "Hide Tibo and stop fetching community announcements" },
  { label: "refresh", description: "Recheck regular and banked reset announcements now" },
  { label: "forecast", description: "One-source reset forecast: view / on / off / refresh" },
  { label: "alerts", description: "Enable or disable new Tibo reset announcements" },
] as const;
const TIBO_FORECAST_ACTIONS = [
  {label:"on",description:"Show experimental forecast in widget"},
  {label:"off",description:"Hide forecast (details command still works)"},
  {label:"refresh",description:"Fetch forecast from codex-reset.com now"},
] as const;
const TIBO_ALERT_ACTIONS = [
  {label:"on",description:"Notify on NEW regular and banked announcements"},
  {label:"off",description:"Disable Tibo announcement notifications"},
] as const;

/** Complete arguments after an existing command, including nested alert settings. */
export function subcommandCompletions(argumentPrefix: string) {
  const tiboNested = /^tibo +(forecast|alerts) +([a-z]*)$/i.exec(argumentPrefix);
  if(tiboNested){
    const name=tiboNested[1]!.toLowerCase();
    const list=name==="forecast" ? TIBO_FORECAST_ACTIONS : TIBO_ALERT_ACTIONS;
    const matches=list.filter(item=>item.label.startsWith(tiboNested[2]!.toLowerCase()));
    return matches.length ? matches.map(item=>({label:item.label,
      value:"tibo "+name+" "+item.label+" ",description:item.description})) : null;
  }
  const threshold = /^alerts +threshold +([0-9]*)$/i.exec(argumentPrefix);
  if (threshold) {
    const matches = ALERT_THRESHOLD_PRESETS.filter(value => String(value).startsWith(threshold[1]!));
    return matches.length
      ? matches.map(value => ({
          label: String(value), value: "alerts threshold " + value + " ",
          description: "Warn at " + value + "% remaining (critical at 10%)",
        }))
      : null;
  }
  const nested = /^(updates|alerts|tibo) +([a-z]*)$/i.exec(argumentPrefix);
  if (nested) {
    const parent = nested[1]!.toLowerCase();
    const actions = parent === "updates" ? UPDATE_ACTIONS : parent === "alerts" ? ALERT_ACTIONS : TIBO_ACTIONS;
    const matches = actions.filter(item => item.label.startsWith(nested[2]!.toLowerCase()));
    return matches.length
      ? matches.map(item => ({ label: item.label, value: parent + " " + item.label + " ", description: item.description }))
      : null;
  }
  if (argumentPrefix.includes(" ")) return null;
  const prefix = argumentPrefix.trim().toLowerCase();
  const matching = SUBCOMMANDS.filter(item => item.label.startsWith(prefix));
  return matching.length > 0
    ? matching.map(item => ({ label: item.label, value: item.label + " ", description: item.description }))
    : null;
}

/**
 * OMP normally offers slash-command names (not arguments) before the first
 * space. Intercept only the exact /codex-remaining token so Tab can list its
 * subcommands without requiring an extra space. Delegate everything else.
 */
export function withCodexRemainingTab(current: AutocompleteProvider): AutocompleteProvider {
  // OMP 18.8.8 automatically reopens autocomplete after accepting a
  // "directory" (value ending with /). Mark only our expandable command
  // nodes this way, then remove the marker before editing the real input.
  // This uses the editor's own chaining behavior for Tab and Right;
  // no keybinding interception or OMP source modification is needed.
  const expandable = (label: string, value: string) =>
    (label === "updates" || label === "alerts" || label === "tibo" || label === "forecast" || label === "threshold") ? value.trimEnd() + "/" : value;
  const matches = SUBCOMMANDS.map(item => ({
    label: item.label,
    value: expandable(item.label, "codex-remaining " + item.label),
    description: item.description,
  }));
  const completeBareCommand = (text: string) =>
    text === COMMAND_PREFIX ? { items: matches, prefix: text } : null;
  const completeOwnArguments = (lines: string[], line: number, col: number) => {
    if (line !== 0 || lines.slice(0, line).some(entry => entry.trim())) return null;
    const text = lines[line]?.slice(0, col) ?? "";
    if (!text.startsWith(COMMAND_PREFIX + " ")) return null;
    const argumentText = text.slice(COMMAND_PREFIX.length + 1);
    const suggestions = subcommandCompletions(argumentText);
    return suggestions?.length
      ? { items: suggestions.map(item => ({
          ...item,
          value: expandable(item.label, item.value),
        })), prefix: argumentText }
      : null;
  };

  return {
    async getSuggestions(lines, cursorLine, cursorCol, signal, onPartial) {
      if (signal?.aborted) return null;
      const text = lines[cursorLine]?.slice(0, cursorCol) ?? "";
      const suggestions = cursorLine === 0 ? completeBareCommand(text) : null;
      return suggestions
        ?? completeOwnArguments(lines, cursorLine, cursorCol)
        ?? current.getSuggestions(lines, cursorLine, cursorCol, signal, onPartial);
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
      const marker = item.value;
      const isOwnExpandable = (
        marker === "codex-remaining updates/" || marker === "codex-remaining alerts/" || marker === "codex-remaining tibo/"
        || marker === "updates/" || marker === "alerts/" || marker === "tibo/" || marker === "alerts threshold/"
        || marker === "tibo forecast/" || marker === "tibo alerts/"
      );
      if (!isOwnExpandable) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);

      const bareCommand = prefix === COMMAND_PREFIX;
      // Bare slash command completion adds the trailing space itself;
      // argument completion needs the trailing space explicitly.
      const normalizedValue = marker.slice(0, -1) + (bareCommand ? "" : " ");
      return current.applyCompletion(
        lines, cursorLine, cursorCol, { ...item, value: normalizedValue }, prefix,
      );
    },
    trySyncSlashCompletion: text =>
      completeBareCommand(text) ?? current.trySyncSlashCompletion?.(text) ?? null,
    ...(current.getInlineHint && {
      getInlineHint: (lines: string[], line: number, col: number) =>
        current.getInlineHint!(lines, line, col),
    }),
    ...(current.trySyncInlineReplace && {
      trySyncInlineReplace: (text: string) => current.trySyncInlineReplace!(text),
    }),
    ...(current.getForceFileSuggestions && {
      getForceFileSuggestions: (lines: string[], line: number, col: number, signal?: AbortSignal) => {
        if (signal?.aborted) return Promise.resolve(null);
        // OMP routes Tab-after-space to forced file completion. Return our
        // argument choices there, while keeping other commands untouched.
        const argumentsOnly = completeOwnArguments(lines, line, col);
        return argumentsOnly
          ? Promise.resolve(argumentsOnly)
          : current.getForceFileSuggestions!(lines, line, col, signal);
      },
    }),
    ...(current.shouldTriggerFileCompletion && {
      shouldTriggerFileCompletion: (lines: string[], line: number, col: number) =>
        completeOwnArguments(lines, line, col) !== null
          || current.shouldTriggerFileCompletion!(lines, line, col),
    }),
  };
}

export function buildQuotaPresentation(
  state: QuotaPollState,
  mode: DisplayMode,
  accent: (text: string) => string,
  success: (text: string) => string,
  warningStyle: (text: string) => string,
  now = Date.now(),
  tiboText?: string,
  forecastText?: string,
): { line?: string; progress: RemainingProgress[] } {
  const report = state.report;
  const quotaLine = report && formatRemainingColored(report, accent, now, success, mode);
  const problem = quotaAvailabilityNote(state, now);
  const warning = problem && warningStyle(problem);
  const baseLine = quotaLine
    ? (warning ? quotaLine + " · " + warning : quotaLine)
    : (warning ? "⏱ Codex · " + warning : "⏱ Codex · checking quotas…");
  const line = baseLine
    + (tiboText ? "  │  " + tiboText : "")
    + (forecastText ? "  │  " + forecastText : "");
  const progress = report && mode === "bars"
    ? quotaWindows(report, now)
        .filter(window => window.label === "5h" || window.label === "7d")
        .map(window => ({ label: window.label, pct: window.pct, resetAt: window.resetAt, reset: window.reset }))
    : [];
  return { line, progress };
}

/** Displayed by the bare slash command and the explicit help alias. */
export function helpLines(mode: DisplayMode, updateChecks = true, quotaAlerts = true, threshold = 20): string[] {
  return [
    `Layout: ${mode} · installed v${EXTENSION_VERSION}`,
    `npm updates: ${updateChecks ? "on" : "off"} · quota alerts: ${quotaAlerts ? `on (${threshold}%)` : "off"}`,
    "",
    "/codex-remaining              Show this help",
    "/codex-remaining help         Show this help",
    "/codex-remaining compact      Single-line quota summary",
    "/codex-remaining bars         Two quota bars",
    "/codex-remaining toggle       Switch layouts",
    "/codex-remaining refresh      Refresh Codex usage",
    "/codex-remaining updates      Show update-check settings",
    "/codex-remaining updates on   Enable daily update checks",
    "/codex-remaining updates off  Disable update checks",
    "/codex-remaining updates check Check npm now",
    "/codex-remaining alerts       Show low-quota alert settings",
    "/codex-remaining alerts on    Enable alerts for 5h and 7d",
    "/codex-remaining alerts off   Disable low-quota alerts",
    "/codex-remaining alerts threshold 20 Set warning % (10-90)",
    "/codex-remaining tibo         Latest community reset announcements",
    "/codex-remaining tibo on/off  Show or hide Tibo inline status",
    "/codex-remaining tibo refresh Check community announcements now",
    "/codex-remaining tibo alerts on/off  New reset notifications (default ON)",
    "/codex-remaining tibo forecast       View 24h/48h model forecast",
    "/codex-remaining tibo forecast on/off Show or hide forecast in widget",
    "/codex-remaining tibo forecast refresh Recheck forecast (single API)",
    "",
    "Critical quota threshold: 10% · daily npm checks: 24h",
    "Quota refresh: 5 min · countdown: 30 sec",
    "Tab: select commands and nested options",
    "Press Enter, Esc or q to close",
  ];
}

export default function codexRemaining(pi: ExtensionAPI): void {
  const quotas = createQuotaPoller(getReport);
  // Defaults preserve Bars and turn on once-daily public npm update checks.
  let preferences = parseUpdatePreferences(undefined);
  let nativeLayoutReady = true;
  let settingsPath = SETTINGS_PATH;
  let settingsWrite: Promise<void> = Promise.resolve();
  let updateInFlight: Promise<boolean> | undefined;
  let lastAlertEvaluatedReport: Report | undefined;
  let tibo: TiboSummary | undefined;
  let forecast: ForecastState = {status:"loading"};
  let forecastNextCheckAt = 0;
  let forecastPending: Promise<boolean> | undefined;
  let tiboNextCheckAt = 0;
  let tiboPending: Promise<boolean> | undefined;
  let persistedQuotaAt = 0;
  let lastProvider: string | undefined;
  let sessionActive = false;

  // Serialize writes so a layout change cannot erase the update-check timestamp.
  const savePreferences = async (): Promise<void> => {
    const snapshot = JSON.stringify(preferences) + "\n";
    const write = settingsWrite.catch(() => {}).then(() => writeFile(settingsPath, snapshot, "utf8"));
    settingsWrite = write;
    await write;
  };

  const initializeSettingsPath = async (): Promise<void> => {
    // The default ~/.omp/agent path is usable immediately; config path
    // discovery is optional background work, never a startup prerequisite.
    try {
      const found = join((await runOmp(["config", "path"])).trim(), "codex-remaining-settings.json");
      if (found !== settingsPath) {
        settingsPath = found;
        await loadMode();
        installCachedValues();
      }
    } catch {
      // Default settings path remains usable.
    }
  };

  const prepareNativeLayout = async (ctx: ExtensionContext): Promise<void> => {
    try {
      const outcome = await reconcileNativeUsage(runOmp);
      nativeLayoutReady = outcome.ready;
      if (!nativeLayoutReady) {
        ctx.ui.notify(
          outcome.reason ?? "OMP native usage is configured; Codex Remaining widget is paused until the status is resolved.",
          "warning",
        );
      }
    } catch {
      nativeLayoutReady = false;
      ctx.ui.notify(
        "Codex Remaining could not verify the native status line. Widget paused to avoid duplicate quota displays.",
        "warning",
      );
    }
  };

  const loadMode = async (): Promise<void> => {
    try {
      preferences = parseUpdatePreferences(JSON.parse(await readFile(settingsPath, "utf8")) as unknown);
    } catch {
      // First install or malformed file: preserve safe defaults.
      preferences = parseUpdatePreferences(undefined);
    }
  };
  const installCachedValues = (): void => {
    if (preferences.lastQuotaReport && preferences.lastQuotaSuccessAt > 0) {
      quotas.seedCached(preferences.lastQuotaReport, preferences.lastQuotaSuccessAt);
    }
    if (!tibo && preferences.tiboCached) tibo = preferences.tiboCached;
    if (preferences.forecastCached && forecast.status === "loading")
      forecast = {status:"stale",data:preferences.forecastCached};
  };

  const clear = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  };
  const show = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    const { line, progress } = buildQuotaPresentation(
      quotas.getState(),
      preferences.mode,
      text => ctx.ui.theme.fg("accent", text),
      text => ctx.ui.theme.fg("success", text),
      text => ctx.ui.theme.fg("warning", text),
      Date.now(),
      preferences.tiboEnabled ? tiboInline(tibo, !tibo || Date.now() >= tiboNextCheckAt) : undefined,
      preferences.tiboEnabled && preferences.forecastEnabled ? forecastInline(forecast) : undefined,
    );
    ctx.ui.setWidget(
      WIDGET_KEY,
      line
        ? (_tui, theme) => ({
            render(width: number) {
              return frameRemaining(
                line,
                text => theme.fg("text", text),
                width,
                progress,
                text => theme.fg("muted", text),
              );
            },
          })
        : undefined,
      { placement: "belowEditor" },
    );
  };

  const refresh = async (ctx: ExtensionContext, force = false): Promise<boolean> => {
    if (ctx.mode !== "tui" || ctx.agent.kind !== "main") return false;
    if (!nativeLayoutReady) {
      clear(ctx);
      return false;
    }
    const model = ctx.models.current() ?? ctx.model;
    if (model?.provider !== "openai-codex") {
      clear(ctx);
      return false;
    }
    // Instant: render cached quota or a nonblocking loading state BEFORE the
    // OMP CLI (~0.8s) fetch completes. Old quota is explicitly marked stale.
    show(ctx);
    const ok = await quotas.refresh(force);
    // A model switch can occur while the CLI subprocess is still resolving.
    if ((ctx.models.current() ?? ctx.model)?.provider !== "openai-codex") {
      clear(ctx);
      return false;
    }
    show(ctx);
    const state = quotas.getState();
    const latest = state.report;
    if (ok && latest && state.lastSuccessAt > persistedQuotaAt) {
      const snapshot = parseQuotaSnapshot(latest);
      if (snapshot) {
        persistedQuotaAt = state.lastSuccessAt;
        preferences.lastQuotaReport = snapshot;
        preferences.lastQuotaSuccessAt = state.lastSuccessAt;
        void savePreferences().catch(() => {});
      }
    }
    if (ok && latest && preferences.quotaAlerts && latest !== lastAlertEvaluatedReport) {
      const result = evaluateQuotaAlerts(latest, preferences);
      if (result.changed) {
        const previous = preferences.lastQuotaAlerts;
        preferences.lastQuotaAlerts = result.next;
        try {
          // Record emitted level before notification so restarts cannot spam.
          await savePreferences();
          lastAlertEvaluatedReport = latest;
          if (sessionActive && preferences.quotaAlerts) {
            for (const event of result.events) {
              if (!sessionActive || !preferences.quotaAlerts) break;
              ctx.ui.notify(formatQuotaAlert(event, preferences.quotaWarningPercent), "warning");
            }
          }
        } catch {
          preferences.lastQuotaAlerts = previous;
          // Retry on the next refresh. Never break quota display.
        }
      } else {
        lastAlertEvaluatedReport = latest;
      }
    }
    return ok;
  };

  // One model, one endpoint, no forecast fallback or blended probabilities.
  const refreshForecast = async (ctx: ExtensionContext, force = false): Promise<boolean> => {
    if (!sessionActive || ctx.mode !== "tui" || ctx.agent.kind !== "main") return false;
    if (!force && (!preferences.tiboEnabled || !preferences.forecastEnabled)) return false;
    if (forecastPending) return forecastPending;
    if (!force && Date.now() < forecastNextCheckAt) return false;
    forecastNextCheckAt = Date.now() + FORECAST_REFRESH_MS;
    const pending = (async () => {
      const fresh = await fetchForecast();
      if (!sessionActive) return false;
      if (fresh.status === "unavailable") {
        forecastNextCheckAt = Date.now() + 2 * 60_000;
        forecast = ("data" in forecast) ? {status:"stale",data:forecast.data} : fresh;
      } else {
        forecast = fresh;
        if ("data" in fresh) {
          preferences.forecastCached = fresh.data;
        } else {
          preferences.forecastCached = undefined; // No forecast != stale forecast
        }
        void savePreferences().catch(() => {});
      }
      if ((ctx.models.current() ?? ctx.model)?.provider === "openai-codex") show(ctx);
      return fresh.status === "estimated" || fresh.status === "no_forecast";
    })();
    forecastPending = pending;
    try { return await pending; } finally {
      if (forecastPending === pending) forecastPending = undefined;
    }
  };

  // Tibo never blocks the account widget. Community data uses its own timer.
  const refreshTibo = async (ctx: ExtensionContext, force = false): Promise<boolean> => {
    if (!preferences.tiboEnabled || !sessionActive || ctx.mode !== "tui" || ctx.agent.kind !== "main") return false;
    if (tiboPending) return tiboPending;
    if (!force && Date.now() < tiboNextCheckAt) return false;
    tiboNextCheckAt = Date.now() + TIBO_REFRESH_MS;
    const task = (async () => {
      try {
        const fresh = await fetchTiboSummary();
        if (!fresh) throw new Error("No verified public records");
        if (!preferences.tiboEnabled || !sessionActive) return false;
        tibo = fresh;
        preferences.tiboCached = fresh;
        // Advance markers even when notifications are turned off, so enabling
        // them later cannot replay old events. First run establishes a baseline.
        const result=calculateTiboNotifications(preferences.lastTiboAlertEvents,fresh);
        preferences.lastTiboAlertEvents=result.next;
        try {
          await savePreferences(); // dedup survives restart before notifying
          if (preferences.tiboAlerts && sessionActive) {
            for (const note of result.announcements) {
              if (!sessionActive || !preferences.tiboAlerts) break;
              ctx.ui.notify("Tibo · "+note,"info");
            }
          }
        } catch { /* Failed persistence must not block the widget. */ }
        if ((ctx.models.current() ?? ctx.model)?.provider === "openai-codex") show(ctx);
        return true;
      } catch {
        tiboNextCheckAt = Date.now() + 2 * 60_000;
        if (tibo) tibo = { ...tibo, stale: true };
        if ((ctx.models.current() ?? ctx.model)?.provider === "openai-codex") show(ctx);
        return false;
      }
    })();
    tiboPending = task;
    try { return await task; } finally { if (tiboPending === task) tiboPending = undefined; }
  };

  const checkForUpdates = async (ctx: ExtensionContext, force = false): Promise<boolean> => {
    if (!sessionActive || ctx.mode !== "tui" || ctx.agent.kind !== "main") return false;
    if (updateInFlight) return updateInFlight;
    if (!force && !shouldAutoCheckUpdates(preferences)) return false;

    const attempt = (async (): Promise<boolean> => {
      if (!force) {
        // Persist the attempt BEFORE sending a request; a restart should not spam npm.
        preferences.lastUpdateCheckAt = Date.now();
        try {
          await savePreferences();
        } catch {
          // Skip background checks if rate-limit state cannot be persisted.
          return false;
        }
      }
      try {
        const latest = await fetchLatestNpmVersion();
        if (!sessionActive || (!force && !preferences.updateChecks)) return false;
        if (!latest) throw new Error("Could not read npm release metadata");

        if (isNewerVersion(EXTENSION_VERSION, latest)) {
          if (force || preferences.lastNotifiedVersion !== latest) {
            preferences.lastNotifiedVersion = latest;
            try { await savePreferences(); } catch { /* Notification is still useful. */ }
            if (sessionActive && (force || preferences.updateChecks)) {
              ctx.ui.notify(
                `Codex Remaining v${latest} available (installed v${EXTENSION_VERSION}). Run: omp plugin upgrade omp-codex-remaining`,
                "info",
              );
            }
          }
        } else if (force) {
          ctx.ui.notify(`Codex Remaining v${EXTENSION_VERSION} is up to date.`, "info");
        }
        return true;
      } catch {
        if (force && sessionActive) {
          ctx.ui.notify("Codex Remaining could not check npm for updates. Try again later.", "warning");
        }
        // Never interrupt quota display when npm is unavailable.
        return false;
      }
    })();
    updateInFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (updateInFlight === attempt) updateInFlight = undefined;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || ctx.agent.kind !== "main") return;
    sessionActive = true;
    // Register command completion synchronously before any I/O.
    ctx.ui.addAutocompleteProvider(withCodexRemainingTab);
    lastProvider = (ctx.models.current() ?? ctx.model)?.provider;
    if (lastProvider === "openai-codex") show(ctx); // immediate indicator

    // Model selector changes are not guaranteed to emit a turn event.
    // Cheap identity checks avoid spawning the CLI unless provider changed.
    ctx.setInterval(() => {
      const provider = (ctx.models.current() ?? ctx.model)?.provider;
      if (provider === lastProvider) return;
      lastProvider = provider;
      void refresh(ctx);
    }, 250);
    ctx.setInterval(() => {
      void refresh(ctx);
      void refreshTibo(ctx);
      void refreshForecast(ctx);
      void checkForUpdates(ctx);
    }, TICK_MS);

    void (async () => {
      await loadMode();
      if (!sessionActive) return;
      installCachedValues();
      if ((ctx.models.current() ?? ctx.model)?.provider === "openai-codex") show(ctx);
      // Expensive checks happen independently after the editor is ready.
      void refresh(ctx);
      void refreshTibo(ctx);
      void refreshForecast(ctx);
      void checkForUpdates(ctx);
      void prepareNativeLayout(ctx).then(() => {
        if (sessionActive && !nativeLayoutReady) clear(ctx);
      });
      void initializeSettingsPath();
    })().catch(() => {});
  });
  pi.on("session_switch", (_event, ctx) => { void refresh(ctx); });
  pi.on("turn_start", (_event, ctx) => { void refresh(ctx); });
  pi.on("turn_end", (_event, ctx) => { void refresh(ctx); });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui" && ctx.agent.kind === "main") {
      sessionActive = false;
      clear(ctx);
    }
  });

  const showHelp = async (ctx: ExtensionContext): Promise<void> => {
    const entries = helpLines(preferences.mode, preferences.updateChecks, preferences.quotaAlerts, preferences.quotaWarningPercent);
    await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => ({
      render(width: number) {
        const available = Math.floor(width);
        if (available < 8) return [fitAnsi("Codex Remaining Help", Math.max(0, available))];

        const innerWidth = Math.min(76, available - 2);
        const rows = entries.map(entry => fitAnsi(entry, innerWidth - 2));
        const border = (text: string) => theme.fg("text", text);
        const title = "─ Codex Remaining · Help ";
        const topRule = innerWidth >= Bun.stringWidth(title)
          ? title + "─".repeat(innerWidth - Bun.stringWidth(title))
          : "─".repeat(innerWidth);
        return [
          border("╭" + topRule + "╮"),
          ...rows.map((row, index) => {
            const styled = index === 0 ? theme.fg("accent", row) : row;
            return border("│") + " " + styled
              + " ".repeat(Math.max(0, innerWidth - 1 - Bun.stringWidth(row))) + border("│");
          }),
          border("╰" + "─".repeat(innerWidth) + "╯"),
        ];
      },
      handleInput(input: string) {
        if (input === "\r" || input === "\n" || input === "\x1b" || input.toLowerCase() === "q") {
          done();
        }
      },
    }), { overlay: true });
  };

  pi.registerCommand("codex-remaining", {
    description: "Codex quotas, alerts, reset history & forecast; compact | bars | refresh | updates | alerts | tibo | help",
    getArgumentCompletions: subcommandCompletions,
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "compact" || arg === "bars" || arg === "toggle") {
        preferences.mode = arg === "toggle"
          ? (preferences.mode === "bars" ? "compact" : "bars")
          : arg;
        try {
          await savePreferences();
          ctx.ui.notify(`Codex Remaining: ${preferences.mode} mode (saved).`, "info");
        } catch {
          ctx.ui.notify(`Codex Remaining: ${preferences.mode} mode (could not save preference).`, "warning");
        }
        await refresh(ctx);
      } else if (arg === "" || arg === "help") {
        await showHelp(ctx);
      } else if (arg === "updates") {
        ctx.ui.notify(
          `Codex Remaining npm update checks: ${preferences.updateChecks ? "on" : "off"} (installed v${EXTENSION_VERSION}). Use: updates on | off | check`,
          "info",
        );
      } else if (arg === "updates on" || arg === "updates off") {
        const enabled = arg === "updates on";
        const wasEnabled = preferences.updateChecks;
        preferences.updateChecks = enabled;
        if (enabled && !wasEnabled) preferences.lastUpdateCheckAt = 0;
        try {
          await savePreferences();
          ctx.ui.notify(`Codex Remaining update checks ${enabled ? "enabled" : "disabled"} (saved).`, "info");
          if (enabled && !wasEnabled) void checkForUpdates(ctx);
        } catch {
          ctx.ui.notify("Could not save update-check setting.", "warning");
        }
      } else if (arg === "updates check") {
        await checkForUpdates(ctx, true);
      } else if (arg === "tibo forecast") {
        ctx.ui.notify(forecastDetails(forecast), "info");
      } else if (arg === "tibo forecast on" || arg === "tibo forecast off") {
        const enabled = arg === "tibo forecast on";
        preferences.forecastEnabled = enabled;
        if (enabled) forecastNextCheckAt = 0;
        try {
          await savePreferences();
          ctx.ui.notify("Tibo forecast display "+(enabled ? "enabled":"disabled")+" (saved).", "info");
        } catch { ctx.ui.notify("Could not save forecast display setting.", "warning"); }
        if ((ctx.models.current() ?? ctx.model)?.provider === "openai-codex") show(ctx);
        if (enabled) void refreshForecast(ctx);
      } else if (arg === "tibo forecast refresh") {
        const ok = await refreshForecast(ctx, true);
        ctx.ui.notify(forecastDetails(forecast)+(!ok ? " · No fresh forecast retrieved." : ""),ok ? "info":"warning");
      } else if (arg === "tibo alerts") {
        ctx.ui.notify("Tibo new reset announcements: "+(preferences.tiboAlerts?"on":"off")+". Use: tibo alerts on | off", "info");
      } else if (arg === "tibo alerts on" || arg === "tibo alerts off") {
        const enabled=arg==="tibo alerts on";
        preferences.tiboAlerts=enabled;
        try {
          await savePreferences();
          ctx.ui.notify("Tibo reset notifications "+(enabled?"enabled":"disabled")+" (saved).", "info");
        } catch { ctx.ui.notify("Could not save Tibo notifications setting.", "warning"); }
      } else if (arg === "tibo") {
        if (!preferences.tiboEnabled) {
          ctx.ui.notify("Tibo community resets are off. Use /codex-remaining tibo on to enable.", "info");
        } else {
          const regular = tibo?.regular?.announcedAt?.slice(0,10) ?? "unknown";
          const banked = tibo?.banked?.announcedAt?.slice(0,10) ?? "unknown";
          const scheduled = tibo?.scheduled
            ? ` · Upcoming ${tibo.scheduled.type} by ${tibo.scheduled.scheduledFor.slice(0,10)} (not guaranteed)`
            : " · No upcoming confirmed announcement";
          const stale = tibo?.stale ? " [STALE]" : "";
          ctx.ui.notify(`Tibo (community)${stale}: last regular reset ${regular} · last banked reset ${banked}${scheduled}. Source: ${tibo?.source ?? "unavailable"}. Official X posts linked in event history; forecast source: https://codex-reset.com/api/forecast`, "info");
        }
      } else if (arg === "tibo on" || arg === "tibo off") {
        const enabled = arg === "tibo on";
        preferences.tiboEnabled = enabled;
        if (enabled) {
          tiboNextCheckAt = 0;
          forecastNextCheckAt = 0;
        }
        try {
          await savePreferences();
          ctx.ui.notify(`Tibo community reset display ${enabled ? "enabled" : "disabled"} (saved).`, "info");
        } catch {
          ctx.ui.notify("Could not save Tibo setting.", "warning");
        }
        if ((ctx.models.current() ?? ctx.model)?.provider === "openai-codex") show(ctx);
        if (enabled) {
          void refreshTibo(ctx);
          void refreshForecast(ctx);
        }
      } else if (arg === "tibo refresh") {
        if (!preferences.tiboEnabled) {
          ctx.ui.notify("Enable Tibo first with /codex-remaining tibo on.", "warning");
        } else {
          const ok = await refreshTibo(ctx,true);
          ctx.ui.notify(ok ? `Tibo community data refreshed: ${tiboInline(tibo)}`
            : "Tibo data unavailable; showing stale records if present.", ok ? "info" : "warning");
        }
      } else if (arg === "alerts") {
        ctx.ui.notify(
          `Codex Remaining quota alerts: ${preferences.quotaAlerts ? "on" : "off"}, warning <=${preferences.quotaWarningPercent}%, critical <=10%, for 5h and 7d.`,
          "info",
        );
      } else if (arg === "alerts on" || arg === "alerts off") {
        const enabled = arg === "alerts on";
        const previous = preferences;
        preferences = {
          ...preferences,
          quotaAlerts: enabled,
          lastQuotaAlerts: enabled && !previous.quotaAlerts ? {} : previous.lastQuotaAlerts,
        };
        try {
          await savePreferences();
          ctx.ui.notify(`Codex Remaining quota alerts ${enabled ? "enabled" : "disabled"} (saved).`, "info");
          if (enabled && !previous.quotaAlerts) lastAlertEvaluatedReport = undefined;
        } catch {
          preferences = previous;
          ctx.ui.notify("Could not save quota-alert preference.", "warning");
        }
      } else if (arg === "alerts threshold") {
        ctx.ui.notify("Set a warning threshold: /codex-remaining alerts threshold 20 (choose 10–90%). Critical stays at 10%.", "info");
      } else if (/^alerts threshold +\d+$/.test(arg)) {
        const threshold = Number(arg.slice("alerts threshold ".length));
        if (!Number.isInteger(threshold) || threshold < 10 || threshold > 90) {
          ctx.ui.notify("Quota warning threshold must be between 10 and 90 percent.", "warning");
        } else {
          const previous = preferences;
          preferences = { ...preferences, quotaWarningPercent: threshold, lastQuotaAlerts: {} };
          try {
            await savePreferences();
            lastAlertEvaluatedReport = undefined;
            ctx.ui.notify(`Codex quota warning threshold set to ${threshold}% (critical remains 10%).`, "info");
          } catch {
            preferences = previous;
            ctx.ui.notify("Could not save quota-alert threshold.", "warning");
          }
        }
      } else if (arg === "refresh") {
        const ok = await refresh(ctx, true);
        ctx.ui.notify(
          ok ? "Codex remaining quota refreshed." : "Codex quota refresh failed or unavailable; keeping the last available data.",
          ok ? "info" : "warning",
        );
      } else {
        ctx.ui.notify("Unknown subcommand. Use /codex-remaining or /codex-remaining help.", "warning");
        await showHelp(ctx);
      }
    },
  });
}
