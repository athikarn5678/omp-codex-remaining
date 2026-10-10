import { EXTENSION_VERSION, fetchLatestNpmVersion, isNewerVersion, parseUpdatePreferences, shouldAutoCheckUpdates } from "../codex-remaining.ts";
import pkg from "../package.json";

const assert = (ok: unknown, label: string) => { if (!ok) throw Error(label); };
for (const [current, candidate, expected] of [
  ["0.1.4", "0.1.5", true],
  ["0.1.9", "0.1.10", true],
  ["0.1.4", "0.2.0", true],
  ["0.1.4", "1.0.0", true],
  ["0.1.4", "0.1.4", false],
  ["0.1.5", "0.1.4", false],
  ["0.2.0", "0.1.99", false],
  ["0.1.4-beta.1", "0.1.4-beta.2", true],
  ["0.1.4-beta.2", "0.1.4", true],
  ["0.1.4", "0.1.4-beta.5", false],
  ["0.1.4-beta.2", "0.1.4-beta.10", true],
  ["0.1.4-1", "0.1.4-alpha", true],
  ["0.1.4-alpha", "0.1.4-1", false],
  ["0.1.4-rc.1", "0.1.4-rc.1.2", true],
  ["0.1.4+git.1", "0.1.4+git.2", false],
  ["0.1.4", "invalid", false],
  ["invalid", "0.1.5", false],
  ["0.1.4", "0.1.9999999999999999999", false],
] as const) {
  assert(isNewerVersion(current, candidate) === expected, "version precedence: " + current + " -> " + candidate);
}
assert(EXTENSION_VERSION === pkg.version, "update checker and package version remain in sync");
console.log("PASS SemVer comparison including prereleases, numeric components, invalid metadata");

const defaults = parseUpdatePreferences(undefined);
assert(defaults.mode === "bars" && defaults.updateChecks === true && defaults.lastUpdateCheckAt === 0,
  "default settings enable daily check without breaking Bars");
const migrated = parseUpdatePreferences({mode:"compact"});
assert(migrated.mode === "compact" && migrated.updateChecks, "v0.1.3 settings migration retains layout");
assert(parseUpdatePreferences({updateChecks:false,mode:"bars"}).updateChecks === false, "opt-out preference");
const invalid = parseUpdatePreferences({mode:"bad",updateChecks:"false",lastUpdateCheckAt:-42,lastNotifiedVersion:"nope"});
assert(invalid.mode === "bars" && invalid.updateChecks && invalid.lastUpdateCheckAt === 0 &&
  invalid.lastNotifiedVersion === undefined, "malformed settings safely parsed");
assert(parseUpdatePreferences({lastNotifiedVersion:"0.2.0"}).lastNotifiedVersion === "0.2.0",
  "previously-notified release retained");

const day = 24 * 60 * 60_000, now=1_800_000_000_000;
assert(shouldAutoCheckUpdates(defaults,now), "first install triggers first update check");
assert(!shouldAutoCheckUpdates({ ...defaults, lastUpdateCheckAt:now-day+1 },now),
  "no automatic requests before 24h");
assert(shouldAutoCheckUpdates({ ...defaults, lastUpdateCheckAt:now-day },now),
  "refresh allowed at exactly 24h");
assert(!shouldAutoCheckUpdates({ ...defaults, updateChecks:false },now),
  "disabled settings block automatic check");
assert(!shouldAutoCheckUpdates({ ...defaults, lastUpdateCheckAt:now+10_000 },now),
  "future timestamp avoids clock-skew hammering");
console.log("PASS settings migration, disabled checks, once-daily throttle and clock skew");

const calls:string[]=[];
const ok = async (url:string, options?:any):Promise<Response> => {
  calls.push(url);
  assert(options?.headers?.Accept === "application/json", "registry requests json");
  assert(options?.signal instanceof AbortSignal, "registry timeout signal");
  return Response.json({version:"0.1.5"});
};
const version = await fetchLatestNpmVersion(ok as typeof fetch);
assert(version === "0.1.5", "latest npm version extracted");
assert(calls.length === 1 && calls[0] === "https://registry.npmjs.org/omp-codex-remaining/latest",
  "only the public package metadata endpoint requested");
for (const [body, expected] of [
  [{version:"0.2.0-beta.1"}, "0.2.0-beta.1"],
  [{version:43}, undefined],
  [{version:"https://bad"}, undefined],
  [{name:"no version"},undefined],
] as const) {
  const parsed = await fetchLatestNpmVersion((async () => Response.json(body)) as typeof fetch);
  assert(parsed === expected, "reject malformed npm release metadata: "+JSON.stringify(body));
}
assert(await fetchLatestNpmVersion((async () => new Response("not found",{status:404})) as typeof fetch) === undefined,
  "HTTP failure handled without invalid metadata");
let didThrow = false;
try {
  await fetchLatestNpmVersion((async () => { throw new Error("offline"); }) as typeof fetch);
} catch {
  didThrow=true;
}
assert(didThrow, "network failure reaches calling error handler");
console.log("PASS public npm endpoint, timeout signal, malformed payload, HTTP and network failures");
