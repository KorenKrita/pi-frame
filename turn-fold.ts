// Turn folding: settled turns collapse their tool rows and intermediate assistant prose into one summary line.
// The last turn is never folded, so the live/most recent answer stays fully visible.
import { assistantHasText, assistantHasVisible, isAssistantRow, isNoteRow, isToolRow, isUserRow, type ContainerLike, type Renderable } from "./chat.ts";

export type TurnFoldMode = "expanded" | "compact";

export interface FoldSummary {
  tools: number;
  /** Settled tool rows whose result is an error. */
  failed: number;
  msgs: number;
  notes: number;
  seconds?: number;
}

export interface FoldPlan {
  /** Rows that render nothing. */
  hidden: WeakSet<object>;
  /** First hidden row of each folded turn renders this summary instead. */
  summary: WeakMap<object, FoldSummary>;
  /** Kept final-answer rows: render prose only, drop their thinking block. */
  stripThinking: WeakSet<object>;
}

export const EMPTY_PLAN: FoldPlan = { hidden: new WeakSet(), summary: new WeakMap(), stripThinking: new WeakSet() };

function messageTimestamp(row: Renderable): number | undefined {
  const ts = (row as unknown as { lastMessage?: { timestamp?: number } }).lastMessage?.timestamp;
  return typeof ts === "number" ? ts : undefined;
}

/** pi-topping prompt boxes carry the submit time; native UserMessageComponent has none. */
function userTimestamp(row: Renderable): number | undefined {
  const message = (row as unknown as { message?: { timestamp?: number; details?: { submittedAt?: number } } }).message;
  const ts = message?.details?.submittedAt ?? message?.timestamp;
  return typeof ts === "number" ? ts : undefined;
}

/** Split chat rows into turns; a turn starts at a user row. Rows before the first user row form a leading turn. */
export function splitTurns(rows: Renderable[]): Renderable[][] {
  const turns: Renderable[][] = [];
  let current: Renderable[] = [];
  for (const row of rows) {
    if (isUserRow(row) && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function toolFailed(row: Renderable): boolean {
  const tool = row as unknown as { isPartial?: boolean; result?: { isError?: boolean } };
  return !tool.isPartial && tool.result?.isError === true;
}

/** `keepLast`: the last turn is live (agent streaming) and must stay fully visible. */
export function computeFoldPlan(chat: ContainerLike, keepLast: boolean): FoldPlan {
  const plan: FoldPlan = { hidden: new WeakSet(), summary: new WeakMap(), stripThinking: new WeakSet() };
  const turns = splitTurns(chat.children);
  for (const turn of keepLast ? turns.slice(0, -1) : turns) {
    let lastAnswer: Renderable | undefined;
    for (const row of turn) {
      if (isAssistantRow(row) && assistantHasText(row)) lastAnswer = row;
    }
    if (lastAnswer) plan.stripThinking.add(lastAnswer);
    let tools = 0;
    let failed = 0;
    let msgs = 0;
    let notes = 0;
    let first: Renderable | undefined;
    let firstTs: number | undefined = isUserRow(turn[0]) ? userTimestamp(turn[0]!) : undefined;
    let lastTs: number | undefined;
    for (const row of turn) {
      const isTool = isToolRow(row);
      const isAssistant = isAssistantRow(row);
      const isNote = isNoteRow(row);
      if (!isTool && !isAssistant && !isNote) continue;
      if (isAssistant) {
        const ts = messageTimestamp(row);
        if (ts !== undefined) {
          firstTs ??= ts;
          lastTs = ts;
        }
      }
      if (row === lastAnswer) continue;
      if (isTool) {
        tools++;
        if (toolFailed(row)) failed++;
      }
      else if (isNote) notes++;
      else if (isAssistantRow(row)) {
        if (assistantHasText(row)) msgs++;
        else if (!assistantHasVisible(row)) continue; // pure tool-call carrier renders nothing anyway
        // thinking-only rows are hidden but not counted
      }
      plan.hidden.add(row);
      first ??= row;
    }
    if (first && tools + msgs + notes > 0) {
      const seconds = firstTs !== undefined && lastTs !== undefined && lastTs > firstTs ? Math.round((lastTs - firstTs) / 1000) : undefined;
      plan.summary.set(first, { tools, failed, msgs, notes, seconds });
    }
  }
  return plan;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

type Paint = (text: string) => string;
const plain: Paint = (text) => text;

/** `3 tools · 1 failed · 2 msgs · 1m 5s`; the failure count gets its own paint so it stands out. */
export function formatSummary(summary: FoldSummary, paint: { dim: Paint; failed: Paint } = { dim: plain, failed: plain }): string {
  const parts: string[] = [];
  if (summary.tools) parts.push(paint.dim(`${summary.tools} tool${summary.tools === 1 ? "" : "s"}`));
  if (summary.failed) parts.push(paint.failed(`${summary.failed} failed`));
  if (summary.msgs) parts.push(paint.dim(`${summary.msgs} msg${summary.msgs === 1 ? "" : "s"}`));
  if (summary.notes) parts.push(paint.dim(`${summary.notes} note${summary.notes === 1 ? "" : "s"}`));
  if (summary.seconds !== undefined) parts.push(paint.dim(formatDuration(summary.seconds)));
  return parts.join(paint.dim(" · "));
}
