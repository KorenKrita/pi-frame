import piFrame from "../index.ts";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { computeFoldPlan, formatSummary } from "../turn-fold.ts";
import { findChatContainer } from "../chat.ts";

// fake pi + ctx
const handlers: Record<string, Function[]> = {};
const shortcuts: Record<string, Function> = {};
const commands: Record<string, Function> = {};
const entries: any[] = [];
const pi: any = {
  on: (e: string, h: Function) => (handlers[e] ??= []).push(h),
  registerShortcut: (k: string, o: any) => (shortcuts[k] = o.handler),
  registerCommand: (n: string, o: any) => (commands[n] = o.handler),
  appendEntry: (t: string, d: any) => entries.push({ t, d }),
  registerMessageRenderer() {}, exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }), getThinkingLevel: () => "medium",
};
piFrame(pi);

// build a fake TUI tree mimicking interactive-mode
const header = new Container(), resources = new Container(), chat = new Container(), doc = new Container();
doc.addChild(header); doc.addChild(resources); doc.addChild(chat);
let renders = 0;
const tui: any = new Container(); tui.addChild(doc); tui.requestRender = () => renders++;
let toolsExpanded = false;
const listeners: Function[] = [];
const statuses: Record<string, string> = {};
const ui: any = {
  theme: (initTheme("dark"), (await import("/Users/korenkrita/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js")).theme),
  setWidget: (k: string, f: any) => { if (typeof f === "function") f(tui, ui.theme); },
  onTerminalInput: (h: Function) => { listeners.push(h); return () => {}; },
  setToolsExpanded: (e: boolean) => { toolsExpanded = e; for (const c of chat.children as any[]) c.setExpanded?.(e); },
  setStatus: (k: string, t: string) => (statuses[k] = t),
  setWorkingIndicator() {}, setWorkingMessage() {}, getEditorComponent: () => undefined, setEditorComponent() {},
  notify: () => {},
};
const ctx: any = { hasUI: true, mode: "tui", cwd: "/Users/korenkrita/Coding", ui, sessionManager: { getBranch: () => [] } };
for (const h of handlers.session_start) h({}, ctx);
console.log("chat found:", findChatContainer(tui) === chat, "status:", statuses["pi-frame"], "expanded:", toolsExpanded);

const fakeUi = { requestRender: () => {} };
const mkTool = (name: string, args: any, out?: string, err = false) => {
  const t = new ToolExecutionComponent(name, "id", args, {}, undefined, fakeUi as any, ctx.cwd);
  if (out !== undefined) t.updateResult({ content: [{ type: "text", text: out }], isError: err }, false);
  return t;
};
const mkAsst = (content: any[], ts: number) => {
  const a = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, []);
  a.updateContent({ role: "assistant", content, timestamp: ts, stopReason: "stop" } as any, false);
  return a;
};
// turn 1 (settled): user, thinking+text, tool, tool, final text
chat.addChild(new Text("user 1", 1, 1)); // stand-in; not a user row -> use real one below
const { UserMessageComponent } = await import("@earendil-works/pi-coding-agent");
chat.children[0] = new UserMessageComponent("user one");
chat.addChild(mkAsst([{ type: "thinking", thinking: "let me think about this carefully" }, { type: "text", text: "I'll run ls." }], 1000));
chat.addChild(mkTool("bash", { command: "ls -la /Users/korenkrita/Coding/some/very/long/path/that/keeps/going" }, "a\nb\nc\nd"));
chat.addChild(mkAsst([{ type: "toolCall", id: "x", name: "read", arguments: {} }], 2000)); // carrier: renders nothing
chat.addChild(mkTool("read", { path: "/Users/korenkrita/Coding/foo.ts", offset: 10, limit: 20 }, "x".repeat(1500)));
chat.addChild(new Spacer(1)); chat.addChild(new Text("Tool output: collapsed", 1, 0)); // native status row
chat.addChild(mkTool("bash", { command: "false" }, "boom", true));
{ const { CustomMessageComponent } = await import("@earendil-works/pi-coding-agent");
  chat.addChild(new CustomMessageComponent({ role: "custom", customType: "subagent_supervisor_request", content: "Subagent progress update.", display: true, timestamp: 3000 } as any, undefined)); }
chat.addChild(mkAsst([{ type: "text", text: "Final answer for turn one." }], 46000));
// turn 2 (live)
chat.addChild(new Spacer(1));
chat.addChild(new UserMessageComponent("user two"));
chat.addChild(mkAsst([{ type: "thinking", thinking: "thinking again" }], 50000));
chat.addChild(mkTool("anchor_grep", { pattern: "foo.*bar", path: "/Users/korenkrita/Coding/src" }));

const W = 70;
// Rail cells (reverse-video space) print as ▌ so the dump shows where the bar sits; all other SGR is stripped.
const plain = (l: string) => l.replace(/\x1b\[7m(?:\x1b\[[0-9;]*m)* (?:\x1b\[[0-9;]*m)*\x1b\[27m/g, "▌").replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
const dump = (label: string) => { console.log(`\n===== ${label} =====`); for (const l of tui.render(W)) console.log(plain(l)); };
dump("oneLine");
// ctrl+o -> preview
const press = () => listeners.forEach((l) => l("\x0f"));
press(); dump("preview (" + statuses["pi-frame"] + ") expanded=" + toolsExpanded);
// /cp -> rules style (no side bars), then back
await commands.cp("", ctx); dump("preview + copy mode (" + statuses["pi-frame"] + ")");
{ const bars = tui.render(W).map(plain).filter((l: string) => /[│┆┃]/.test(l)); console.log("copy mode lines with side bars:", bars.length); }
await commands.cp("", ctx); console.log("back to", statuses["pi-frame"]);
press(); dump("native (" + statuses["pi-frame"] + ") expanded=" + toolsExpanded);
press(); console.log("back to", statuses["pi-frame"], "expanded=", toolsExpanded);
// fold
shortcuts["ctrl+shift+o"](ctx); dump("folded idle " + statuses["pi-frame"]);
handlers.agent_start.forEach((h: Function) => h({}, ctx)); dump("folded streaming"); handlers.agent_end.forEach((h: Function) => h({}, ctx));
const plan = computeFoldPlan(chat as any, false);
console.log("summary:", [...(chat.children as any[])].map((r) => plan.summary.get(r)).filter(Boolean).map(formatSummary));
// hidden thinking
{ const live = (chat.children as any[]).filter((c) => c instanceof AssistantMessageComponent).at(-1); live.setHideThinkingBlock(true); dump("hidden thinking on live turn"); }
console.log("entries persisted:", entries.length, "renders:", renders);
