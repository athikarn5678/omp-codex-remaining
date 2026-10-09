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
          assert(lines.length === 14, "help lines count");
          for (const line of lines) assert(Bun.stringWidth(line) <= w, "help overflows width " + w);
        }
        ui.handleInput(key);
        assert(closed, "help closes on " + JSON.stringify(key));
      }
    },
  },
};
const commands = helpLines("bars").join("\n");
for(const s of ["/codex-remaining             Show this help","/codex-remaining help","/codex-remaining compact","/codex-remaining bars","/codex-remaining toggle","/codex-remaining refresh"]) {
  assert(commands.includes(s), "missing command in help: "+s);
}
assert(commands.includes("Current layout: bars"), "must describe active mode");
const allCommands = ["help", "compact", "bars", "toggle", "refresh"];
const completeAtSpace = completer!("");
assert(completeAtSpace?.map(x => x.label).join(",") === allCommands.join(","), "Tab must list all subcommands");
assert(completeAtSpace.every((x: any) => typeof x.description === "string" && x.description.length > 10),
  "every Tab option must show a model-preset-style description");
assert(completer!("r")?.map(x => x.label).join(",") === "refresh", "prefix filters refresh");
assert(completer!("H")?.map(x => x.label).join(",") === "help", "prefix filtering is case insensitive");
assert(completer!("unknown") === null, "no unrelated matches");
assert(completer!("bars ") === null, "no nested completions");
console.log("PASS Tab completions and descriptions for all five subcommands");

await handler!("",ctx);
await handler!("help",ctx);
await handler!("HeLp",ctx);
assert(customCount === 3, "bare/help must show help");
assert(modelReads === 0, "help must not call refresh/model access");
assert(notices.length === 0, "help must not trigger quota-refreshed notification");
console.log("PASS bare command and help alias show modal; no force-refresh; 5 terminal widths; Enter/Esc/q close");

await handler!("refresh",ctx);
assert(modelReads === 1, "refresh must access model");
assert(notices.some(n=>n.includes("refreshed")), "explicit refresh feedback");
console.log("PASS explicit /codex-remaining refresh path only");

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
assert(noSpace?.items.map(item => item.label).join(",") === allCommands.join(","), "bare Tab lists five options");
assert(noSpace?.items.every(item => item.description && item.description.length > 10), "bare Tab shows right-side descriptions");
assert(noSpace?.prefix === "/codex-remaining", "bare Tab preserves slash prefix");
for (const item of noSpace!.items) {
  const applied = wrapped.applyCompletion(["/codex-remaining"], 0, 16, item, noSpace!.prefix);
  assert(applied.lines[0] === "/codex-remaining " + item.label + " ", "Tab selection inserts " + item.label);
}
const fullList = await wrapped.getSuggestions(["/codex-remaining"], 0, 16);
assert(fullList?.items.length === 5, "async completion also lists all five commands");
assert(baseCalls.length === 0, "exact command must not fall through to OMP default suggestions");
const unrelated = await wrapped.getSuggestions(["/help"], 0, 5);
assert(unrelated?.items[0]?.label === "other", "unrelated commands delegate to default suggestions");
const unrelatedSync = wrapped.trySyncSlashCompletion!("/modelpreset");
assert(unrelatedSync?.items[0]?.label === "base", "unrelated command Tab delegates");
assert(!("getForceFileSuggestions" in wrapped), "do not accidentally add file-completion functionality");
console.log("PASS bare Tab, per-item right-side descriptions, insertion, and fallback to normal OMP autocomplete");
