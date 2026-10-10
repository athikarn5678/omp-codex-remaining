import {
  buildQuotaPresentation,
  createQuotaPoller,
  formatRemaining,
  formatRemainingColored,
  frameRemaining,
  parseDisplayMode,
  quotaAvailabilityNote,
  reconcileNativeUsage,
  remainingHex,
  resolveOmpExecutable,
  type Report,
} from "../codex-remaining.ts";

const assert = (ok: unknown, why: string) => {
  if (!ok) throw new Error(why);
};

const windows: Report = {
  provider: "openai-codex",
  limits: [
    { scope: { windowId: "5h" }, amount: { remainingFraction: 0.2 }, window: { resetsAt: 1800000000000 } },
    { scope: { windowId: "7d" }, amount: { usedFraction: 0.4 }, window: { resetsAt: 1800500000000 } },
  ],
};
const now = 1799990000000;
const noop = (text: string) => text;
const fresh = { report: windows, lastSuccessAt: now, lastAttemptFailed: false, nextAttempt: now + 300000 };

assert(formatRemainingColored(windows, noop, now, noop, "bars")?.includes("Codex quotas"),
  "bar header exists with quota-only payload, without plan or credits");
assert(formatRemainingColored(windows, noop, now, noop, "compact")?.includes("5h 20%"),
  "compact mode still displays 5h quota");
assert(formatRemaining(windows, now)?.includes("7d 60%"), "used fraction converted to remaining");
const bare = buildQuotaPresentation(fresh, "bars", noop, noop, noop, now);
assert(bare.line?.includes("Codex quotas"), "quota-only report must not disappear from widget");
assert(bare.progress.length === 2, "bars must include both 5h and 7d");
assert(bare.progress[0]?.pct === 20 && bare.progress[1]?.pct === 60, "bars use remaining quota fraction");
for (const [pct, color] of [[0, "#EF4444"], [20, "#EF4444"], [21, "#F97316"], [40, "#F97316"],
  [41, "#EAB308"], [60, "#EAB308"], [61, "#84CC16"], [80, "#84CC16"],
  [81, "#22C55E"], [100, "#22C55E"]] as const) {
  assert(remainingHex(pct) === color, "quota color threshold at " + pct);
}
for (const width of [1, 2, 5, 6, 8, 14, 25, 40, 70, 100, 140]) {
  const rendered = frameRemaining(bare.line!, noop, width, bare.progress, noop);
  assert(rendered.length >= 1, "widget should render at terminal width " + width);
  assert(rendered.every(line => Bun.stringWidth(line.replace(/\x1b\[[0-9;]*m/g, "")) <= width),
    "widget must not overflow at terminal width " + width);
}
assert(parseDisplayMode("compact") === "compact", "saved compact preference");
assert(parseDisplayMode("malformed") === "bars", "invalid preference fallback");
const ompPath = process.platform === "win32" ? "C:\\Apps\\omp.exe" : "/usr/local/bin/omp";
const otherPath = process.platform === "win32" ? "C:\\Apps\\bun.exe" : "/usr/local/bin/bun";
assert(resolveOmpExecutable(() => undefined, [ompPath, otherPath]) === ompPath,
  "OMP resolver falls back to known executable on the active OS");
console.log("PASS quota math, bar-only payload, colors, terminal widths, preferences, and executable discovery");

const readOnly = (preset: string, left: string, right: string) => {
  const args: string[] = [];
  const command = async (argv: string[]) => {
    const key = argv.join(" ");
    args.push(key);
    if (key === "config get statusLine.preset") return preset;
    if (key === "config get statusLine.leftSegments") return left;
    if (key === "config get statusLine.rightSegments") return right;
    throw new Error("Write attempted: " + key);
  };
  return { command, args };
};
let fixture = readOnly("default", '["usage"]', '["usage"]');
let result = await reconcileNativeUsage(fixture.command);
assert(result.ready && !result.changed, "native preset does not disable widget");
assert(fixture.args.length === 1, "native preset only reads one config field");

fixture = readOnly("custom", '["model","branch"]', '["cwd"]');
result = await reconcileNativeUsage(fixture.command);
assert(result.ready && !result.changed, "custom without usage permits widget");
assert(fixture.args.length === 3, "custom reads status segments");

fixture = readOnly("custom", '["usage","model"]', '["cwd"]');
result = await reconcileNativeUsage(fixture.command);
assert(!result.ready && !result.changed && result.reason?.includes("not changed"),
  "custom with usage is paused, never modified");
assert(fixture.args.every(x => x.startsWith("config get")), "reconciler is strictly read-only");

fixture = readOnly("custom", "broken JSON", '["usage"]');
result = await reconcileNativeUsage(fixture.command);
assert(!result.ready && !result.changed, "invalid config never edited");

fixture = readOnly("custom", '{"wrong":"shape"}', '["model"]');
result = await reconcileNativeUsage(fixture.command);
assert(!result.ready && !result.changed, "non-array config safely rejected");
console.log("PASS read-only native status reconciliation and malformed config protection");

let time = 2000000000000;
let calls = 0;
let fail = false;
let empty = false;
const poller = createQuotaPoller(async () => {
  calls++;
  if (fail) throw new Error("temporary CLI failure");
  return empty ? { provider: "openai-codex", limits: [] } : windows;
}, () => time);

assert(await poller.refresh(), "initial fetch succeeds");
assert(calls === 1, "initial fetch calls CLI once");
assert(poller.getState().lastSuccessAt === time, "successful fetch timestamp recorded");
assert(await poller.refresh(), "fresh cached data works");
assert(calls === 1, "normal refresh respects 5-minute cache");
time += 5 * 60000;
fail = true;
assert(!(await poller.refresh()), "failed poll returns false");
assert(calls === 2, "fetch retried at 5-minute boundary");
const stale = poller.getState();
assert(stale.lastAttemptFailed && stale.report === windows, "preserve good quota while marking stale");
assert(quotaAvailabilityNote(stale, time)?.includes("stale quota"), "stale indication displayed");
const uiStale = buildQuotaPresentation(stale, "bars", noop, noop, noop, time);
assert(uiStale.line?.includes("stale quota") && uiStale.progress.length === 2,
  "stale widget shows last good quota and warning");
assert(!(await poller.refresh()), "failed cached request reports failure");
assert(calls === 2, "failed requests throttle at 60 seconds");
time += 60000;
fail = false;
empty = true;
assert(!(await poller.refresh()), "empty quota response is a failed refresh");
assert(calls === 3, "empty response attempted only after retry interval");
empty = false;
assert(await poller.refresh(true), "forced refresh bypasses retry throttle");
assert(calls === 4, "forced refresh performs fetch");
assert(!poller.getState().lastAttemptFailed, "recovery clears stale flag");
assert(quotaAvailabilityNote(poller.getState(), time) === undefined, "no warning after recovery");
assert(!(await createQuotaPoller(async () => undefined, () => time).refresh()), "missing report treated as failure");
const emptyState = createQuotaPoller(async () => { throw Error("offline"); }, () => time);
assert(!(await emptyState.refresh()), "offline is recoverable");
assert(quotaAvailabilityNote(emptyState.getState(), time)?.includes("unavailable"), "no-cache failure displayed");
const offlineUi = buildQuotaPresentation(emptyState.getState(), "bars", noop, noop, noop, time);
assert(offlineUi.line?.includes("unavailable") && offlineUi.progress.length === 0,
  "initial failure displays warning widget rather than disappearing");
console.log("PASS fetch caching, throttling, stale/recovery, forced refresh, empty/offline states");

let fulfill!: (report: Report | undefined) => void;
let concurrencyCalls = 0;
const concurrent = createQuotaPoller(() => {
  concurrencyCalls++;
  return new Promise(resolve => { fulfill = resolve; });
}, () => time);
const requests = [concurrent.refresh(), concurrent.refresh(true), concurrent.refresh()];
assert(concurrencyCalls === 1, "concurrent refresh requests share a single operation");
fulfill(windows);
assert((await Promise.all(requests)).every(Boolean), "all callers receive the shared result");
assert(concurrencyCalls === 1, "concurrent deduplication preserved");
console.log("PASS simultaneous quota refreshes are deduplicated");
