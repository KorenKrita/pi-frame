import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSettingsState, saveSettings } from "../statusline/settings.ts";
import { installStatusline } from "../statusline/index.ts";
import { KeybindingsManager } from "/Users/korenkrita/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { getEditorTheme } from "/Users/korenkrita/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import * as themeModule from "/Users/korenkrita/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

const agentDir = () => process.env.PI_CODING_AGENT_DIR!;
const ownFile = () => join(agentDir(), "pi-frame", "statusline.json");
const legacyFile = () => join(agentDir(), "pi-topping-statusline", "settings.json");
const write = (file: string, data: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
};

describe("statusline settings", () => {
  afterEach(() => {
    rmSync(ownFile(), { force: true });
    rmSync(legacyFile(), { force: true });
  });

  test("pi-topping-statusline settings seed the first run", () => {
    write(legacyFile(), { separator: "pipe", borderStyle: "heavy", segments: { provider: true } });
    const state = createSettingsState();
    expect(state.settings.separator).toBe("pipe");
    expect(state.settings.borderStyle).toBe("heavy");
    expect(state.settings.segments?.provider).toBe(true);
  });

  test("saving writes pi-frame's own file, which then wins over the legacy one", () => {
    write(legacyFile(), { separator: "pipe" });
    saveSettings({ separator: "slash" });
    expect(JSON.parse(readFileSync(ownFile(), "utf8")).separator).toBe("slash");
    expect(JSON.parse(readFileSync(legacyFile(), "utf8")).separator).toBe("pipe");
    expect(createSettingsState().settings.separator).toBe("slash");
  });

  test("no settings anywhere falls back to defaults without creating files", () => {
    expect(createSettingsState().settings).toEqual({});
    expect(existsSync(ownFile())).toBe(false);
  });

  test("the import happens once: later edits to the old file no longer leak in", () => {
    write(legacyFile(), { borderStyle: "heavy" });
    expect(createSettingsState().settings.borderStyle).toBe("heavy");
    write(legacyFile(), { borderStyle: "single" });
    expect(createSettingsState().settings.borderStyle).toBe("heavy");
  });

  test("a corrupt pi-frame file falls back to defaults, not to the old file", () => {
    write(legacyFile(), { borderStyle: "heavy" });
    mkdirSync(dirname(ownFile()), { recursive: true });
    writeFileSync(ownFile(), "{not json");
    expect(createSettingsState().settings).toEqual({});
  });
});


themeModule.initTheme("dark");

describe("boxed editor", () => {
  test("clicks land on the character drawn under the pointer", () => {
    const handlers: Record<string, Function[]> = {};
    let factory: any;
    installStatusline({
      on: (event: string, handler: Function) => (handlers[event] ??= []).push(handler),
      exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
      getThinkingLevel: () => "medium",
    } as any);
    const notices: string[] = [];
    const ctx: any = {
      hasUI: true,
      mode: "tui",
      cwd: process.cwd(),
      model: { id: "m1", provider: "p", contextWindow: 200_000 },
      getContextUsage: () => undefined,
      sessionManager: { getBranch: () => [], buildContextEntries: () => [], getEntries: () => [], getSessionName: () => undefined },
      ui: {
        theme: themeModule.theme,
        getEditorComponent: () => factory,
        setEditorComponent: (next: unknown) => (factory = next),
        notify: (message: string) => notices.push(message),
      },
    };
    for (const handler of handlers.session_start ?? []) handler({}, ctx);
    const tui: any = { requestRender() {}, terminal: { rows: 40, columns: 60 }, children: [] };
    const editor = factory(tui, getEditorTheme(), KeybindingsManager.create(agentDir()));
    editor.setText("abcdef\nghijkl");
    const lines: string[] = editor.render(60).map((line: string) => stripTerminalSequences(line));
    expect(notices).toEqual([]);
    expect(lines[1]).toStartWith("╭");
    const click = (text: string) => {
      const y = lines.findIndex((line) => line.includes(text));
      editor.handleMouse({ type: "click", button: "left", x: lines[y]!.indexOf(text), y, width: 60, height: lines.length, shift: false, alt: false, ctrl: false });
      return editor.getCursor();
    };
    expect(click("abcdef")).toEqual({ line: 0, col: 0 });
    expect(click("jkl")).toEqual({ line: 1, col: 3 });
    for (const handler of handlers.session_shutdown ?? []) handler({}, ctx);
  });
});
