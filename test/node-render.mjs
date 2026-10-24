// Node and the actual Pi/jiti loader have different limits and reload behavior from Bun.
// Run: JITI_FS_CACHE=0 node test/node-render.mjs. No tools are executed or files mutated.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ToolExecutionComponent, initTheme } from "/Users/korenkrita/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { loadExtensions } from "/Users/korenkrita/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { Text, stripTerminalSequences } from "/Users/korenkrita/.bun/install/global/node_modules/@earendil-works/pi-tui/dist/index.js";
import * as themeModule from "/Users/korenkrita/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
// Keep the developer's real ~/.pi/agent settings out of the run (read lazily at extension load).
process.env.PI_CODING_AGENT_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "pi-frame-node-"));
initTheme("dark");
let mode = "native";
const ctx = {
  hasUI: true,
  mode: "tui",
  cwd: process.cwd(),
  sessionManager: { buildContextEntries: () => [], getBranch: () => [{ type: "custom", customType: "pi-frame-config", data: { toolMode: mode, foldMode: "expanded" } }] },
  ui: {
    theme: themeModule.theme,
    setWidget() {},
    setStatus() {},
    setWorkingIndicator() {}, setWorkingMessage() {}, getEditorComponent: () => undefined, setEditorComponent() {},
    setToolsExpanded() {},
    onTerminalInput() { return () => {}; },
  },
};
let loaded;
async function load() {
  // Pi shuts the old session's extensions down before a reload.
  if (loaded) for (const handler of loaded.extensions[0].handlers.get("session_shutdown") ?? []) await handler({}, ctx);
  loaded = await loadExtensions([extensionPath], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  loaded.runtime.getThinkingLevel = () => "medium"; // bound by Pi's runner in a real session
  for (const handler of loaded.extensions[0].handlers.get("session_start") ?? []) await handler({ reason: "reload" }, ctx);
}
const make = (text, definition = {}) => {
  const row = new ToolExecutionComponent("custom", "node-probe", { input: "NODE_INPUT_MARKER" }, {}, definition, { requestRender() {} }, process.cwd());
  row.updateResult({ content: [{ type: "text", text }], isError: false }, false);
  row.setExpanded(true);
  return row;
};

await load();
const huge = make(`${"x\n".repeat(149_999)}NODE_OUTPUT_TAIL`, {
  renderResult: (result) => new Text(result.content[0].text, 0, 0),
});
const rendered = huge.render(80);
assert(rendered.length > 300_000, "both raw output and the complete native tool view must survive");
assert(rendered.some((line) => line.includes("NODE_INPUT_MARKER")));
assert(rendered.some((line) => line.includes("NODE_OUTPUT_TAIL")));
console.log(`PASS Node large output: ${rendered.length} rendered lines`);

const reloadRow = make("NODE_RELOAD_RECEIPT", { renderResult: () => new Text("NODE_NATIVE_VIEW", 0, 0) });
reloadRow.render(80);
await load();
const afterReload = reloadRow.render(80).map(stripTerminalSequences).join("\n");
assert.equal(afterReload.match(/Input/g)?.length, 1);
assert.equal(afterReload.match(/Output/g)?.length, 1);
assert(afterReload.includes("NODE_NATIVE_VIEW"));
assert(afterReload.includes("NODE_RELOAD_RECEIPT"));
console.log("PASS actual Pi/jiti reload: one I/O layer and native rendering retained");

mode = "oneLine";
await load();
let extractions = 0;
const rows = Array.from({ length: 100 }, () => {
  const row = make("x".repeat(50_000));
  const original = row.getTextOutput.bind(row);
  row.getTextOutput = () => { extractions++; return original(); };
  row.render(110);
  return row;
});
const warmed = extractions;
const start = performance.now();
for (let pass = 0; pass < 10; pass++) for (const row of rows) row.render(110);
const perPass = (performance.now() - start) / 10;
assert.equal(extractions, warmed, "unchanged single-line output must not be extracted again");
console.log(`PASS Node cached repaint: 100 × 50KB outputs, ${perPass.toFixed(2)} ms/pass, zero re-extractions`);
mode = "preview";
await load();
const bulky = "中文内容abc ".repeat(2000); // ~20 KB of input JSON per tool, CJK-heavy like real sessions
const boxes = Array.from({ length: 100 }, () => {
  const row = new ToolExecutionComponent("custom", "node-preview", { content: bulky }, {}, {}, { requestRender() {} }, process.cwd());
  row.updateResult({ content: [{ type: "text", text: "line\n".repeat(20) }], isError: false }, false);
  row.render(110);
  return row;
});
const firstFrame = boxes.map((row) => row.render(110));
const boxStart = performance.now();
for (let pass = 0; pass < 10; pass++) for (const row of boxes) row.render(110);
const boxPass = (performance.now() - boxStart) / 10;
assert(boxes.every((row, i) => row.render(110) === firstFrame[i]), "unchanged open boxes must be reused");
console.log(`PASS Node cached boxes: 100 open tools × 20KB input in preview, ${boxPass.toFixed(2)} ms/pass`);
// End the session the way Pi does so watchers and timers stop and the process can exit.
for (const handler of loaded.extensions[0].handlers.get("session_shutdown") ?? []) await handler({}, ctx);
