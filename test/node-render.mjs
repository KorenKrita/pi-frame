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
initTheme("dark");
let mode = "native";
const ctx = {
  hasUI: true,
  mode: "tui",
  cwd: process.cwd(),
  sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-frame-config", data: { toolMode: mode, foldMode: "expanded" } }] },
  ui: {
    theme: themeModule.theme,
    setWidget() {},
    setStatus() {},
    setToolsExpanded() {},
    onTerminalInput() { return () => {}; },
  },
};
async function load() {
  const loaded = await loadExtensions([extensionPath], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
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
