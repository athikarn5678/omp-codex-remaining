import extension, { helpLines, withCodexRemainingTab } from "../codex-remaining.ts";

const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
type Handler = (args: string, ctx: any) => Promise<void>;
let handler: Handler | undefined;
let completer: ((arg: string) => Array<{label:string}> | null) | undefined;
const events = new Map<string, Function>();
extension({
  on(name: string, cb: Function) { events.set(name, cb); },
  registerCommand(name: string, spec: any) {
    assert(name === "codex-remaining", "command name");
    handler = spec.handler;
    completer = spec.getArgumentCompletions;
  },
} as any);
assert(handler && completer, "command registered");

let customCount = 0;
let modelReads = 0;
let notices: string[] = [];
const ctx: any = {
  mode: "tui", agent: { kind: "main" },
  models: {current() {modelReads++; return {provider: "other"};}},
  ui: {
    notify(msg: string) {notices.push(msg);},
    setWidget() {},
    setStatus() {},
    async custom(factory: Function, options: any) {
      assert(options?.overlay === true, "help uses overlay");
      customCount++;
      for (const key of ["\r", "\x1b", "q"]) {
        let closed = false;
        const ui = factory(null, {fg(_color:string,text:string) {return text;}}, null, () => {closed = true;});
        for (const w of [15,25,40,80,120]) {
          const lines: string[] = ui.render(w);
          assert(lines.length === helpLines("bars").length + 2, "help lines count");
          for (const line of lines) assert(Bun.stringWidth(line) <= w, "help overflows width " + w);
        }
        ui.handleInput(key);
        assert(closed, "help closes on " + JSON.stringify(key));
      }
    },
  },
};
const commands = helpLines("bars").join("\n");
for(const s of ["/codex-remaining              Show this help","/codex-remaining help","/codex-remaining compact","/codex-remaining bars","/codex-remaining toggle","/codex-remaining refresh","/codex-remaining updates","/codex-remaining updates on","/codex-remaining updates off","/codex-remaining updates check"]) {
  assert(commands.includes(s), "missing command in help: "+s);
}
assert(commands.includes("Layout: bars"), "must describe active mode");
const allCommands = ["help", "compact", "bars", "toggle", "refresh", "updates", "alerts"];
const completeAtSpace = completer!("");
assert(completeAtSpace?.map(x => x.label).join(",") === allCommands.join(","), "Tab must list all subcommands");
assert(completeAtSpace.every((x: any) => typeof x.description === "string" && x.description.length > 10),
  "every Tab option must show a model-preset-style description");
assert(completer!("r")?.map(x => x.label).join(",") === "refresh", "prefix filters refresh");
assert(completer!("H")?.map(x => x.label).join(",") === "help", "prefix filtering is case insensitive");
assert(completer!("unknown") === null, "no unrelated matches");
assert(completer!("bars ") === null, "no unrelated nested completions");
assert(completer!("updates ")?.map(x => x.label).join(",") === "on,off,check", "nested update actions");
assert(completer!("updates c")?.map(x => x.label).join(",") === "check", "nested update filtering");
console.log("PASS Tab completions and descriptions for all seven subcommands and nested actions");

await handler!("",ctx);
await handler!("help",ctx);
await handler!("HeLp",ctx);
assert(customCount === 3, "bare/help must show help");
assert(modelReads === 0, "help must not call refresh/model access");
assert(notices.length === 0, "help must not trigger quota-refreshed notification");
console.log("PASS bare command and help alias show modal; no force-refresh; 5 terminal widths; Enter/Esc/q close");

await handler!("updates",ctx);
assert(notices.some(n=>n.includes("npm update checks: on") && n.includes("installed v0.1.5")),
  "updates status reports enabled state and current version");
await handler!("alerts",ctx);
assert(notices.some(n=>n.includes("quota alerts: on") && n.includes("warning <=20%")),
  "alerts status reports initial warning and critical settings");
await handler!("alerts threshold 5",ctx);
assert(notices.some(n=>n.includes("between 10 and 90 percent")),
  "invalid alert thresholds rejected");
assert(modelReads === 0, "settings/status must not invoke Codex quota");
await handler!("refresh",ctx);
assert(modelReads === 1, "refresh must access model");
assert(notices.some(n=>n.includes("failed or unavailable")), "do not report a successful refresh when Codex is not active");
console.log("PASS explicit /codex-remaining refresh path and truthful failure feedback");

const baseCalls: string[] = [];
const baseProvider: any = {
  getSuggestions: async (lines: string[], _line: number, _col: number) => {
    baseCalls.push("suggest:" + lines.join("|"));
    return { items: [{ label: "other", value: "other" }], prefix: "other" };
  },
  trySyncSlashCompletion: (prefix: string) => {
    baseCalls.push("sync:" + prefix);
    return { items: [{ label: "base", value: "base" }], prefix };
  },
  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: any, prefix: string) {
    const before = lines[cursorLine].slice(0, cursorCol);
    const after = lines[cursorLine].slice(cursorCol);
    // Mirrors the OMP 18.8.7 slash-command completion path for no-space command tokens.
    if (before.startsWith("/") && !before.includes(" ")) {
      const insert = "/" + item.value + " ";
      return { lines: [insert + after], cursorLine, cursorCol: insert.length };
    }
    const insert = before.slice(0, before.length - prefix.length) + item.value;
    return { lines: [insert + after], cursorLine, cursorCol: insert.length };
  },
};
const wrapped = withCodexRemainingTab(baseProvider);
const noSpace = wrapped.trySyncSlashCompletion!("/codex-remaining");
assert(noSpace?.items.map(item => item.label).join(",") === allCommands.join(","), "bare Tab lists seven options");
assert(noSpace?.items.every(item => item.description && item.description.length > 10), "bare Tab shows right-side descriptions");
assert(noSpace?.prefix === "/codex-remaining", "bare Tab preserves slash prefix");
for (const item of noSpace!.items) {
  const applied = wrapped.applyCompletion(["/codex-remaining"], 0, 16, item, noSpace!.prefix);
  assert(applied.lines[0] === "/codex-remaining " + item.label + " ", "Tab selection inserts " + item.label);
}
const fullList = await wrapped.getSuggestions(["/codex-remaining"], 0, 16);
assert(fullList?.items.length === 7, "async completion also lists all seven commands");
assert(baseCalls.length === 0, "exact command must not fall through to OMP default suggestions");
const unrelated = await wrapped.getSuggestions(["/help"], 0, 5);
assert(unrelated?.items[0]?.label === "other", "unrelated commands delegate to default suggestions");
const unrelatedSync = wrapped.trySyncSlashCompletion!("/modelpreset");
assert(unrelatedSync?.items[0]?.label === "base", "unrelated command Tab delegates");
assert(!("getForceFileSuggestions" in wrapped), "do not accidentally add file-completion functionality");
console.log("PASS bare Tab, per-item right-side descriptions, insertion, and fallback to normal OMP autocomplete");

// OMP 18.8.7 routes Tab after a space through force-file completion when
// its provider exposes that API. Verify nested slash options still win.
let forcedCalls = 0;
const tabAfterSpace = withCodexRemainingTab({
  ...baseProvider,
  shouldTriggerFileCompletion: () => false,
  getForceFileSuggestions: async () => {
    forcedCalls++;
    return { items: [{ label: "file", value: "file" }], prefix: "file" };
  },
});
const firstPopup = tabAfterSpace.trySyncSlashCompletion!("/codex-remaining")!;
const updatesItem = firstPopup.items.find(item => item.label === "updates")!;
const updatesText = tabAfterSpace.applyCompletion(["/codex-remaining"], 0, 16, updatesItem, firstPopup.prefix).lines[0]!;
assert(updatesText === "/codex-remaining updates ", "selecting updates inserts correct command and space");
const nested = await tabAfterSpace.getSuggestions([updatesText], 0, updatesText.length);
assert(nested?.items.map(item => item.label).join(",") === "on,off,check",
  "selecting updates opens on/off/check");
assert(tabAfterSpace.shouldTriggerFileCompletion!([updatesText], 0, updatesText.length),
  "OMP's explicit-Tab gate allows nested options, even if base provider rejects");
const forcedNested = await tabAfterSpace.getForceFileSuggestions!([updatesText], 0, updatesText.length);
assert(forcedNested?.items.map(item => item.label).join(",") === "on,off,check",
  "forced Tab chooses update options over file suggestions");
assert(forcedCalls === 0, "nested update Tab does not trigger file completion");
for (const item of forcedNested!.items) {
  const inserted = tabAfterSpace.applyCompletion([updatesText], 0, updatesText.length, item, forcedNested!.prefix);
  assert(inserted.lines[0]?.trim() === "/codex-remaining updates " + item.label,
    "nested action inserted correctly: " + item.label);
}
const alertText = "/codex-remaining alerts ";
assert((await tabAfterSpace.getForceFileSuggestions!([alertText],0,alertText.length))?.items.map(x => x.label).join(",") === "on,off,threshold",
  "alerts has its own nested menu");
const thresholdText = "/codex-remaining alerts threshold ";
assert((await tabAfterSpace.getForceFileSuggestions!([thresholdText],0,thresholdText.length))?.items.length === 6,
  "threshold values complete at a third level");
const otherForce = await tabAfterSpace.getForceFileSuggestions!(["/help foo "], 0, 10);
assert(otherForce?.items[0]?.label === "file" && forcedCalls === 1,
  "unrelated commands still delegate forced completion");
assert(!tabAfterSpace.shouldTriggerFileCompletion!(["/help foo "], 0, 10),
  "unrelated Tab guard remains unchanged");
console.log("PASS real OMP nested-Tab routing after update/alert selection, forced completion, and delegation");
