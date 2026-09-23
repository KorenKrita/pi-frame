import { afterEach, describe, expect, test } from "bun:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Text, TuiAltScreen, stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import { createChatViewport } from "/Users/korenkrita/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import * as themeModule from "/Users/korenkrita/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { createInteractiveTuiReference } from "/Users/korenkrita/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
import piFrame from "../index.ts";

// The terminal is the only fake renderer boundary. Keyboard and SGR mouse reports
// traverse TuiAltScreen's actual input, layout, selection, and component dispatch.
class MemoryTerminal implements Terminal {
  columns = 90;
  rows = 18;
  kittyProtocolActive = false;
  input: (data: string) => void = () => {};
  start(onInput: (data: string) => void) { this.input = onInput; }
  stop() {}
  async drainInput() {}
  write(_data: string) {}
  moveBy(_lines: number) {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(_title: string) {}
  setProgress(_active: boolean) {}
}

initTheme("dark");
const active: TuiAltScreen[] = [];
afterEach(() => { for (const tui of active.splice(0)) tui.stop(); });

function harness() {
  const terminal = new MemoryTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  active.push(tui);
  const reference = createInteractiveTuiReference(() => tui);
  const document = new Container(), chat = new Container();
  const header = new Container(), resources = new Container();
  header.addChild(new Text("HEADER\nsecond header line\nthird header line", 0, 0));
  document.addChild(header); document.addChild(resources); document.addChild(chat);
  const parts = { document, pendingMessages: new Container(), status: new Container(), widgetsAbove: new Container(), editor: new Container(), widgetsBelow: new Container(), footer: new Container() };
  const viewport = createChatViewport({ ...parts, scrollbar: "always" });
  // Pi keeps legacy children mounted alongside a separate fullscreen layoutRoot.
  for (const part of Object.values(parts)) tui.addChild(part);
  tui.setLayoutRoot(viewport.root);
  const scroll = viewport.transcript as ScrollView;
  const handlers: Record<string, Function[]> = {};
  piFrame({
    on: (name: string, handler: Function) => (handlers[name] ??= []).push(handler),
    registerCommand() {}, registerShortcut() {}, appendEntry() {},
    registerMessageRenderer() {}, exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }), getThinkingLevel: () => "medium",
  } as any);
  let expanded = false;
  const ctx: any = {
    hasUI: true, mode: "tui", cwd: process.cwd(),
    sessionManager: { buildContextEntries: () => [], getBranch: () => [{ type: "custom", customType: "pi-frame-config", data: { toolMode: "oneLine", foldMode: "expanded" } }] },
    ui: {
      theme: themeModule.theme,
      setWidget: (_key: string, factory: any) => { if (typeof factory === "function") factory(reference); },
      setStatus() {},
      setWorkingIndicator() {}, setWorkingMessage() {}, getEditorComponent: () => undefined, setEditorComponent() {},
      onTerminalInput: (listener: any) => tui.addInputListener(listener),
      setToolsExpanded(value: boolean) {
        if (expanded === value) return;
        expanded = value;
        for (const row of chat.children) if (row instanceof ToolExecutionComponent) row.setExpanded(value);
      },
    },
  };
  for (const handler of handlers.session_start ?? []) handler({}, ctx);
  const tools = Array.from({ length: 40 }, (_, i) => {
    const marker = `ROW_${String(i).padStart(2, "0")}`;
    const row = new ToolExecutionComponent("custom", `tool-${i}`, { marker }, {}, {}, reference, process.cwd());
    row.updateResult({ content: [{ type: "text", text: Array.from({ length: 40 }, (_, line) => `${marker} output ${line}`).join("\n") }], isError: false }, false);
    chat.addChild(row);
    return row;
  });
  tui.start();
  tui.renderNow();
  const documentLines = () => document.render(scroll.getContentWidth(terminal.columns)).map(stripTerminalSequences);
  const screen = () => documentLines().slice(tui.viewportTop, tui.viewportTop + scroll.viewportHeight);
  const rowText = (index: number) => tools[index]!.render(scroll.getContentWidth(terminal.columns)).map(stripTerminalSequences).join("\n");
  const goTo = (marker: string) => {
    const y = documentLines().findIndex((line) => line.includes(marker));
    expect(y).toBeGreaterThanOrEqual(0);
    tui.scrollBy(y - tui.viewportTop);
    tui.renderNow();
    expect(tui.isFollowingOutput).toBe(false);
  };
  const click = (needle: string) => {
    const rendered = screen();
    const y = rendered.findIndex((line) => line.includes(needle));
    expect(y).toBeGreaterThanOrEqual(0);
    const x = rendered[y]!.indexOf(needle);
    terminal.input(`\x1b[<0;${x + 1};${y + 1}M`);
    terminal.input(`\x1b[<0;${x + 1};${y + 1}m`);
    tui.renderNow();
  };
  const press = () => { terminal.input("\x0f"); tui.renderNow(); };
  return { tui, terminal, scroll, screen, rowText, goTo, click, press };
}

describe("fullscreen keyboard and mouse interaction", () => {
  test("Ctrl+O keeps the reading row through the complete three-mode cycle away from bottom", () => {
    const h = harness();
    h.goTo("ROW_10");
    expect(h.screen().join("\n")).toContain("ROW_10");
    for (let i = 0; i < 3; i++) {
      h.press();
      expect(h.screen().slice(0, 7).join("\n")).toContain("ROW_10");
      expect(h.tui.isFollowingOutput).toBe(false);
    }
  });

  test("collapsing from inside a tool clamps to that same tool instead of jumping to the end", () => {
    const h = harness();
    h.press(); h.press();
    h.goTo("ROW_10 output 20");
    h.press();
    expect(h.screen().slice(0, 2).join("\n")).toContain("ROW_10");
    expect(h.tui.isFollowingOutput).toBe(false);
  });

  test("Ctrl+O at bottom keeps following output", () => {
    const h = harness();
    expect(h.tui.isFollowingOutput).toBe(true);
    for (let i = 0; i < 3; i++) {
      h.press();
      expect(h.tui.isFollowingOutput).toBe(true);
      expect(h.screen().join("\n")).toContain("ROW_39");
    }
  });

  test("actual name and Output clicks change just one tool without moving the reading row", () => {
    const h = harness();
    h.goTo("ROW_10");
    h.click("custom");
    expect(h.rowText(10)).toContain("Input");
    expect(h.rowText(10)).not.toContain("ROW_10 output 39");
    expect(h.rowText(11)).not.toContain("Input");
    expect(h.screen().slice(0, 7).join("\n")).toContain("ROW_10");
    h.click("Output");
    expect(h.rowText(10)).toContain("ROW_10 output 39");
    h.click("custom");
    expect(h.rowText(10)).not.toContain("Input");
    expect(h.screen().slice(0, 2).join("\n")).toContain("ROW_10");
    expect(h.tui.isFollowingOutput).toBe(false);
  });

  test("dragging across a tool name does not expand it", () => {
    const h = harness();
    h.goTo("ROW_10");
    const y = h.screen().findIndex((line) => line.includes("custom"));
    h.terminal.input(`\x1b[<0;3;${y + 1}M`);
    h.terminal.input(`\x1b[<32;15;${y + 1}M`);
    h.terminal.input(`\x1b[<0;15;${y + 1}m`);
    h.tui.renderNow();
    expect(h.rowText(10)).not.toContain("Input");
  });
});
