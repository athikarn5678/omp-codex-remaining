import { evaluateQuotaAlerts, formatQuotaAlert, parseUpdatePreferences, type Report } from "../codex-remaining.ts";
import pkg from "../package.json";

const assert = (value: unknown, msg: string) => { if (!value) throw Error(msg); };
const makeReport = (five: number, seven: number, fiveReset = 2026000000000, sevenReset = 2027000000000): Report => ({
  provider: "openai-codex",
  limits: [
    { scope: { windowId: "5h" }, window: { resetsAt: fiveReset }, amount: { remainingFraction: five / 100 } },
    { scope: { windowId: "7d" }, window: { resetsAt: sevenReset }, amount: { remainingFraction: seven / 100 } },
  ],
});
const prefs = parseUpdatePreferences({mode:"compact",updateChecks:false});
assert(pkg.version === "0.1.6", "package version");
assert(prefs.mode === "compact" && prefs.updateChecks === false, "v0.1.4 preferences migrated");
assert(prefs.quotaAlerts && prefs.quotaWarningPercent === 20, "alerts default on at 20%");
assert(Object.keys(prefs.lastQuotaAlerts).length === 0, "first install has no recorded alerts");
const none = evaluateQuotaAlerts(makeReport(40, 60), prefs);
assert(none.events.length === 0 && !none.changed, "high quota never alerts");

const low = evaluateQuotaAlerts(makeReport(20, 19), prefs);
assert(low.events.length === 2 && low.events.every(event => event.level === "warning"), "20% threshold inclusive");
const persisted = parseUpdatePreferences({...prefs,lastQuotaAlerts:low.next});
assert(Object.keys(persisted.lastQuotaAlerts).length === 2, "alert state survives restart");
const noRepeat = evaluateQuotaAlerts(makeReport(18, 17),persisted);
assert(noRepeat.events.length === 0 && !noRepeat.changed, "same window/reset cannot spam across restarts");
const critical = evaluateQuotaAlerts(makeReport(10, 9),{...persisted,lastQuotaAlerts:noRepeat.next});
assert(critical.events.length === 2 && critical.events.every(event=>event.level === "critical"),
  "critical threshold 10% inclusive and escalates warning");
assert(formatQuotaAlert(critical.events[0]!,20).includes("critically low"), "critical notification understandable");
const noCriticalRepeat = evaluateQuotaAlerts(makeReport(8, 3),{...prefs,lastQuotaAlerts:critical.next});
assert(noCriticalRepeat.events.length === 0, "critical alert is not repeated on each refresh");

const partialRecovery = evaluateQuotaAlerts(makeReport(15, 90),{...prefs,lastQuotaAlerts:critical.next});
assert(partialRecovery.events.length === 0 && partialRecovery.changed, "recovery of one window clears that window state");
assert(!partialRecovery.next["7d"] && partialRecovery.next["5h"]?.level === "critical",
  "critical state remains as quota partially recovers; other window rearmed");
const reset = evaluateQuotaAlerts(makeReport(18, 80,2026000000100),{...prefs,lastQuotaAlerts:critical.next});
assert(reset.events.length === 1 && reset.events[0]?.window === "5h", "new reset window can warn again");

const recovered = evaluateQuotaAlerts(makeReport(95, 95),{...prefs,lastQuotaAlerts:critical.next});
assert(recovered.events.length === 0 && Object.keys(recovered.next).length === 0,
  "fully recovered quotas reset alert suppression");
const rearmed = evaluateQuotaAlerts(makeReport(15, 100),{...prefs,lastQuotaAlerts:recovered.next});
assert(rearmed.events.length === 1 && rearmed.events[0]?.level === "warning", "low after recovery alerts again");

const disabled = evaluateQuotaAlerts(makeReport(0,0),{...prefs,quotaAlerts:false});
assert(disabled.events.length === 0 && !disabled.changed, "disabled alerts never notify");
const noCodex = evaluateQuotaAlerts({ ...makeReport(0,0),provider:"other" },prefs);
assert(noCodex.events.length === 0, "only Codex subscriptions generate alerts");
const invalid = parseUpdatePreferences({
  quotaAlerts:"yes",quotaWarningPercent:4,lastQuotaAlerts:{
    "5h":{level:"invalid"}, "7d":{level:"warning",resetAt:"malformed"},other:{level:"critical"}
  },
});
assert(invalid.quotaWarningPercent === 20 && invalid.quotaAlerts === true,
  "invalid settings never turn alerts on or change threshold unexpectedly");
assert(Object.keys(invalid.lastQuotaAlerts).length === 0, "invalid persisted alert state safely ignored");
assert(parseUpdatePreferences({quotaWarningPercent:10}).quotaWarningPercent===10,
  "minimum threshold supported");
assert(parseUpdatePreferences({quotaWarningPercent:90}).quotaWarningPercent===90,
  "maximum threshold supported");
console.log("PASS quota warning/critical, 5h/7d, restart deduplication, recovery, reset, opt-out and migration");
