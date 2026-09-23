import { describe, expect, test } from "bun:test";
import { UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import * as themeModule from "/Users/korenkrita/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import piFrame from "../index.ts";

initTheme("dark");

const SENT = new Date(2026, 8, 23, 14, 40, 32).getTime();

function harness(branch: unknown[]) {
  const handlers: Record<string, Function[]> = {};
  const commands: Record<string, Function> = {};
  const chat = new Container();
  const document = new Container();
  document.addChild(new Container());
  document.addChild(new Container());
  document.addChild(chat);
  const tui = Object.assign(new Container(), { requestRender() {} });
  tui.addChild(document);
  piFrame({
    on: (event: string, handler: Function) => (handlers[event] ??= []).push(handler),
    registerCommand: (name: string, options: { handler: Function }) => (commands[name] = options.handler),
    registerShortcut() {},
    appendEntry() {},
    getThinkingLevel: () => "low",
  } as any);
  const ctx: any = {
    hasUI: true,
    mode: "tui",
    cwd: process.cwd(),
    sessionManager: { getBranch: () => branch },
    ui: {
      theme: themeModule.theme,
      setWidget: (_key: string, factory: any) => { if (typeof factory === "function") factory(tui, themeModule.theme); },
      setStatus() {},
      notify() {},
      onTerminalInput: () => () => {},
      setToolsExpanded() {},
    },
  };
  for (const handler of handlers.session_start ?? []) handler({}, ctx);
  return { chat, branch, command: (name: string, arg = "") => commands[name]!(arg, ctx) };
}

const userEntry = (id: string, text: string, timestamp = SENT) => ({
  type: "message",
  id,
  timestamp: new Date(timestamp).toISOString(),
  message: { role: "user", content: [{ type: "text", text }], timestamp },
});

const plain = (chat: Container, width: number) => chat.render(width).map(stripTerminalSequences);

describe("user prompt box", () => {
  test("frames a native user message with π, send time and the model then in effect", () => {
    const h = harness([
      { type: "model_change", id: "m1", timestamp: "", provider: "p", modelId: "old-model" },
      { type: "thinking_level_change", id: "t1", timestamp: "", thinkingLevel: "high" },
      { type: "model_change", id: "m2", timestamp: "", provider: "p", modelId: "claude-opus-5.5" },
      userEntry("u1", "ping"),
    ]);
    h.chat.addChild(new UserMessageComponent("ping"));
    const out = plain(h.chat, 60);
    expect(out).toHaveLength(3);
    expect(out[0]).toStartWith("╔══ π ");
    expect(out[0]).toEndWith(" 14:40:32 ═╗");
    expect(out[1]).toBe(`║ ping${" ".repeat(60 - 8)} ║`);
    expect(out[2]).toEndWith(" claude-opus-5.5 ═╝");
    for (const line of out) expect(visibleWidth(line)).toBe(60);
  });

  test("the rendered prompt keeps terminal prompt marks for shell-integration jumps", () => {
    const h = harness([userEntry("u1", "ping")]);
    h.chat.addChild(new UserMessageComponent("ping"));
    const raw = h.chat.render(40);
    expect(raw[0]).toStartWith("\x1b]133;A\x07");
    expect(raw.at(-1)).toContain("\x1b]133;B\x07\x1b]133;C\x07");
  });

  test("identical prompts pair with their own entries in order", () => {
    const later = SENT + 65_000;
    const h = harness([userEntry("u1", "again"), userEntry("u2", "again", later)]);
    h.chat.addChild(new UserMessageComponent("again"));
    h.chat.addChild(new UserMessageComponent("again"));
    const tops = plain(h.chat, 50).filter((l) => l.startsWith("╔"));
    expect(tops[0]).toContain("14:40:32");
    expect(tops[1]).toContain("14:41:37");
  });

  test("a live prompt drawn before its entry is saved gets the time once the entry lands", () => {
    const branch: unknown[] = [];
    const h = harness(branch);
    h.chat.addChild(new UserMessageComponent("fresh"));
    const before = plain(h.chat, 40);
    expect(before[0]).not.toMatch(/\d\d:\d\d:\d\d/);
    expect(before[0]).toStartWith("╔══ π ");
    branch.push(userEntry("u1", "fresh"));
    expect(plain(h.chat, 40)[0]).toContain("14:40:32");
  });

  test("copy mode drops the side bars but keeps the top and bottom rules", () => {
    const h = harness([userEntry("u1", "copy me")]);
    h.chat.addChild(new UserMessageComponent("copy me"));
    h.command("cp");
    const out = plain(h.chat, 40);
    expect(out[0]).toStartWith("╔");
    expect(out[1]!.trimEnd()).toBe("copy me");
    expect(out[2]).toStartWith("╚");
  });

  test("narrow widths fall back to the native renderer", () => {
    const h = harness([userEntry("u1", "tiny")]);
    h.chat.addChild(new UserMessageComponent("tiny"));
    expect(plain(h.chat, 12).join("\n")).not.toContain("╔");
  });
});
