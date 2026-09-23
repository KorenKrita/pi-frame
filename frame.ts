// Pure box-drawing helpers. No pi state, no side effects.
//
// Two frame styles share one API:
//   boxed  — `┌─ title ─┐ │ body │ └───┘`: full border, side bars on every body line.
//   rules  — `┄┄ title ┄┄ / body / ┄┄┄┄`: only a top and bottom rule, no side bars. Side bars are
//            real terminal cells and end up in a mouse selection; rules stay on the boundary
//            lines, so a body selection copies clean text.
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type Paint = (text: string) => string;
export const identity: Paint = (text) => text;

export type FrameStyle = "boxed" | "rules";

export interface FrameGlyphs {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}

export const SQUARE: FrameGlyphs = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };
export const ROUNDED_DASHED: FrameGlyphs = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "┄", v: "┆" };
export const DOTTED: FrameGlyphs = { tl: "┈", tr: "┈", bl: "┈", br: "┈", h: "┈", v: "┈" };

/** Columns the frame takes from the body: boxed `│` + ` │`, rules none (body keeps its own paddingX). */
export function frameOverhead(style: FrameStyle): number {
  return style === "boxed" ? 3 : 0;
}
/** Below this width framing hurts more than it helps; callers fall back to raw lines. */
export const MIN_FRAME_WIDTH = 16;

export function isBlankLine(line: string): boolean {
  return stripTerminalSequences(line).trim().length === 0;
}

/** Drop leading/trailing blank lines (Box paddingY, leading Spacer). */
export function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlankLine(lines[start]!)) start++;
  while (end > start && isBlankLine(lines[end - 1]!)) end--;
  return lines.slice(start, end);
}

/** Pad or truncate a (possibly ANSI-styled) line to exactly `width` columns. */
export function fitLine(line: string, width: number): string {
  return truncateToWidth(line, width, "…", true);
}

export interface FrameOptions {
  style: FrameStyle;
  glyphs: FrameGlyphs;
  paint: Paint;
  title?: string;
  titlePaint?: Paint;
}

/** `┌─ title ───┐` — a full-width top rule; falls back to a plain rule if the title does not fit. */
export function topRule(width: number, { glyphs, paint, title, titlePaint }: FrameOptions): string {
  const plain = paint(glyphs.tl + glyphs.h.repeat(Math.max(0, width - 2)) + glyphs.tr);
  if (!title) return plain;
  const label = ` ${title} `;
  const rest = width - 3 - visibleWidth(label);
  if (rest < 1) return plain;
  return paint(glyphs.tl + glyphs.h) + (titlePaint ?? paint)(label) + paint(glyphs.h.repeat(rest) + glyphs.tr);
}

/** `┄┄ label ┄┄┄┄┄` — a full-width rule with an optional label; plain rule if the label does not fit. */
export function rule(width: number, glyphs: FrameGlyphs, paint: Paint, label?: string, labelPaint?: Paint): string {
  const plain = paint(glyphs.h.repeat(Math.max(0, width)));
  if (!label) return plain;
  const text = ` ${label} `;
  const rest = width - 2 - visibleWidth(text);
  if (rest < 1) return plain;
  return paint(glyphs.h + glyphs.h) + (labelPaint ?? paint)(text) + paint(glyphs.h.repeat(rest));
}

/** Wrap already-rendered lines in a frame. Lines must have been rendered at `width - frameOverhead(style)`. */
export function frame(lines: string[], width: number, opts: FrameOptions): string[] {
  if (width < MIN_FRAME_WIDTH) return lines;
  if (opts.style === "rules") {
    return [rule(width, opts.glyphs, opts.paint, opts.title, opts.titlePaint), ...lines, rule(width, opts.glyphs, opts.paint)];
  }
  const inner = width - frameOverhead("boxed");
  const side = opts.paint(opts.glyphs.v);
  const body = lines.map((line) => `${side}${fitLine(line, inner)} ${side}`);
  const bottom = opts.paint(opts.glyphs.bl + opts.glyphs.h.repeat(width - 2) + opts.glyphs.br);
  return [topRule(width, opts), ...body, bottom];
}
