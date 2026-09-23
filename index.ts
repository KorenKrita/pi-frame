// pi-frame — borders and folding for the chat transcript, layered on top of pi's native state.
//
//   ctrl+t        native thinking toggle untouched; thinking blocks get a rounded dashed frame,
//                 the hidden-thinking label becomes a single rule.
//   ctrl+o        cycles tool display: one-line → full Input + Output preview → full Input + Output.
//                 Native tool renderers remain available below the raw I/O as a supplementary view.
//   ctrl+shift+o  folds settled turns (tools + intermediate prose) into one summary line each.
//   /cp           toggles copy mode: frames lose their side bars (rules above/below only) so a
//                 terminal mouse selection copies clean text. Not persisted; boxed on startup.
//
// Native expansion still goes through Pi's setters; local one-line visibility is display-only.
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, MouseRegion, Spacer, Text, getCapabilities, isKeyRelease, isKeyRepeat, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

import { assistantRendersNothing, captureTui, findChatContainer, isAssistantRow, isToolRow, type ContainerLike, type Renderable, type TuiLike } from "./chat.ts";
import { DOTTED, fitLine, frame, frameOverhead, MIN_FRAME_WIDTH, ROUNDED_DASHED, rule, SQUARE, trimBlankEdges, type FrameStyle } from "./frame.ts";
import { formatTokens, toolLine, type ToolStatus } from "./tool-line.ts";
import { computeFoldPlan, EMPTY_PLAN, formatSummary, type FoldPlan, type TurnFoldMode } from "./turn-fold.ts";
import { withTranscriptAnchor } from "./viewport.ts";

// ─── State (global so a reloaded module replaces state instead of re-wrapping prototypes) ────

type ToolMode = "oneLine" | "preview" | "native";
const TOOL_MODES: ToolMode[] = ["oneLine", "preview", "native"];
const TOOL_MODE_LABEL: Record<ToolMode, string> = { oneLine: "1-line", preview: "preview", native: "native" };

const CONFIG_ENTRY_TYPE = "pi-frame-config";
const STATUS_KEY = "pi-frame";
const CAPTURE_KEY = "pi-frame-capture";

interface ConfigEntry {
  toolMode?: ToolMode;
  foldMode?: TurnFoldMode;
}

interface State {
  theme: Theme | undefined;
  toolMode: ToolMode;
  /** Rows opened locally while the global tool mode remains oneLine. */
  openTools: WeakSet<ToolExecutionComponent>;
  foldMode: TurnFoldMode;
  /** "rules" = copy mode (/cp): no side bars anywhere. Session-local, never persisted. */
  frameStyle: FrameStyle;
  /** Agent is producing the last turn; that turn is never folded. */
  streaming: boolean;
  fold: FoldPlan;
  /** Tool rows whose previous visible sibling is also a tool row: render without the leading blank line. */
  tight: WeakSet<object>;
  chat: ContainerLike | undefined;
  tui: TuiLike | undefined;
  cwd: string;
  home: string;
  /** User prompt box metadata (sent time, model, thinking level), matched from session entries. */
  userMeta: WeakMap<object, UserMeta>;
  userMetaKey: string;
  branch: (() => readonly unknown[]) | undefined;
  liveThinking: (() => ThinkingLevel) | undefined;
}

interface Globals {
  state: State;
  originals: {
    toolRender: (this: ToolExecutionComponent, width: number) => string[];
    toolHandleMouse?: ToolExecutionComponent["handleMouse"];
    assistantRender: (this: AssistantMessageComponent, width: number) => string[];
    assistantUpdateContent: (this: AssistantMessageComponent, ...args: unknown[]) => void;
    customMessageRender: (this: CustomMessageComponent, width: number) => string[];
    bashExecutionRender: (this: BashExecutionComponent, width: number) => string[];
    userMessageRender?: (this: UserMessageComponent, width: number) => string[];
  };
  /** Re-pointed on every module evaluation so a /reload swaps in the new code. */
  hooks: { recomputePlan: (chat: ContainerLike) => void };
}

const GLOBAL_KEY = Symbol.for("pi-frame");
const g = globalThis as unknown as Record<symbol, Globals | undefined>;

function freshState(): State {
  return {
    theme: undefined,
    toolMode: "oneLine",
    openTools: new WeakSet(),
    foldMode: "expanded",
    frameStyle: "boxed",
    streaming: false,
    fold: EMPTY_PLAN,
    tight: new WeakSet(),
    chat: undefined,
    tui: undefined,
    cwd: process.cwd(),
    home: homedir(),
    userMeta: new WeakMap(),
    userMetaKey: "",
    branch: undefined,
    liveThinking: undefined,
  };
}

const globals: Globals = g[GLOBAL_KEY] ?? {
  state: freshState(),
  originals: {
    toolRender: ToolExecutionComponent.prototype.render,
    assistantRender: AssistantMessageComponent.prototype.render,
    assistantUpdateContent: AssistantMessageComponent.prototype.updateContent as Globals["originals"]["assistantUpdateContent"],
    customMessageRender: CustomMessageComponent.prototype.render,
    bashExecutionRender: BashExecutionComponent.prototype.render,
  },
  hooks: { recomputePlan: () => {} },
};
g[GLOBAL_KEY] = globals;
// Older pi-frame instances do not have this slot yet; preserve the native method across /reload.
globals.originals.toolHandleMouse ??= ToolExecutionComponent.prototype.handleMouse;
globals.originals.userMessageRender ??= UserMessageComponent.prototype.render;
globals.state = freshState();
globals.hooks.recomputePlan = (chat) => recomputePlan(chat);
const S = () => globals.state;

// ─── Paint helpers ──────────────────────────────────────────────────────────────────────────

type Paint = (text: string) => string;
type FgColor = Parameters<Theme["fg"]>[0];
type ThinkingLevel = Parameters<Theme["getThinkingBorderColor"]>[0];
interface UserMeta {
  at?: number;
  model?: string;
  thinking?: ThinkingLevel;
}

function fg(color: FgColor): Paint {
  const theme = S().theme;
  return theme ? (text) => theme.fg(color, text) : (text) => text;
}
function bold(): Paint {
  const theme = S().theme;
  return theme ? (text) => theme.bold(text) : (text) => text;
}
function italic(): Paint {
  const theme = S().theme;
  return theme ? (text) => theme.italic(text) : (text) => text;
}

// ─── Wrapper components for assistant content ───────────────────────────────────────────────

class Framed implements Renderable {
  readonly piFrameKind = "thinking";
  constructor(
    private readonly inner: Renderable,
    private readonly title: string,
  ) {}
  render(width: number): string[] {
    if (width < MIN_FRAME_WIDTH) return this.inner.render(width);
    const style = S().frameStyle;
    const lines = trimBlankEdges(this.inner.render(width - frameOverhead(style)));
    if (lines.length === 0) return [];
    const paint = fg("thinkingText");
    return frame(lines, width, { style, glyphs: ROUNDED_DASHED, paint, title: this.title, titlePaint: (t) => italic()(paint(t)) });
  }
  invalidate(): void {
    this.inner.invalidate?.();
  }
}

/** Assistant prose. boxed: `┃ text` accent bar. rules (copy mode): dotted rule above and below, no bar. */
class Rail implements Renderable {
  constructor(private readonly inner: Renderable) {}
  render(width: number): string[] {
    if (width < MIN_FRAME_WIDTH) return this.inner.render(width);
    const paint = fg("accent");
    if (S().frameStyle === "rules") {
      const lines = trimBlankEdges(this.inner.render(width));
      if (lines.length === 0) return [];
      return frame(lines, width, { style: "rules", glyphs: DOTTED, paint });
    }
    const bar = paint("┃");
    // Inner Markdown already carries paddingX=1, so `┃` + line reads as `┃ text`.
    return this.inner.render(width - 1).map((line) => bar + line);
  }
  invalidate(): void {
    this.inner.invalidate?.();
  }
}

class CollapsedThinking implements Renderable {
  readonly piFrameKind = "thinking";
  constructor(private readonly label: string) {}
  render(width: number): string[] {
    const paint = fg("thinkingText");
    return [" " + rule(Math.max(0, width - 1), ROUNDED_DASHED, paint, this.label.toLowerCase(), (t) => italic()(paint(t)))];
  }
  invalidate(): void {}
}

function isThinkingMarkdown(child: unknown): child is Markdown {
  return child instanceof Markdown && (child as unknown as { defaultTextStyle?: { italic?: boolean } }).defaultTextStyle?.italic === true;
}

function isHiddenThinkingLabel(child: unknown, label: string): child is Text {
  return child instanceof Text && typeof (child as unknown as { text?: string }).text === "string" && (child as unknown as { text: string }).text.includes(label);
}

/** pi ≥ 0.85 wraps thinking blocks in a MouseRegion (click toggles visibility); frame the child, keep the region. */
function frameInsideMouseRegion(region: unknown, label: string): boolean {
  if (!(region instanceof MouseRegion)) return false;
  const holder = region as unknown as { child: Renderable };
  if (isThinkingMarkdown(holder.child)) holder.child = new Framed(holder.child, "thinking");
  else if (isHiddenThinkingLabel(holder.child, label)) holder.child = new CollapsedThinking(label);
  else return false;
  // Fold logic (isThinkingRow) looks at the row itself, not the wrapped child.
  (region as unknown as { piFrameKind?: string }).piFrameKind = "thinking";
  return true;
}

// ─── Fold summary line ──────────────────────────────────────────────────────────────────────

function renderFoldSummary(row: object): string[] | undefined {
  const { fold } = S();
  if (!fold.hidden.has(row)) return undefined;
  const summary = fold.summary.get(row);
  if (!summary) return [];
  const text = `${fg("muted")("▶")} ${fg("dim")(formatSummary(summary))}`;
  return S().tight.has(row) ? [text] : ["", text];
}

// ─── Prototype patches ──────────────────────────────────────────────────────────────────────

interface OutputPart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface CachedToolOutput {
  parts: OutputPart[];
  showImages: boolean;
  imageProtocol: ReturnType<typeof getCapabilities>["images"];
  display: string;
  raw: string;
}

const outputCache = new WeakMap<ToolExecutionComponent, CachedToolOutput>();

function toolOutputs(component: ToolExecutionComponent): CachedToolOutput | undefined {
  const c = component as unknown as ToolDisplayState;
  if (!c.result) return undefined;
  const parts = c.result.content;
  const imageProtocol = getCapabilities().images;
  const cached = outputCache.get(component);
  // Snapshot field values, not result/content object identities: both can be mutated in place.
  // Unchanged string values take the cheap path without sanitizing every historical output again.
  if (cached && cached.showImages === c.showImages && cached.imageProtocol === imageProtocol &&
      cached.parts.length === parts.length && parts.every((part, i) => {
        const old = cached.parts[i]!;
        return part.type === old.type && part.text === old.text && part.data === old.data && part.mimeType === old.mimeType;
      })) return cached;

  const display = (component as unknown as { getTextOutput(): string }).getTextOutput();
  const raw = parts.filter((part) => part.type === "text")
    .map((part) => stripTerminalSequences(part.text ?? "").replace(/[\u0000-\u0008\u000B-\u001F\uFFF9-\uFFFB]/g, ""))
    .join("\n");
  const next: CachedToolOutput = {
    parts: parts.map(({ type, text, data, mimeType }) => ({ type, text, data, mimeType })),
    showImages: c.showImages,
    imageProtocol,
    display,
    raw,
  };
  outputCache.set(component, next);
  return next;
}

function toolStatus(component: ToolExecutionComponent): ToolStatus {
  const c = component as unknown as { isPartial: boolean; result?: { isError?: boolean } };
  if (c.isPartial) return "pending";
  return c.result?.isError ? "error" : "success";
}

interface ToolDisplayState {
  args: unknown;
  expanded: boolean;
  showImages: boolean;
  toolDefinition?: { renderCall?: unknown; renderResult?: unknown };
  result?: { content: OutputPart[] };
}

interface ToolDetailsView {
  input: Text;
  output: Text;
  inputText?: string;
  outputText?: string;
  width: number;
  offsetX: number;
  outputTop: number;
  outputBottom: number;
  nativeTop: number;
  nativeHeight: number;
}

const OUTPUT_PREVIEW_LINES = 10;
const toolDetails = new WeakMap<ToolExecutionComponent, ToolDetailsView>();
// Hit regions describe the rendered name only, never its padded column or argument summary.
const toolTitles = new WeakMap<ToolExecutionComponent, { x: number; y: number; width: number }>();

/** Raw I/O is display-only. Do not change the tool definition, renderer state, args, or result. */
function toolDetailLines(component: ToolExecutionComponent, width: number, offsetX: number, offsetY: number, output: string | undefined): string[] {
  const c = component as unknown as ToolDisplayState;
  let view = toolDetails.get(component);
  if (!view) {
    view = { input: new Text("", 1, 0), output: new Text("", 1, 0), width, offsetX, outputTop: 0, outputBottom: 0, nativeTop: 0, nativeHeight: 0 };
    toolDetails.set(component, view);
  }
  const heading = (label: string) => fg("muted")(bold()(label));
  let input: string;
  try {
    // Serialize on each render: streaming updates and tool hooks can mutate the same args object.
    input = JSON.stringify(c.args ?? {}, null, 2) ?? "{}";
  } catch {
    input = "[Input cannot be represented as JSON]";
  }
  const inputText = `${heading("Input")}\n${input}`;
  const outputLines = output ? output.split("\n") : [c.result ? "(no text output)" : "(waiting for output)"];
  const visible = c.expanded ? outputLines : outputLines.slice(0, OUTPUT_PREVIEW_LINES);
  const remaining = outputLines.length - visible.length;
  const previewHint = remaining > 0 ? `\n${fg("muted")(`… (${remaining} more lines; click Output to expand)`)}` : "";
  const outputText = `${heading("Output")}\n${visible.join("\n")}${previewHint}`;
  if (view.inputText !== inputText) {
    view.input.setText(inputText);
    view.inputText = inputText;
  }
  if (view.outputText !== outputText) {
    view.output.setText(outputText);
    view.outputText = outputText;
  }
  const inputRendered = view.input.render(width);
  const outputRendered = view.output.render(width);
  const lines = [...inputRendered, "", ...outputRendered];
  view.width = width;
  view.offsetX = offsetX;
  view.outputTop = offsetY + inputRendered.length + 1;
  view.outputBottom = view.outputTop + outputRendered.length;
  view.nativeTop = 0;
  view.nativeHeight = 0;

  // Native renderers may put a diff in the CALL slot, share state with the result slot,
  // or intentionally summarize/omit a result. Keep that view intact, not as a substitute
  // for raw I/O. Renderer-less tools need no duplicate fallback; images still need Pi.
  const hasNativeView = c.toolDefinition?.renderCall || c.toolDefinition?.renderResult || c.result?.content.some((part) => part.type === "image");
  if (hasNativeView) {
    const native = globals.originals.toolRender.call(component, width);
    if (native.length > 0) {
      lines.push("", ...new Text(heading("Tool view"), 1, 0).render(width));
      view.nativeTop = offsetY + lines.length;
      view.nativeHeight = native.length;
      // Keep native padding so mouse coordinates and image rows stay aligned.
      // A spread call hits Node's argument limit on large tool views; do not truncate the data.
      for (const line of native) lines.push(line);
    }
  }
  return lines;
}

function toolClickResult(component: ToolExecutionComponent, event: TuiMouseEvent): ReturnType<ToolExecutionComponent["handleMouse"]> {
  return {
    handled: true,
    render: true,
    target: {
      component,
      originX: event.screenX - event.x,
      originY: event.screenY - event.y,
      width: event.width,
      height: event.height,
    },
  };
}

function patchedToolHandleMouse(this: ToolExecutionComponent, event: TuiMouseEvent): ReturnType<ToolExecutionComponent["handleMouse"]> {
  const state = S();
  if (state.fold.hidden.has(this) || (this as unknown as { hideComponent: boolean }).hideComponent) return undefined;
  if (state.toolMode === "oneLine") {
    const title = toolTitles.get(this);
    if (title && event.type === "click" && event.button === "left" && !event.shift && !event.alt && !event.ctrl &&
        event.y === title.y && event.x >= title.x && event.x < title.x + title.width) {
      withTranscriptAnchor(state.tui, state.chat, () => {
        if (state.openTools.has(this)) state.openTools.delete(this);
        else {
          this.setExpanded(false); // Reopening starts at preview, independent of the last local Output toggle.
          state.openTools.add(this);
        }
      });
      return toolClickResult(this, event);
    }
    if (!state.openTools.has(this)) return undefined;
  }
  const view = toolDetails.get(this);
  if (!view || event.x < view.offsetX || event.x >= view.offsetX + view.width) return undefined;
  if (event.y >= view.nativeTop && event.y < view.nativeTop + view.nativeHeight) {
    return globals.originals.toolHandleMouse?.call(this, {
      ...event,
      x: event.x - view.offsetX,
      y: event.y - view.nativeTop,
      width: view.width,
      height: view.nativeHeight,
    });
  }
  const c = this as unknown as ToolDisplayState;
  if (c.result && event.type === "click" && event.button === "left" && event.y >= view.outputTop && event.y < view.outputBottom) {
    withTranscriptAnchor(state.tui, state.chat, () => this.setExpanded(!c.expanded));
    return toolClickResult(this, event);
  }
  return undefined;
}

function patchedToolRender(this: ToolExecutionComponent, width: number): string[] {
  toolTitles.delete(this);
  const folded = renderFoldSummary(this);
  if (folded) return folded;
  const state = S();
  const c = this as unknown as { hideComponent: boolean; toolName: string; args: unknown };
  if (c.hideComponent) return [];
  const compact = state.toolMode === "oneLine" && !state.openTools.has(this);
  const lead = compact && state.tight.has(this) ? [] : [""];
  const output = toolOutputs(this);
  if (compact) {
    const status = toolStatus(this);
    const line = toolLine(
      { toolName: c.toolName, args: c.args, status, output: output?.display, cwd: state.cwd, home: state.home },
      width,
      {
        glyph: fg(status === "error" ? "error" : status === "pending" ? "dim" : "accent"),
        name: (t) => bold()(fg("toolTitle")(t)),
        detail: fg("text"),
        meta: fg("muted"),
        error: fg("error"),
      },
    );
    toolTitles.set(this, { x: 2, y: lead.length, width: Math.max(0, Math.min(visibleWidth(c.toolName), width - 2)) });
    return [...lead, line];
  }
  if (width <= 0) return [];
  const style = state.frameStyle;
  const framed = width >= MIN_FRAME_WIDTH;
  const innerWidth = framed ? width - frameOverhead(style) : width;
  const name = bold()(fg("toolTitle")(c.toolName));
  // A locally opened row must retain a way back even when a full frame title does not fit.
  const plainTitle = !framed && state.toolMode === "oneLine" ? [truncateToWidth(name, width, "…")] : [];
  const lines = toolDetailLines(this, innerWidth, framed && style === "boxed" ? 1 : 0, lead.length + (framed ? 1 : plainTitle.length), output?.raw);
  if (!framed) {
    if (plainTitle.length) toolTitles.set(this, { x: 0, y: lead.length, width: visibleWidth(plainTitle[0]!) });
    return [...lead, ...plainTitle, ...lines];
  }
  const status = toolStatus(this);
  const paint = fg(status === "error" ? "error" : status === "pending" ? "borderMuted" : "border");
  const suffix = status === "pending" ? "" : status === "error" ? ` · ${fg("error")(`error ${formatTokens(output?.display)}`)}` : ` · ${fg("muted")(formatTokens(output?.display))}`;
  const fullTitle = name + suffix;
  const title = state.toolMode === "oneLine" ? truncateToWidth(fullTitle, width - 6, "…") : fullTitle;
  if (state.toolMode === "oneLine") {
    toolTitles.set(this, { x: 3, y: lead.length, width: Math.min(visibleWidth(c.toolName), width - 6) });
  }
  return [...lead, ...frame(lines, width, { style, glyphs: SQUARE, paint, title, titlePaint: (t) => t })];
}

function isThinkingRow(child: unknown): boolean {
  return (child as { piFrameKind?: string } | null)?.piFrameKind === "thinking";
}

function patchedAssistantRender(this: AssistantMessageComponent, width: number): string[] {
  const folded = renderFoldSummary(this);
  if (folded) return folded;
  if (!S().fold.stripThinking.has(this)) return globals.originals.assistantRender.call(this, width);
  // Render prose only: drop thinking frames and the spacer pi inserts right after each of them.
  const container = (this as unknown as { contentContainer: Container }).contentContainer;
  const all = container.children;
  const kept: typeof all = [];
  for (let i = 0; i < all.length; i++) {
    const child = all[i]!;
    if (isThinkingRow(child)) {
      if (all[i + 1] instanceof Spacer) i++;
      continue;
    }
    kept.push(child);
  }
  container.children = kept;
  try {
    return globals.originals.assistantRender.call(this, width);
  } finally {
    container.children = all;
  }
}

function patchedCustomMessageRender(this: CustomMessageComponent, width: number): string[] {
  return renderFoldSummary(this) ?? globals.originals.customMessageRender.call(this, width);
}

function patchedBashExecutionRender(this: BashExecutionComponent, width: number): string[] {
  return renderFoldSummary(this) ?? globals.originals.bashExecutionRender.call(this, width);
}

// ─── User prompt box: display-only, the prompt still travels Pi's native user-message path ──

const DOUBLE = { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" };
const OSC133_START = "\x1b]133;A\x07";
const OSC133_END = "\x1b]133;B\x07\x1b]133;C\x07";

function userEntryText(message: { content?: unknown }): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((b) => b?.type === "text").map((b) => b.text).join("");
}

/** Pair user rows with branch user entries in order; each gets its send time and the model/thinking level then in effect. */
function syncUserMeta(chat: ContainerLike): void {
  const state = S();
  if (!state.branch || !chat.children.some((r) => r instanceof UserMessageComponent && !state.userMeta.has(r))) return;
  let branch: readonly any[];
  try {
    branch = state.branch();
  } catch {
    return; // stale ctx after session replacement; the next session_start rebinds
  }
  // A user entry is appended after its row is first drawn; rescan only when the branch changes.
  const key = `${branch.length}:${branch.at(-1)?.id ?? ""}`;
  if (key === state.userMetaKey) return;
  state.userMetaKey = key;
  const metas: { text: string; meta: UserMeta }[] = [];
  let model: string | undefined;
  let thinking: ThinkingLevel | undefined;
  for (const e of branch) {
    if (e?.type === "model_change") model = e.modelId;
    else if (e?.type === "thinking_level_change") thinking = e.thinkingLevel;
    else if (e?.type === "message" && e.message?.role === "user") {
      metas.push({ text: userEntryText(e.message), meta: { at: e.message.timestamp ?? Date.parse(e.timestamp), model, thinking } });
    }
  }
  let next = 0;
  for (const row of chat.children) {
    if (!(row instanceof UserMessageComponent)) continue;
    const text = (row as unknown as { text: string }).text;
    let i = next;
    while (i < metas.length && metas[i]!.text !== text) i++;
    if (i === metas.length) continue;
    next = i + 1;
    if (!state.userMeta.has(row)) state.userMeta.set(row, metas[i]!.meta);
  }
}

function patchedUserMessageRender(this: UserMessageComponent, width: number): string[] {
  const state = S();
  const theme = state.theme;
  // UserMessageComponent → Box (userMessageBg) → Markdown. Render the Markdown alone: the frame replaces the background band.
  const body = (this as unknown as { children: { children?: Renderable[] }[] }).children[0]?.children?.[0];
  if (!theme || !body || width < MIN_FRAME_WIDTH) return globals.originals.userMessageRender!.call(this, width);

  const meta = state.userMeta.get(this) ?? {};
  const level = meta.thinking ?? state.liveThinking?.();
  const border: Paint = level ? theme.getThinkingBorderColor(level) : fg("border");
  const dim = fg("dim");
  const inner = width - 2;
  const time = meta.at
    ? new Date(meta.at).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";
  const iconSeg = `${border(`${DOUBLE.h}${DOUBLE.h} `)}${fg("text")("π")}${border(" ")}`; // 5 cols
  const timeSeg = time ? `${border(" ")}${dim(time)}${border(` ${DOUBLE.h}`)}` : "";
  const timeWidth = time ? time.length + 3 : 0;
  const top = border(DOUBLE.tl) + iconSeg + border(DOUBLE.h.repeat(Math.max(0, inner - 5 - timeWidth))) + timeSeg + border(DOUBLE.tr);
  const model = meta.model ? truncateToWidth(meta.model, Math.max(0, inner - 3), "…").replace(/\x1b\[0m/g, "") : "";
  const modelWidth = model ? visibleWidth(model) + 3 : 0;
  const modelSeg = model ? `${border(" ")}${dim(model)}${border(` ${DOUBLE.h}`)}` : "";
  const bottom = border(DOUBLE.bl) + border(DOUBLE.h.repeat(Math.max(0, inner - modelWidth))) + modelSeg + border(DOUBLE.br);

  // Copy mode (/cp) keeps the top and bottom rules but drops side bars so selections stay clean.
  const boxed = state.frameStyle === "boxed";
  const textWidth = boxed ? width - 4 : width;
  const lines = trimBlankEdges(body.render(textWidth)).map((line) =>
    boxed ? `${border(DOUBLE.v)} ${fitLine(line, textWidth)} ${border(DOUBLE.v)}` : line,
  );
  const out = [top, ...lines, bottom].map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
  out[0] = OSC133_START + out[0];
  out[out.length - 1] = OSC133_END + out[out.length - 1];
  return out;
}

function patchedAssistantUpdateContent(this: AssistantMessageComponent, ...args: unknown[]): void {
  globals.originals.assistantUpdateContent.apply(this, args);
  const c = this as unknown as { contentContainer: Container; hiddenThinkingLabel: string };
  const children = c.contentContainer.children as Renderable[];
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (frameInsideMouseRegion(child, c.hiddenThinkingLabel)) continue;
    if (isThinkingMarkdown(child)) children[i] = new Framed(child, "thinking");
    else if (child instanceof Markdown) children[i] = new Rail(child);
    else if (isHiddenThinkingLabel(child, c.hiddenThinkingLabel)) children[i] = new CollapsedThinking(c.hiddenThinkingLabel);
  }
}

function installPrototypePatches(): void {
  // Originals were captured once (globals.originals); re-pointing on every load keeps /reload effective.
  ToolExecutionComponent.prototype.render = patchedToolRender;
  ToolExecutionComponent.prototype.handleMouse = patchedToolHandleMouse;
  AssistantMessageComponent.prototype.render = patchedAssistantRender;
  AssistantMessageComponent.prototype.updateContent = patchedAssistantUpdateContent as typeof AssistantMessageComponent.prototype.updateContent;
  CustomMessageComponent.prototype.render = patchedCustomMessageRender;
  BashExecutionComponent.prototype.render = patchedBashExecutionRender;
  UserMessageComponent.prototype.render = patchedUserMessageRender;
}

// ─── Chat container hook: per-frame plan (fold + tight spacing), O(rows) ────────────────────

const NATIVE_STATUS_PREFIXES = ["Tool output:", "Thinking blocks:"];

/** pi appends dim "Tool output: …" / "Thinking blocks: …" rows to the transcript; the footer status covers both. */
function pruneNativeStatusRows(chat: ContainerLike): void {
  const rows = chat.children;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!(row instanceof Text)) continue;
    const text = (row as unknown as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    const plain = stripTerminalSequences(text);
    if (!NATIVE_STATUS_PREFIXES.some((p) => plain.startsWith(p))) continue;
    rows.splice(i, 1);
    if (rows[i - 1] instanceof Spacer) {
      rows.splice(i - 1, 1);
      i--;
    }
  }
}

function recomputePlan(chat: ContainerLike): void {
  const state = S();
  pruneNativeStatusRows(chat);
  syncUserMeta(chat);
  state.fold = state.foldMode === "compact" ? computeFoldPlan(chat, state.streaming) : EMPTY_PLAN;
  const tight = new WeakSet<object>();
  let prevIsTool = false;
  for (const row of chat.children) {
    const hidden = state.fold.hidden.has(row);
    const isSummary = hidden && state.fold.summary.has(row);
    if (hidden && !isSummary) continue;
    // Tool-call carriers render nothing; they must not break a run of tool rows.
    if (!isSummary && isAssistantRow(row) && assistantRendersNothing(row)) continue;
    const toolish = isToolRow(row) || isSummary;
    if (toolish && prevIsTool) tight.add(row);
    prevIsTool = toolish && (isSummary || !state.openTools.has(row as ToolExecutionComponent));
  }
  state.tight = tight;
}

function hookChatContainer(chat: ContainerLike): void {
  const marker = "__piFrameHooked";
  const holder = chat as unknown as Record<string, unknown>;
  if (holder[marker]) return;
  holder[marker] = true;
  const original = Container.prototype.render;
  holder.render = function (this: ContainerLike, width: number): string[] {
    globals.hooks.recomputePlan(this);
    return original.call(this as unknown as Container, width);
  };
}

// ─── Extension entry ────────────────────────────────────────────────────────────────────────

export default function piFrame(pi: ExtensionAPI): void {
  installPrototypePatches();
  let unsubscribeKeys: (() => void) | undefined;

  const updateStatus = (ctx: ExtensionContext) => {
    const state = S();
    const parts = [`frame ${TOOL_MODE_LABEL[state.toolMode]}`];
    if (state.foldMode === "compact") parts.push("folded");
    if (state.frameStyle === "rules") parts.push("copy");
    ctx.ui.setStatus(STATUS_KEY, parts.join(" · "));
  };

  const persist = (): void => {
    const { toolMode, foldMode } = S();
    pi.appendEntry<ConfigEntry>(CONFIG_ENTRY_TYPE, { toolMode, foldMode });
  };

  const applyToolMode = (ctx: ExtensionContext, mode: ToolMode): void => {
    const state = S();
    withTranscriptAnchor(state.tui, state.chat, () => {
      const changed = state.toolMode !== mode;
      state.toolMode = mode;
      if (changed) state.openTools = new WeakSet();
      ctx.ui.setToolsExpanded(mode === "native");
      // oneLine and preview both map to Pi's false. A real three-state mode change
      // must still clear per-row Output overrides when Pi's global setter is a no-op.
      if (changed) {
        for (const row of state.chat?.children ?? []) {
          if (isToolRow(row) && (row as unknown as ToolDisplayState).expanded !== (mode === "native")) row.setExpanded(mode === "native");
        }
      }
      updateStatus(ctx);
      state.tui?.requestRender();
    });
  };

  const restoreConfig = (ctx: ExtensionContext): void => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== CONFIG_ENTRY_TYPE) continue;
      const data = entry.data as ConfigEntry | undefined;
      if (data?.toolMode && TOOL_MODES.includes(data.toolMode)) S().toolMode = data.toolMode;
      if (data?.foldMode === "compact" || data?.foldMode === "expanded") S().foldMode = data.foldMode;
    }
  };

  const bind = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const state = S();
    state.theme = ctx.ui.theme;
    state.cwd = ctx.cwd;
    state.branch = () => ctx.sessionManager.getBranch();
    state.liveThinking = () => pi.getThinkingLevel();
    state.userMetaKey = "";
    const tui = captureTui(ctx.ui, CAPTURE_KEY);
    if (tui) {
      state.tui = tui;
      const chat = findChatContainer(tui);
      if (chat) {
        state.chat = chat;
        hookChatContainer(chat);
      }
    }
  };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    restoreConfig(ctx);
    S().streaming = false;
    bind(ctx);
    // Sync native expansion to the restored mode without announcing.
    ctx.ui.setToolsExpanded(S().toolMode === "native");
    updateStatus(ctx);
    // session_start fires again on /new and /resume; keep exactly one key listener alive.
    unsubscribeKeys?.();
    unsubscribeKeys = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "ctrl+o") || isKeyRelease(data) || isKeyRepeat(data)) return undefined;
      const next = TOOL_MODES[(TOOL_MODES.indexOf(S().toolMode) + 1) % TOOL_MODES.length]!;
      applyToolMode(ctx, next);
      persist();
      return { consume: true };
    });
    S().tui?.requestRender();
  });

  pi.on("agent_start", () => {
    S().streaming = true;
  });
  pi.on("agent_end", () => {
    S().streaming = false;
    S().tui?.requestRender();
  });

  pi.registerShortcut("ctrl+shift+o", {
    description: "pi-frame: fold/unfold settled turns",
    handler: (ctx) => {
      S().foldMode = S().foldMode === "compact" ? "expanded" : "compact";
      persist();
      updateStatus(ctx);
      S().tui?.requestRender();
    },
  });

  pi.registerCommand("cp", {
    description: "pi-frame: toggle copy mode (side bars off so mouse selection copies clean text)",
    handler: async (_args, ctx) => {
      const state = S();
      state.frameStyle = state.frameStyle === "rules" ? "boxed" : "rules";
      updateStatus(ctx);
      state.tui?.requestRender();
    },
  });

  pi.registerCommand("frame", {
    description: "pi-frame: set tool display (1-line | preview | native) or toggle fold",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      if (arg === "fold") {
        S().foldMode = S().foldMode === "compact" ? "expanded" : "compact";
      } else if (arg === "1-line" || arg === "oneLine") {
        applyToolMode(ctx, "oneLine");
      } else if (arg === "preview" || arg === "native") {
        applyToolMode(ctx, arg);
      } else {
        ctx.ui.notify("Usage: /frame 1-line | preview | native | fold", "info");
        return;
      }
      persist();
      updateStatus(ctx);
      S().tui?.requestRender();
    },
  });
}
