import extension, { helpLines } from "../codex-remaining.ts";

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
assert(completer!("").map(x=>x.label).join(",") === "compact,bars", "preserve two Tab completions");

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
