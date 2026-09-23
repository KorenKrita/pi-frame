// One-line tool summary: `▸ bash    ls -la ~/x                       · 12 lines`
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Paint } from "./frame.ts";

export type ToolStatus = "pending" | "success" | "error";

export interface ToolLineInput {
  toolName: string;
  args: unknown;
  status: ToolStatus;
  /** Text output of the tool (already flattened); undefined while pending. */
  output?: string;
  cwd?: string;
  home?: string;
}

export interface ToolLinePaint {
  glyph: Paint;
  name: Paint;
  detail: Paint;
  meta: Paint;
  error: Paint;
}

const NAME_COL = 12;
/** Long details lose signal past this width; frame modes show the full call. */
const DETAIL_CAP = 96;
const GLYPH: Record<ToolStatus, string> = { pending: "◌", success: "▸", error: "✗" };

export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function tildify(path: string, home?: string): string {
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function shortPath(value: unknown, input: ToolLineInput): string {
  if (typeof value !== "string" || !value) return "";
  let path = value;
  if (input.cwd && path.startsWith(input.cwd + "/")) path = path.slice(input.cwd.length + 1);
  else path = tildify(path, input.home);
  return path;
}

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  const line = nl === -1 ? text : text.slice(0, nl);
  return line.trim() + (nl === -1 ? "" : " …");
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Pick the one argument a human wants to see for this tool. */
export function describeArgs(input: ToolLineInput): string {
  const args = (input.args ?? {}) as Record<string, unknown>;
  switch (input.toolName) {
    case "bash":
    case "bash_bg":
      return firstLine(str(args.command));
    case "read": {
      const path = shortPath(args.path, input);
      const range = args.offset !== undefined || args.limit !== undefined ? ` :${args.offset ?? 1}${args.limit !== undefined ? `+${args.limit}` : ""}` : "";
      return path + range;
    }
    case "write":
    case "edit":
    case "replace":
    case "insert":
    case "undo_last_change":
      return shortPath(args.path, input);
    case "anchor_grep":
    case "grep": {
      const target = shortPath(args.path, input);
      return `/${str(args.pattern)}/${target ? `  in ${target}` : ""}`;
    }
    case "find":
      return [str(args.pattern), shortPath(args.path, input)].filter(Boolean).join("  in ");
    case "ls":
      return shortPath(args.path, input) || ".";
    default: {
      const preferred = ["query", "command", "path", "url", "pattern", "task", "name", "prompt", "description"];
      for (const key of preferred) {
        if (typeof args[key] === "string" && args[key]) return firstLine(args[key] as string);
      }
      const firstString = Object.values(args).find((v) => typeof v === "string" && v);
      if (firstString) return firstLine(firstString as string);
      const json = JSON.stringify(args);
      return json && json !== "{}" ? json : "";
    }
  }
}

/** Rough context cost of a tool result, matching pi's compaction estimate (chars / 4). */
export function estimateTokens(text: string | undefined): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

export function formatTokens(text: string | undefined): string {
  return `~${compactCount(estimateTokens(text))} tok`;
}

export function describeResult(input: ToolLineInput): string {
  if (input.status === "pending") return "…";
  const tok = formatTokens(input.output);
  return input.status === "error" ? `error ${tok}` : tok;
}

/** Truncate keeping both ends: `very/long/…/path.ts`. */
export function middleTruncate(text: string, max: number): string {
  if (max <= 1) return text.length ? "…" : "";
  if (visibleWidth(text) <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return text.slice(0, head) + "…" + (tail > 0 ? text.slice(-tail) : "");
}

export function toolLine(input: ToolLineInput, width: number, paint: ToolLinePaint): string {
  const glyph = paint.glyph(GLYPH[input.status]);
  const name = input.toolName.padEnd(NAME_COL);
  const metaPaint = input.status === "error" ? paint.error : paint.meta;
  const meta = `· ${describeResult(input)}`;
  const prefixWidth = 2 + visibleWidth(name) + 2; // glyph, space, name, two spaces
  const detailMax = Math.max(0, Math.min(DETAIL_CAP, width - prefixWidth - visibleWidth(meta) - 2));
  const detail = middleTruncate(describeArgs(input).replace(/\s+/g, " "), detailMax);
  return `${glyph} ${paint.name(name)}  ${paint.detail(detail)}  ${metaPaint(meta)}`;
}
