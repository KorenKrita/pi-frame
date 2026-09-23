import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORDS } from "../loader/words.ts";
import { buildMenuSections, DEFAULT_SETTINGS } from "../loader/settings.ts";
import { loadBundledWordPacks } from "../loader/word-packs.ts";
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
    registerMessageRenderer() {}, exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
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
      setWorkingIndicator() {}, setWorkingMessage() {}, getEditorComponent: () => undefined, setEditorComponent() {},
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
  test("frames a native user message with the π icon, send time and the model then in effect", () => {
    const h = harness([
      { type: "model_change", id: "m1", timestamp: "", provider: "p", modelId: "old-model" },
      { type: "thinking_level_change", id: "t1", timestamp: "", thinkingLevel: "high" },
      { type: "model_change", id: "m2", timestamp: "", provider: "p", modelId: "claude-opus-5.5" },
      userEntry("u1", "ping"),
    ]);
    h.chat.addChild(new UserMessageComponent("ping"));
    const out = plain(h.chat, 60);
    expect(out).toHaveLength(3);
    expect(out[0]).toStartWith("╔══ \ue22c ");
    expect(out[0]).toEndWith(" 14:40:32 ═╗");
    expect(out[1]).toBe(`║ ping${" ".repeat(60 - 8)} ║`);
    expect(out[2]).toEndWith(" p/claude-opus-5.5 ═╝");
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
    expect(before[0]).toStartWith("╔══ \ue22c ");
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
    h.command("cp"); // copy mode is global pi-frame state; restore it for later tests
  });

  test("narrow widths fall back to the native renderer", () => {
    const h = harness([userEntry("u1", "tiny")]);
    h.chat.addChild(new UserMessageComponent("tiny"));
    expect(plain(h.chat, 12).join("\n")).not.toContain("╔");
  });
});

describe("prompt box settings (/frame-settings)", () => {
  const settingsFile = () => join(process.env.PI_CODING_AGENT_DIR!, "pi-frame", "prompt-loader.json");
  const legacyFile = () => join(process.env.PI_CODING_AGENT_DIR!, "pi-topping", "settings.json");
  const write = (file: string, data: unknown) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  };
  afterEach(() => {
    rmSync(settingsFile(), { force: true });
    rmSync(legacyFile(), { force: true });
  });

  test("style, icon, provider and model options reshape the box", () => {
    write(settingsFile(), {
      schemaVersion: 3,
      decorations: { borderStyle: "heavy", promptIcon: false, promptProvider: true, promptModel: true, promptTimestamp: false },
    });
    const h = harness([{ type: "model_change", id: "m", timestamp: "", provider: "local-claude", modelId: "opus" }, userEntry("u1", "hi")]);
    h.chat.addChild(new UserMessageComponent("hi"));
    const out = plain(h.chat, 40);
    expect(out[0]).toBe(`┏${"━".repeat(38)}┓`);
    expect(out[1]).toStartWith("┃ hi");
    expect(out[2]).toEndWith(" local-claude/opus ━┛");
  });

  test("turning the box off falls back to Pi's native prompt row", () => {
    write(settingsFile(), { schemaVersion: 3, decorations: { decorateUserPrompt: false } });
    const h = harness([userEntry("u1", "plain")]);
    h.chat.addChild(new UserMessageComponent("plain"));
    expect(plain(h.chat, 40).join("\n")).not.toContain("╔");
  });

  test("pi-topping settings are imported, but its prompt-interception switch is not", () => {
    // decorateUserPrompt=false was how users kept prompts native under pi-topping; here it would only hide the box.
    write(legacyFile(), { schemaVersion: 3, decorations: { decorateUserPrompt: false, borderStyle: "rounded", useNerdFont: false } });
    const h = harness([userEntry("u1", "legacy")]);
    h.chat.addChild(new UserMessageComponent("legacy"));
    const out = plain(h.chat, 40);
    expect(out[0]).toStartWith("╭── π ");
  });
});

describe("loader words", () => {
  test("the base pool is pi-frame's own Chinese set", () => {
    expect(WORDS.length).toBeGreaterThan(50);
    expect(WORDS.every((w) => /[\u4e00-\u9fff]/.test(w.present_tense))).toBe(true);
  });
});

describe("/frame-settings pages", () => {
  test("the prompt page and the loader page each show only their own options", () => {
    const ids = (page: "prompt" | "loader") =>
      buildMenuSections(page, DEFAULT_SETTINGS, loadBundledWordPacks()).flatMap((section) => section.items.map((item) => item.id));
    const prompt = ids("prompt");
    const loader = ids("loader");
    expect(prompt).toContain("decorateUserPrompt");
    expect(prompt).toContain("useNerdFont");
    expect(prompt.some((id) => id.startsWith("pack:"))).toBe(false);
    expect(loader).toContain("animatedSpinner");
    expect(loader.some((id) => id.startsWith("pack:"))).toBe(true);
    expect(loader.filter((id) => prompt.includes(id))).toEqual([]);
  });
});

describe("bundled word packs", () => {
  test("pi-frame ships its own four Chinese packs, off until enabled", () => {
    const packs = loadBundledWordPacks();
    expect(packs.map((pack) => pack.name).sort()).toEqual(["AI 娘", "二次元", "甄嬛传", "程序员黑话"].sort());
    for (const pack of packs) {
      expect(pack.words.length).toBe(40);
      expect(pack.words.every((w) => /[\u4e00-\u9fff]/.test(w.present_tense))).toBe(true);
      expect(DEFAULT_SETTINGS.wordPacks[pack.id]).toBeUndefined();
    }
  });
});
