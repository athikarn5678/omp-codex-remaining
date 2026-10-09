/**
 * Codex Remaining (OMP 18.8.6+) — five-level ANSI color, theme-aware reset timer.
 *
 * The built-in `status` segment sanitizes ANSI and applies one accent to the
 * entire string. Instead use the officially supported, styled single-line widget
 * below the editor. The rest of OMP's native status line remains unchanged.
 *
 * Standalone: no installation into OMP's bundled JavaScript is needed.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";

const WIDGET_KEY = "codex-remaining";
const STATUS_KEY = "codex-remaining"; // clear legacy status from the prior version
const REFRESH_MS = 5 * 60_000;
const TICK_MS = 30_000;
const ANSI_DEFAULT_FG = "\x1b[39m";
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
  if (mode === "compact") {
    for (const window of quotaWindows(report, now)) {
      const timer = window.reset ? ` (${window.reset})` : "";
      // Compact mode matches the original single-line status.
      parts.push(rgbPercent(`${window.label} ${window.pct}%${timer}`, window.pct));
    }
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
  const line = fitAnsi(coloredLine, maxContentCells);

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

  const content = [line, ...barRows];
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
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (exitCode !== 0) {
    // Avoid revealing CLI output from other commands or secret-bearing options.
    throw new Error(`omp ${args[0] ?? ""} failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
  }
  return stdout.trim();
}

export type UsageReconciliation = { ready: boolean; changed: boolean; reason?: string };

/**
 * Official OMP presets do not include the "usage" segment. Only the CUSTOM
 * preset can duplicate our widget. On custom installations, remove exactly
 * the built-in usage segment from the existing left/right arrays using OMP's
 * own config CLI. A full config backup is required BEFORE changing anything.
 *
 * The current TUI may have cached the old status-line layout. Suppress the
 * widget for that first launch; it will appear on restart without duplication.
 * A project/env override that shadows the global config is never edited here.
 */
export async function reconcileNativeUsage(
  command: OmpCommand,
  backup: () => Promise<void>,
): Promise<UsageReconciliation> {
  const preset = (await command(["config", "get", "statusLine.preset"])).trim();
  if (preset !== "custom") return { ready: true, changed: false };
  const keys = ["statusLine.leftSegments", "statusLine.rightSegments"] as const;
  const readings = await Promise.all(keys.map(key => command(["config", "get", key])));
  const current = readings.map(raw => JSON.parse(raw) as unknown);
  if (!current.every(value => Array.isArray(value) && value.every(x => typeof x === "string"))) {
    return { ready: false, changed: false, reason: "Unexpected status line configuration; not modified." };
  }
  const segments = current as string[][];
  if (!segments.some(items => items.includes("usage"))) return { ready: true, changed: false };

  await backup(); // Refuse to edit when backup fails.
  for (let i = 0; i < keys.length; i++) {
    if (!segments[i]!.includes("usage")) continue;
    const replacement = segments[i]!.filter(segment => segment !== "usage");
    await command(["config", "set", keys[i]!, JSON.stringify(replacement)]);
  }
  const checked = await Promise.all(keys.map(key => command(["config", "get", key])));
  const stillPresent = checked.some(raw => {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) && list.includes("usage");
  });
  return stillPresent
    ? { ready: false, changed: true, reason: "An OMP project/environment override still enables native usage." }
    : { ready: false, changed: true, reason: "Native usage was disabled in OMP config. Restart OMP once to activate the widget." };
}

async function backupNativeConfig(): Promise<void> {
  const dir = (await runOmp(["config", "path"])).trim();
  const original = join(dir, "config.yml");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(dir, `config.yml.pre-codex-remaining-${timestamp}.bak`);
  try {
    await copyFile(original, backup, constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

async function getReport(): Promise<Report | undefined> {
  const body = await runOmp(["usage", "--provider", "openai-codex", "--json", "--redact"]);
  const parsed = JSON.parse(body) as { reports?: Report[] };
  return parsed.reports?.find(x => x.provider === "openai-codex");
}

/** Displayed by the bare slash command and the explicit help alias. */
export function helpLines(mode: DisplayMode): string[] {
  return [
    `Current layout: ${mode}`,
    "",
    "/codex-remaining             Show this help",
    "/codex-remaining help        Show this help",
    "/codex-remaining compact     Single-line quota summary",
    "/codex-remaining bars        Two quota bars with reset times",
    "/codex-remaining toggle      Switch between layouts",
    "/codex-remaining refresh     Force-refresh Codex usage",
    "",
    "Auto-refresh: every 5 min; countdowns: every 30 sec",
    "Tab: type /codex-remaining followed by a space, then Tab",
    "Press Enter, Esc or q to close",
  ];
}

export default function codexRemaining(pi: ExtensionAPI): void {
  let report: Report | undefined;
  // Default to the existing progress-bar layout on first install/update.
  let displayMode: DisplayMode = "bars";
  let fetchedAt = 0;
  let nextAttempt = 0;
  let inFlight: Promise<void> | undefined;
  let nativeLayoutReady = true;
  let settingsPath = SETTINGS_PATH;

  const initializeSettingsPath = async (): Promise<void> => {
    try {
      settingsPath = join((await runOmp(["config", "path"])).trim(), "codex-remaining-settings.json");
    } catch {
      // Older OMP versions: standard agent directory remains the fallback.
    }
  };

  const prepareNativeLayout = async (ctx: ExtensionContext): Promise<void> => {
    try {
      const outcome = await reconcileNativeUsage(runOmp, backupNativeConfig);
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
      const saved = JSON.parse(await readFile(settingsPath, "utf8")) as { mode?: unknown };
      displayMode = parseDisplayMode(saved.mode);
    } catch {
      // No saved preference on initial install: retain the current Bars view.
    }
  };

  const clear = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  };
  const show = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    const now = Date.now();
    const line = report && formatRemainingColored(
      report,
      text => ctx.ui.theme.fg("accent", text),
      now,
      text => ctx.ui.theme.fg("success", text),
      displayMode,
    );
    const progress = report && displayMode === "bars"
      ? quotaWindows(report, now)
          .filter(window => window.label === "5h" || window.label === "7d")
          .map(window => ({
            label: window.label, pct: window.pct,
            resetAt: window.resetAt, reset: window.reset,
          }))
      : [];
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

  const refresh = async (ctx: ExtensionContext, force = false): Promise<void> => {
    if (ctx.mode !== "tui" || ctx.agent.kind !== "main") return;
    if (!nativeLayoutReady) {
      clear(ctx);
      return;
    }
    const model = ctx.models.current() ?? ctx.model;
    if (model?.provider !== "openai-codex") {
      clear(ctx);
      return;
    }
    const now = Date.now();
    if (!inFlight && (force || (now >= nextAttempt && now - fetchedAt >= REFRESH_MS))) {
      inFlight = (async () => {
        try {
          const result = await getReport();
          if (result) {
            report = result;
            fetchedAt = Date.now();
            nextAttempt = fetchedAt + REFRESH_MS;
          } else {
            nextAttempt = Date.now() + 60_000;
          }
        } catch {
          // Preserve last available quota on a transient failure.
          nextAttempt = Date.now() + 60_000;
        }
      })();
      try { await inFlight; } finally { inFlight = undefined; }
    }
    show(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || ctx.agent.kind !== "main") return;
    await initializeSettingsPath();
    await loadMode();
    await prepareNativeLayout(ctx);
    ctx.setInterval(() => { void refresh(ctx); }, TICK_MS);
    await refresh(ctx, true);
  });
  pi.on("session_switch", async (_event, ctx) => { await refresh(ctx); });
  pi.on("turn_start", async (_event, ctx) => { await refresh(ctx); });
  pi.on("turn_end", async (_event, ctx) => { await refresh(ctx); });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui" && ctx.agent.kind === "main") clear(ctx);
  });

  const showHelp = async (ctx: ExtensionContext): Promise<void> => {
    const entries = helpLines(displayMode);
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
    description: "Show Codex Remaining help; subcommands: compact | bars | toggle | refresh | help",
    getArgumentCompletions(argumentPrefix) {
      if (argumentPrefix.includes(" ")) return null;
      const prefix = argumentPrefix.trim().toLowerCase();
      const choices = [
        { label: "compact", value: "compact ", description: "Single-line status without bars" },
        { label: "bars", value: "bars ", description: "Two colored quota bars with reset dates" },
      ];
      const matches = choices.filter(choice => choice.label.startsWith(prefix));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "compact" || arg === "bars" || arg === "toggle") {
        displayMode = arg === "toggle"
          ? (displayMode === "bars" ? "compact" : "bars")
          : arg;
        try {
          await writeFile(settingsPath, JSON.stringify({ mode: displayMode }) + "\n", "utf8");
          ctx.ui.notify(`Codex Remaining: ${displayMode} mode (saved).`, "info");
        } catch {
          ctx.ui.notify(`Codex Remaining: ${displayMode} mode (could not save preference).`, "warning");
        }
        await refresh(ctx);
      } else if (arg === "" || arg === "help") {
        await showHelp(ctx);
      } else if (arg === "refresh") {
        await refresh(ctx, true);
        ctx.ui.notify("Codex remaining quota refreshed.", "info");
      } else {
        ctx.ui.notify("Unknown subcommand. Use /codex-remaining or /codex-remaining help.", "warning");
        await showHelp(ctx);
      }
    },
  });
}
