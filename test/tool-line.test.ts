import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clampLine, describeCodemodeCalls, middleTruncate, nestedBashCommand, toolLine, type ToolLineInput } from "../tool-line.ts";

const id = (text: string) => text;
const paint = { glyph: id, name: id, detail: id, meta: id, error: id };
const CJK = "把这个很长的中文提示词交给子代理去调研同类项目并且输出报告文件到临时目录里面";

describe("single-line width", () => {
  test.each([1, 2, 9, 10, 20, 31])("middleTruncate keeps CJK text within %i columns and keeps both ends", (max) => {
    const out = middleTruncate(CJK, max);
    expect(visibleWidth(out)).toBeLessThanOrEqual(max);
    if (max >= 10) {
      expect(out.startsWith("把")).toBe(true);
      expect(out.endsWith("面")).toBe(true);
    }
  });

  test("middleTruncate never splits a surrogate pair", () => {
    const out = middleTruncate("😀".repeat(30), 11);
    expect(visibleWidth(out)).toBeLessThanOrEqual(11);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  test("styled arguments are cut as plain text, so their style cannot leak into the token count", () => {
    const input: ToolLineInput = { toolName: "bash", args: { command: "\x1b[1m" + "a".repeat(200) + "\x1b[22m" }, status: "success", output: "ok" };
    const line = toolLine(input, 60, paint);
    expect(line).not.toContain("\x1b[");
    expect(visibleWidth(line)).toBeLessThanOrEqual(60);
  });

  test("middleTruncate returns nothing for a zero budget", () => {
    expect(middleTruncate("abc", 0)).toBe("");
  });

  test.each([40, 80])("a delegate_task row with a Chinese task fits width %i and keeps its token count", (width) => {
    const input: ToolLineInput = { toolName: "delegate_task", args: { task: CJK + CJK }, status: "success", output: "x".repeat(4000) };
    const line = toolLine(input, width, paint);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(line).toContain("~1.0k tok");
    expect(line).toContain("…");
  });

  test.each([1, 8, 16, 24])("toolLine never exceeds a tiny width %i", (width) => {
    const line = toolLine({ toolName: "anchor_grep", args: { pattern: CJK }, status: "error", output: "boom" }, width, paint);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  test("clampLine leaves fitting lines untouched", () => {
    expect(clampLine("short", 10)).toBe("short");
    expect(visibleWidth(clampLine("中文中文中文", 5))).toBeLessThanOrEqual(5);
  });
});

describe("codemode summary", () => {
  const call = (name: string, args: string, status = "ok") => ({ id: name, name, args, status, durationMs: 1 });
  const longCommand = `{"command":"git -C /Users/me/project log --oneline \\"--format=%h %s\\" ${"x".repeat(200)}`.slice(0, 197) + "...";

  test("counts nested calls per tool, shows the first bash command and the failures", () => {
    const details = { calls: [
      call("read", '{"path":"a.ts"}'),
      call("bash", '{"command":"npm test\\nnpm run lint","timeout":60}', "error"),
      call("read", '{"path":"b.ts"}'),
      call("bash", '{"command":"ls"}'),
      call("read", '{"path":"c.ts"}', "cancelled"),
    ] };
    const line = toolLine({ toolName: "codemode", args: { code: "const x = 1;" }, status: "success", output: "ok", details }, 120, paint);
    expect(line).toContain("read ×3, bash ×2 npm test … · 1 failed");
    expect(line).not.toContain("const x");
  });

  test("decodes a bash command from Pi's 200-character argument preview", () => {
    const details = { calls: [call("bash", longCommand)] };
    const text = describeCodemodeCalls(details)!;
    expect(text.startsWith('bash ×1 git -C /Users/me/project log --oneline "--format=%h %s" xxx')).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(nestedBashCommand('{"path":"x"...')).toBeUndefined();
  });

  test("falls back to the script's first line without nested calls", () => {
    const code = "// @options: {\"timeout_ms\": 60000}\nreturn 1;";
    for (const details of [undefined, { calls: [] }, { calls: [{ status: "ok" }] }]) {
      expect(toolLine({ toolName: "codemode", args: { code }, status: "pending", details }, 120, paint)).toContain("// @options:");
    }
  });
});
