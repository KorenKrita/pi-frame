import { beforeEach, describe, expect, test } from "bun:test";
import {
  ToolExecutionComponent,
  createEditToolDefinition,
  createWriteToolDefinition,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Text, getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import * as themeModule from "/Users/korenkrita/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import piFrame from "../index.ts";

type Definition = ConstructorParameters<typeof ToolExecutionComponent>[4];
type Result = Parameters<ToolExecutionComponent["updateResult"]>[0];

function harness(factory = piFrame) {
  const handlers: Record<string, Function[]> = {};
  const commands: Record<string, Function> = {};
  const shortcuts: Record<string, Function> = {};
  const listeners: Function[] = [];
  const entries: unknown[] = [];
  const chat = new Container();
  const document = new Container();
  document.addChild(new Container());
  document.addChild(new Container());
  document.addChild(chat);
  const tui = Object.assign(new Container(), { requestRender() {} });
  tui.addChild(document);
  let expanded = false;

  factory({
    on: (event: string, handler: Function) => (handlers[event] ??= []).push(handler),
    registerCommand: (name: string, options: { handler: Function }) => (commands[name] = options.handler),
    registerShortcut: (name: string, options: { handler: Function }) => (shortcuts[name] = options.handler),
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    registerMessageRenderer() {}, exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }), getThinkingLevel: () => "medium",
  } as any);
  const ctx: any = {
    hasUI: true,
    mode: "tui",
    cwd: process.cwd(),
    sessionManager: {
      getBranch: () => [{ type: "custom", customType: "pi-frame-config", data: { toolMode: "oneLine", foldMode: "expanded" } }],
    },
    ui: {
      theme: themeModule.theme,
      setWidget: (_key: string, factory: any) => { if (typeof factory === "function") factory(tui, themeModule.theme); },
      setStatus() {},
      setWorkingIndicator() {}, setWorkingMessage() {}, getEditorComponent: () => undefined, setEditorComponent() {},
      notify() {},
      onTerminalInput: (listener: Function) => { listeners.push(listener); return () => {}; },
      setToolsExpanded: (value: boolean) => {
        // Match InteractiveMode: selecting the same global value does not reset per-row clicks.
        if (expanded === value) return;
        expanded = value;
        for (const row of chat.children) if (row instanceof ToolExecutionComponent) row.setExpanded(value);
      },
    },
  };
  for (const handler of handlers.session_start ?? []) handler({}, ctx);

  return {
    entries,
    chat,
    press: () => listeners.forEach((listener) => listener("\x0f")),
    command: (name: string, arg = "") => commands[name]!(arg, ctx),
    /** Pick the tool page in /frame-settings and apply these values, as a user would. */
    toolSettings: (values: { toolMode: string; fold?: boolean }) => {
      let offered: Record<string, unknown> | undefined;
      ctx.ui.select = async (_title: string, options: string[]) => options.find((option) => option === "工具显示");
      ctx.ui.custom = async (factory: Function) => {
        const menu = factory(tui, themeModule.theme, undefined, () => {});
        offered = { ...menu.values };
        return { applied: true, values: { toolMode: values.toolMode, fold: values.fold ?? false } };
      };
      return commands["frame-settings"]!("", ctx).then(() => offered);
    },
    shortcut: (name: string) => shortcuts[name]!(ctx),
    add(name: string, args: unknown, definition: Definition = {}, result?: Result) {
      // A registered extension without renderers is NOT the same branch as an unknown tool.
      const row = new ToolExecutionComponent(name, `call-${chat.children.length}`, args, {}, definition, tui as any, ctx.cwd);
      if (result) row.updateResult(result, false);
      row.setExpanded(expanded);
      chat.addChild(row);
      return row;
    },
  };
}

const result = (text: string): Result => ({ content: [{ type: "text", text }], isError: false });
const lines = (row: ToolExecutionComponent, width = 110) => row.render(width).map(stripTerminalSequences);
const show = (row: ToolExecutionComponent, width = 110) => lines(row, width).join("\n");
const longArgs = () => ({
  replaceAll: true,
  sections: { Task: `start ${"context ".repeat(35)}FULL_INPUT_MIDDLE_MUST_BE_VISIBLE${" tail".repeat(35)} end` },
});

initTheme("dark");
let h: ReturnType<typeof harness>;
beforeEach(() => { h = harness(); });

describe("complete tool input and output", () => {
  test("registered notes without renderCall exposes full input in both expanded modes", () => {
    const args = longArgs();
    const receipt = "Notebook revision 3 saved: 6 section(s), 7175 bytes / ~2111 tokens.";
    const row = h.add("notes", args, {}, result(receipt));
    const compact = show(row);
    expect(compact).toContain("…");
    expect(compact).not.toContain("FULL_INPUT_MIDDLE_MUST_BE_VISIBLE");

    for (let mode = 0; mode < 2; mode++) {
      h.press();
      const full = show(row);
      expect(full).toContain("Input");
      expect(full).toContain("Output");
      expect(full).toContain("FULL_INPUT_MIDDLE_MUST_BE_VISIBLE");
      expect(full).toContain(receipt);
    }
    h.press();
    expect(show(row)).toBe(compact);
    expect(h.entries).toHaveLength(3);
  });

  test("only output is previewed, including text spread across multiple content blocks", () => {
    const output: Result = {
      content: [
        { type: "text", text: Array.from({ length: 15 }, (_, i) => `output line ${i + 1}`).join("\n") },
        { type: "text", text: "LAST_OUTPUT_BLOCK_MUST_BE_VISIBLE" },
      ],
      isError: false,
    };
    const row = h.add("notes", longArgs(), {}, output);
    h.press();
    expect(show(row)).toContain("FULL_INPUT_MIDDLE_MUST_BE_VISIBLE");
    expect(show(row)).toContain("more lines");
    expect(show(row)).not.toContain("LAST_OUTPUT_BLOCK_MUST_BE_VISIBLE");
    h.press();
    expect(show(row)).toContain("LAST_OUTPUT_BLOCK_MUST_BE_VISIBLE");
  });

  test("custom summaries do not hide the actual tool output", () => {
    const row = h.add("custom", { action: "inspect" }, {
      renderCall: () => new Text("custom call view", 0, 0),
      renderResult: () => new Text("custom result view", 0, 0),
    }, result("RAW_RESULT_NOT_IN_CUSTOM_SUMMARY"));
    h.press();
    h.press();
    expect(show(row)).toContain("RAW_RESULT_NOT_IN_CUSTOM_SUMMARY");
    expect(show(row)).toContain("custom call view");
    expect(show(row)).toContain("custom result view");
  });

  test("write keeps its rendered code and exposes the success receipt its renderer suppresses", () => {
    const args = { path: "/not-executed/example.ts", content: "const value = 42;" };
    const row = h.add("write", args, createWriteToolDefinition(process.cwd()), result("Successfully wrote to /not-executed/example.ts"));
    h.press();
    expect(show(row)).toContain("Input");
    expect(show(row)).toContain("const value = 42;");
    expect(show(row)).toContain("Successfully wrote to /not-executed/example.ts");
  });

  test("edit keeps the native diff stored in its call renderer and shared state", () => {
    const args = { path: "/not-executed/example.ts", edits: [{ oldText: "old", newText: "new" }] };
    const row = h.add("edit", args, createEditToolDefinition(process.cwd()), {
      content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
      details: { diff: "-1 old\n+1 new", firstChangedLine: 1 },
      isError: false,
    });
    h.press();
    const rendered = show(row);
    expect(rendered).toContain("Input");
    expect(rendered).toContain("Successfully replaced 1 block(s).");
    expect(rendered).toMatch(/-\s*1 old/);
    expect(rendered).toMatch(/\+\s*1 new/);
  });

  test("unknown tool definitions also use the same output preview limit", () => {
    // Explicitly construct undefined: harness.add defaults to the registered-tool branch.
    const row = new ToolExecutionComponent("unknown", "unknown", longArgs(), {}, undefined, { requestRender() {} } as any, process.cwd());
    row.updateResult(result(`${"line\n".repeat(15)}UNKNOWN_OUTPUT_TAIL`), false);
    h.chat.addChild(row);
    h.press();
    expect(show(row)).toContain("FULL_INPUT_MIDDLE_MUST_BE_VISIBLE");
    expect(show(row)).not.toContain("UNKNOWN_OUTPUT_TAIL");
    h.press();
    expect(show(row)).toContain("UNKNOWN_OUTPUT_TAIL");
  });

  test("streaming args and results refresh without changing stored payloads", () => {
    const args = { value: "initial" };
    const row = h.add("custom", args);
    h.press();
    expect(show(row)).toContain("initial");
    args.value = "updated input";
    row.updateArgs(args);
    const output = result("updated output");
    row.updateResult(output, false);
    const before = JSON.stringify({ args, output });
    expect(show(row)).toContain("updated input");
    expect(show(row)).toContain("updated output");
    h.press();
    show(row);
    expect(JSON.stringify({ args, output })).toBe(before);
  });

  test("reusing a result object does not leave stale output in the inspector", () => {
    const output = result("initial output");
    const row = h.add("custom", {}, {}, output);
    h.press();
    expect(show(row)).toContain("initial output");
    output.content[0]!.text = "new output in the same result object";
    row.updateResult(output, false);
    expect(show(row)).toContain("new output in the same result object");
    expect(show(row)).not.toContain("initial output");
  });

  test("settled single-line rows reuse extraction, but in-place result updates invalidate it", () => {
    const output = result("x".repeat(50_000));
    const row = h.add("custom", {}, {}, output);
    const component = row as any;
    const original = component.getTextOutput.bind(component);
    let calls = 0;
    component.getTextOutput = () => { calls++; return original(); };
    show(row);
    const warmCalls = calls;
    for (let i = 0; i < 25; i++) show(row);
    expect(calls).toBe(warmCalls);
    output.content[0]!.text = "changed";
    row.updateResult(output, false);
    h.press();
    expect(show(row)).toContain("changed");
  });

  test("raw output never counts image placeholders as text lines", () => {
    const previous = getCapabilities();
    setCapabilities({ ...previous, images: null });
    try {
      const row = h.add("image", {}, {}, {
        content: [
          { type: "text", text: Array.from({ length: 10 }, (_, i) => `text line ${i + 1}`).join("\n") },
          { type: "image", mimeType: "image/png", data: "" },
        ],
        isError: false,
      });
      h.press();
      const rawPreview = show(row).split("Tool view")[0]!;
      expect(rawPreview).toContain("text line 10");
      expect(rawPreview).not.toContain("more lines");
      expect(rawPreview).not.toContain("[Image");
      h.press();
      expect(show(row).split("Tool view")[0]).not.toContain("[Image");
      row.setShowImages(false);
      expect(show(row).split("Tool view")[0]).not.toContain("[Image");
      expect(show(row).split("Tool view")[1]).toContain("[Image");

      const imageOnly = h.add("image", {}, {}, { content: [{ type: "image", mimeType: "image/png", data: "" }], isError: false });
      expect(show(imageOnly).split("Tool view")[0]).toContain("(no text output)");
    } finally {
      setCapabilities(previous);
    }
  });

  test("raw text keeps terminal safety filtering without treating it as Markdown", () => {
    const row = h.add("custom", {}, {}, result("before\x1b[2Jafter\r\u0000\uFFF9\n**literal Markdown**"));
    h.press();
    const raw = row.render(110).join("\n");
    expect(raw).not.toContain("\x1b[2J");
    expect(raw).not.toContain("\u0000");
    expect(raw).not.toContain("\uFFF9");
    expect(stripTerminalSequences(raw)).toContain("beforeafter");
    expect(stripTerminalSequences(raw)).toContain("**literal Markdown**");
  });

  test("native image protocol output survives both expanded modes", () => {
    const previous = getCapabilities();
    setCapabilities({ ...previous, images: "kitty" });
    try {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=";
      const row = h.add("image", { path: "fixture.png" }, {}, {
        content: [{ type: "text", text: "image receipt" }, { type: "image", data: png, mimeType: "image/png" }],
        isError: false,
      });
      for (let mode = 0; mode < 2; mode++) {
        h.press();
        const raw = row.render(110).join("\n");
        expect(raw).toContain("\x1b_G");
        expect(raw).toContain(png);
        expect(stripTerminalSequences(raw)).toContain("image receipt");
      }
      row.setShowImages(false);
      expect(row.render(110).join("\n")).not.toContain("\x1b_G");
    } finally {
      setCapabilities(previous);
    }
  });

  test.each(["default", "self"] as const)("native %s-shell mouse targets stay aligned below raw I/O", (renderShell) => {
    let seen: TuiMouseEvent | undefined;
    const row = h.add("custom", longArgs(), {
      renderShell,
      renderResult: () => new MouseRegion(new Text("CLICK_NATIVE_TARGET", 0, 0), (event) => {
        seen = event;
        return { handled: true };
      }),
    }, result("raw receipt"));
    h.press();
    const rendered = lines(row);
    const y = rendered.findIndex((line) => line.includes("CLICK_NATIVE_TARGET"));
    const x = rendered[y]!.indexOf("CLICK_NATIVE_TARGET") + 2;
    const dispatched = row.handleMouse({ type: "click", button: "left", x, y, screenX: x + 20, screenY: y + 30, width: 110, height: rendered.length, shift: false, alt: false, ctrl: false });
    expect(dispatched?.handled).toBe(true);
    expect(seen?.x).toBe(2);
    expect(seen?.y).toBe(0);
    expect(dispatched?.target.originY).toBe(y + 30);
  });

  test("clicking the raw output toggles its preview without touching input or payload", () => {
    const row = h.add("notes", longArgs(), {}, result(`${"preview output\n".repeat(15)}CLICK_EXPANDED_TAIL`));
    h.press();
    const rendered = lines(row);
    expect(rendered.join("\n")).not.toContain("CLICK_EXPANDED_TAIL");
    const y = rendered.findIndex((line) => line.includes("preview output"));
    const dispatched = row.handleMouse({ type: "click", button: "left", x: 2, y, screenX: 22, screenY: y + 30, width: 110, height: rendered.length, shift: false, alt: false, ctrl: false });
    expect(dispatched?.handled).toBe(true);
    expect(show(row)).toContain("CLICK_EXPANDED_TAIL");
    expect(show(row)).toContain("FULL_INPUT_MIDDLE_MUST_BE_VISIBLE");
  });

  test("same-mode commands preserve native per-row mouse overrides", async () => {
    const row = h.add("notes", {}, {}, result(`${"line\n".repeat(15)}LOCAL_OVERRIDE_TAIL`));
    await h.toolSettings({ toolMode: "native" });
    const rendered = lines(row);
    const y = rendered.findIndex((line) => line.includes("Output"));
    row.handleMouse({ type: "click", button: "left", x: 2, y, screenX: 22, screenY: y + 30, width: 110, height: rendered.length, shift: false, alt: false, ctrl: false });
    await h.toolSettings({ toolMode: "native" });
    expect(show(row)).not.toContain("LOCAL_OVERRIDE_TAIL");
    await h.toolSettings({ toolMode: "preview" });
    await h.toolSettings({ toolMode: "native" });
    expect(show(row)).toContain("LOCAL_OVERRIDE_TAIL");
  });

  test("one-line tool names open only that row to preview, and the title closes it again", () => {
    const row = h.add("notes", longArgs(), {}, result(`${"preview output\n".repeat(15)}LOCAL_TOOL_OUTPUT_TAIL`));
    const other = h.add("custom", { value: "another tool" }, {}, result("unchanged"));
    const compact = show(row);
    const click = (needle: string) => {
      const rendered = lines(row);
      const y = rendered.findIndex((line) => line.includes(needle));
      expect(y).toBeGreaterThanOrEqual(0);
      const x = rendered[y]!.indexOf(needle);
      return row.handleMouse({ type: "click", button: "left", x, y, screenX: x + 20, screenY: y + 30, width: 110, height: rendered.length, shift: false, alt: false, ctrl: false });
    };

    expect(click("notes")?.handled).toBe(true);
    expect(show(row)).toContain("FULL_INPUT_MIDDLE_MUST_BE_VISIBLE");
    expect(show(row)).not.toContain("LOCAL_TOOL_OUTPUT_TAIL");
    expect(show(other)).not.toContain("Input");
    expect(h.entries).toHaveLength(0);

    expect(click("Output")?.handled).toBe(true);
    expect(show(row)).toContain("LOCAL_TOOL_OUTPUT_TAIL");
    expect(click("notes")?.handled).toBe(true);
    expect(show(row)).toBe(compact);
    expect(show(other)).not.toContain("Input");
  });

  test("global mode changes clear local one-line overrides, but selecting the same mode does not", async () => {
    const row = h.add("notes", {}, {}, result(`${"line\n".repeat(15)}LOCAL_OVERRIDE_END`));
    const click = (needle: string) => {
      const rendered = lines(row);
      const y = rendered.findIndex((line) => line.includes(needle));
      const x = rendered[y]!.indexOf(needle);
      row.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 110, height: rendered.length, shift: false, alt: false, ctrl: false });
    };
    click("notes");
    click("Output");
    await h.toolSettings({ toolMode: "oneLine" });
    expect(show(row)).toContain("LOCAL_OVERRIDE_END");
    h.press(); // oneLine -> preview is still false in Pi's two-state global toggle.
    expect(show(row)).toContain("Input");
    expect(show(row)).not.toContain("LOCAL_OVERRIDE_END");
    h.press();
    expect(show(row)).toContain("LOCAL_OVERRIDE_END");
    h.press();
    expect(show(row)).not.toContain("Input");
  });

  test.each([12, 16, 40, 110])("local tool titles remain clickable at width %i, including copy mode", async (width) => {
    const row = h.add("notes", {}, {}, result(`${"line\n".repeat(15)}NARROW_OUTPUT_END`));
    const click = (needle: string) => {
      const rendered = lines(row, width);
      const y = rendered.findIndex((line) => line.includes(needle));
      expect(y).toBeGreaterThanOrEqual(0);
      const x = rendered[y]!.indexOf(needle);
      return row.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: rendered.length, shift: false, alt: false, ctrl: false });
    };
    for (const copy of [false, true]) {
      if (copy) await h.command("cp");
      try {
        expect(click("notes")?.handled).toBe(true);
        const expanded = lines(row, width);
        expect(expanded.join("\n")).toContain("Input");
        expect(expanded.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(click("notes")?.handled).toBe(true);
        expect(show(row, width)).not.toContain("Input");
      } finally {
        if (copy) await h.command("cp");
      }
    }
  });

  test("only an unmodified left click on the name opens a pending row, and streaming keeps it open", () => {
    const row = h.add("notes", { sections: { Task: "PENDING_INPUT" } });
    const rendered = lines(row);
    const y = rendered.findIndex((line) => line.includes("notes"));
    const event: TuiMouseEvent = { type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width: 110, height: rendered.length, shift: false, alt: false, ctrl: false };
    for (const ignored of [
      { ...event, x: 0 }, // status glyph
      { ...event, x: 7 }, // padded name column
      { ...event, x: 18 }, // argument summary
      { ...event, y: y - 1 }, // leading blank
      { ...event, type: "press" as const },
      { ...event, type: "drag" as const },
      { ...event, button: "right" as const },
      { ...event, shift: true },
    ]) {
      expect(row.handleMouse(ignored)?.handled).not.toBe(true);
      expect(show(row)).not.toContain("Input");
    }
    expect(row.handleMouse(event)?.handled).toBe(true);
    expect(show(row)).toContain("PENDING_INPUT");
    expect(show(row)).toContain("(waiting for output)");
    row.updateArgs({ sections: { Task: "UPDATED_INPUT" } });
    row.updateResult(result(`${"streaming line\n".repeat(15)}STREAM_TAIL`), false);
    expect(show(row)).toContain("UPDATED_INPUT");
    expect(show(row)).not.toContain("STREAM_TAIL");
  });

  test("folded tool summaries cannot reuse a stale title hit region", () => {
    const row = h.add("notes", {}, {}, result("receipt"));
    const rendered = lines(row);
    const y = rendered.findIndex((line) => line.includes("notes"));
    h.shortcut("ctrl+shift+o");
    expect(h.chat.render(110).join("\n")).toContain("1 tool");
    expect(row.handleMouse({ type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width: 110, height: rendered.length, shift: false, alt: false, ctrl: false })?.handled).not.toBe(true);
    h.shortcut("ctrl+shift+o");
    expect(show(row)).not.toContain("Input");
  });

  test("a locally expanded tool is separated from the following compact row", () => {
    const row = h.add("notes", {}, {}, result("receipt"));
    h.add("custom", { value: "NEXT_COLLAPSED_TOOL" }, {}, result("receipt"));
    h.chat.render(110);
    const rendered = lines(row);
    const y = rendered.findIndex((line) => line.includes("notes"));
    row.handleMouse({ type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width: 110, height: rendered.length, shift: false, alt: false, ctrl: false });
    const after = h.chat.render(110).map(stripTerminalSequences);
    const next = after.findIndex((line) => line.includes("NEXT_COLLAPSED_TOOL"));
    expect(next).toBeGreaterThan(0);
    expect(after[next - 1]).toBe("");
  });

  test("errors and empty results still show input and an explicit output section", () => {
    const error = h.add("notes", { reviewed: true }, {}, { ...result("notes rejected"), isError: true });
    const empty = h.add("empty", {}, {}, result(""));
    h.press();
    expect(show(error)).toContain('"reviewed": true');
    expect(show(error)).toContain("notes rejected");
    expect(show(error)).toContain("error");
    expect(show(empty)).toContain("Input");
    expect(show(empty)).toContain("Output");
  });

  test("turn folding still hides detailed tool rows and unfolding restores them", () => {
    const row = h.add("notes", longArgs(), {}, result("saved"));
    h.press();
    expect(show(row)).toContain("Input");
    h.shortcut("ctrl+shift+o");
    const folded = h.chat.render(110).map(stripTerminalSequences).join("\n");
    expect(folded).toContain("1 tool");
    expect(folded).not.toContain("FULL_INPUT_MIDDLE_MUST_BE_VISIBLE");
    h.shortcut("ctrl+shift+o");
    expect(h.chat.render(110).map(stripTerminalSequences).join("\n")).toContain("FULL_INPUT_MIDDLE_MUST_BE_VISIBLE");
  });

  test("reloading the module does not stack raw I/O views or lose the native renderer", async () => {
    const row = h.add("custom", { value: "reload input" }, { renderResult: () => new Text("native after reload", 0, 0) }, result("reload receipt"));
    h.press();
    show(row);
    const reloaded = await import("../index.ts?tool-details-reload");
    h = harness(reloaded.default);
    h.chat.addChild(row);
    h.press();
    const rendered = show(row);
    expect(rendered.match(/Input/g)).toHaveLength(1);
    expect(rendered.match(/Output/g)).toHaveLength(1);
    expect(rendered).toContain("reload input");
    expect(rendered).toContain("native after reload");
  });

  test("input survives narrow widths and copy mode without middle truncation", async () => {
    const row = h.add("notes", { sections: { Task: "接续旧会话 abcdefghijklmnopqrstuvwxyz 保留全部输入" } }, {}, result("saved"));
    h.press();
    for (const width of [12, 40, 110]) {
      const rendered = lines(row, width);
      expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(rendered.join("").replace(/[│\s]/g, "")).toContain("abcdefghijklmnopqrstuvwxyz");
    }
    await h.command("cp");
    try {
      expect(show(row)).not.toMatch(/[│┆┃]/);
      expect(show(row)).toContain("abcdefghijklmnopqrstuvwxyz");
    } finally {
      await h.command("cp");
    }
  });

  test("the tool page of /frame-settings shows the current modes and persists changes to the session", async () => {
    const offered = await h.toolSettings({ toolMode: "preview", fold: true });
    expect(offered).toMatchObject({ toolMode: "oneLine", fold: false });
    expect(h.entries.at(-1)).toEqual({ type: "pi-frame-config", data: { toolMode: "preview", foldMode: "compact" } });
    expect(await h.toolSettings({ toolMode: "preview" })).toMatchObject({ toolMode: "preview", fold: true });
  });
});
