import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSettingsState, saveSettings } from "../statusline/settings.ts";

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

