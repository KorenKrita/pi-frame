// viewport.ts — keep the reader's place in the fullscreen transcript across a re-layout.
//
// Pi's fullscreen ScrollView remembers a line number, not a place in the document. When a
// display change re-flows rows above the viewport (Ctrl+O switching every tool row from one
// line to a full frame, a fold, a click that expands one tool), the same scrollTop now points
// at different content and the reader loses their place. This helper records which chat row
// (or header/resources block) is under the first viewport line, plus its in-row offset, and
// restores that place after the change.
//
// Positions come from the containers' own `mouseLayout` (filled by Container.render on every
// frame, at the width the transcript was rendered), so they match what the layout engine
// produced. After the change the *document* is rendered once at that width: this runs
// pi-frame's chat.render hook (fold/tight recomputation), refreshes every mouseLayout, and
// accounts for header/loaded-resources rows above the chat changing height. The ScrollView's
// bounds are then updated to the new content height before scrolling, so scrollTo() clamps
// against the new layout rather than the old one.
//
// Restoring never turns follow-end on: the reader was scrolled up, and landing on the last
// line by coincidence must not start auto-scrolling (`disableFollow`). Pi clears that
// suppression as soon as the viewport is no longer at the end.
//
// No-op (change still runs) when: the TUI is not a viewport TUI (regular mode), no chat is
// known, no layout has been computed yet, or the transcript is following its end.
//
// Read-only over pi internals except ScrollView.updateLayout()/scrollTo() on the transcript.
import { isViewportTUI, type ScrollView, type TUI } from "@earendil-works/pi-tui";

import type { ContainerLike, Renderable } from "./chat.ts";

interface MouseLayoutEntry {
  component: Renderable;
  height: number;
}

interface WithMouseLayout extends Renderable {
  children?: Renderable[];
  mouseLayout?: { width: number; children: MouseLayoutEntry[] };
}

interface LayoutBoxLike {
  component?: unknown;
  children?: LayoutBoxLike[];
  scrollView?: unknown;
}

interface AltScreenInternals {
  currentLayout?: { root: LayoutBoxLike; primaryScrollView?: ScrollView };
  getPrimaryScrollView?: () => ScrollView;
  requestRender?: () => void;
}

interface Anchor {
  tui: AltScreenInternals;
  scrollView: ScrollView;
  /** The ScrollView's child: pi's documentContainer. */
  document: WithMouseLayout;
  /** Chat rows, or document-level blocks while reading the header/resources. */
  container: WithMouseLayout;
  /** Siblings at anchor time; used to find a survivor when the row is gone. */
  order: Renderable[];
  index: number;
  /** Lines into the row at the first viewport line. */
  offset: number;
  width: number;
}

function findScrollBox(box: LayoutBoxLike | undefined, scrollView: unknown): LayoutBoxLike | undefined {
  if (!box) return undefined;
  if (box.scrollView === scrollView) return box;
  for (const child of box.children ?? []) {
    const hit = findScrollBox(child, scrollView);
    if (hit) return hit;
  }
  return undefined;
}

/** Line offset of `target` inside `root`, summing last-frame mouseLayout heights through nested containers. */
function offsetWithin(root: WithMouseLayout, target: Renderable): number | undefined {
  if (root === target) return 0;
  const rows = root.mouseLayout?.children;
  if (!rows) return undefined;
  let y = 0;
  for (const entry of rows) {
    const inner = offsetWithin(entry.component as WithMouseLayout, target);
    if (inner !== undefined) return y + inner;
    y += entry.height;
  }
  return undefined;
}

function takeAnchor(tui: unknown, chat: WithMouseLayout | undefined): Anchor | undefined {
  if (!chat || !tui || typeof tui !== "object") return undefined;
  if (!isViewportTUI(tui as TUI)) return undefined;
  const internals = tui as unknown as AltScreenInternals;
  const layout = internals.currentLayout;
  if (!layout) return undefined;
  const scrollView = layout.primaryScrollView ?? internals.getPrimaryScrollView?.();
  if (!scrollView || scrollView.isFollowingEnd) return undefined;

  const document = findScrollBox(layout.root, scrollView)?.children?.[0]?.component as WithMouseLayout | undefined;
  if (!document) return undefined;
  const chatTop = offsetWithin(document, chat);
  if (chatTop === undefined) return undefined;
  // Global tool expansion also changes Pi's header and loaded resources. Anchor those
  // blocks by identity too, rather than leaving an absolute scrollTop in the old layout.
  const container = scrollView.scrollTop < chatTop ? document : chat;
  const rows = container.mouseLayout;
  if (!rows) return undefined;
  const target = scrollView.scrollTop - (container === chat ? chatTop : 0);

  const order = rows.children.map((entry) => entry.component);
  let y = 0;
  for (let index = 0; index < rows.children.length; index++) {
    const height = rows.children[index]!.height;
    if (target < y + height) {
      return { tui: internals, scrollView, document, container, order, index, offset: Math.max(0, target - y), width: rows.width };
    }
    y += height;
  }
  // First viewport line is below the last chat row (trailing spacer): nothing to anchor.
  return undefined;
}

function restoreAnchor(anchor: Anchor): void {
  const { container } = anchor;
  const live = new Set<Renderable>(container.children ?? []);
  // The anchored row, or the first row after it that still exists.
  let row: Renderable | undefined;
  let offset = anchor.offset;
  for (let i = anchor.index; i < anchor.order.length; i++) {
    const candidate = anchor.order[i]!;
    if (live.has(candidate)) {
      row = candidate;
      if (i !== anchor.index) offset = 0;
      break;
    }
  }
  if (!row) return;

  // One document render at the transcript width: runs pi-frame's chat hook, refreshes
  // every mouseLayout, and yields the new content height. The next frame renders the same.
  const contentHeight = anchor.document.render(anchor.width).length;
  const containerTop = offsetWithin(anchor.document, container);
  const rows = container.mouseLayout?.children;
  if (containerTop === undefined || !rows) return;
  let top = 0;
  let rowHeight = 0;
  for (const entry of rows) {
    if (entry.component === row) {
      rowHeight = entry.height;
      break;
    }
    top += entry.height;
  }
  const clampedOffset = Math.min(offset, Math.max(0, rowHeight - 1));

  const { scrollView } = anchor;
  scrollView.updateLayout(contentHeight, scrollView.viewportHeight, () => anchor.tui.requestRender?.());
  const target = containerTop + top + clampedOffset;
  // Clamping can put a still-visible row below the first viewport line. It does not mean
  // the reader chose to follow new output, even when all current content fits on screen.
  scrollView.scrollTo(target, { disableFollow: true });
}

/**
 * Run `change` while keeping the chat row (or header/resources block) under the first
 * viewport line at the same on-screen position. Falls back to plain `change()` in regular
 * mode, before the first layout, or when the transcript is following its end.
 */
export function withTranscriptAnchor<T>(tui: unknown, chat: ContainerLike | undefined, change: () => T): T {
  const anchor = takeAnchor(tui, chat as WithMouseLayout | undefined);
  const result = change();
  if (anchor) restoreAnchor(anchor);
  return result;
}
