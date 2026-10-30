import { describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as themeModule from "/Users/korenkrita/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { SessionManager } from "../loader/session.ts";

initTheme("dark");

// Records every ctx.ui method the loader calls; the theme is the only real member.
function loaderIn(mode: "tui" | "rpc" | "print") {
  const handlers: Record<string, Function[]> = {};
  new SessionManager({
    on: (name: string, handler: Function) => (handlers[name] ??= []).push(handler),
    registerMessageRenderer() {},
  } as any).install();
  const calls: string[] = [];
  const ui = new Proxy({ theme: themeModule.theme } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : () => calls.push(String(key))),
  });
  const ctx: any = { mode, hasUI: mode !== "print", thinkingLevel: "medium", model: { id: "m", provider: "p" }, ui };
  const emit = async (name: string) => {
    for (const handler of handlers[name] ?? []) await handler({}, ctx);
  };
  return { emit, calls };
}

describe("loader mode guard", () => {
  // RPC clients such as T3 cannot show the working line, so the animation timer must not run there.
  test("stays idle outside the terminal UI", async () => {
    for (const mode of ["rpc", "print"] as const) {
      const { emit, calls } = loaderIn(mode);
      await emit("session_start");
      await emit("agent_start");
      await Bun.sleep(120);
      await emit("session_shutdown");
      expect({ mode, calls }).toEqual({ mode, calls: [] });
    }
  });

  test("animates in the terminal UI", async () => {
    const { emit, calls } = loaderIn("tui");
    await emit("session_start");
    await emit("agent_start");
    await emit("session_shutdown");
    expect(calls).toContain("setWorkingIndicator");
  });
});
