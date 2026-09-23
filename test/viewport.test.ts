// Drives the *real* TuiAltScreen + ScrollView + layout engine from the installed pi-tui.
// The transcript ScrollView lives in the layout root (not in `tui.children`), exactly as
// interactive-mode builds it via createChatViewport.
import { describe, expect, test } from "bun:test";
import { Container, ScrollView, Text, TuiAltScreen, VStack } from "@earendil-works/pi-tui";

import { withTranscriptAnchor } from "../viewport.ts";

/** Output sink: layout is computed by the TUI, terminal bytes are irrelevant here. */
class SinkTerminal {
  private onInput: ((data: string) => void) | undefined;
  constructor(
    public columns = 80,
    public rows = 24,
  ) {}
  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.onInput = onInput;
  }
  stop(): void {
    this.onInput = undefined;
  }
  async drainInput(): Promise<void> {}
  write(_data: string): void {}
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  sendInput(data: string): void {
    this.onInput?.(data);
  }
}

/** A chat row with a settable height; rendered lines carry the row id and line index. */
class Row extends Container {
  constructor(
    readonly id: string,
    public height: number,
  ) {
    super();
  }
  override render(_width: number): string[] {
    return Array.from({ length: this.height }, (_, i) => `${this.id}:${i}`);
  }
}

const DOCK_ROWS = 2;

async function mount(rowHeights: number[], rows = 12, headerHeight = 0) {
  const terminal = new SinkTerminal(80, rows);
  const tui = new TuiAltScreen(terminal);
  const chat = new Container();
  const rowsById = new Map<string, Row>();
  rowHeights.forEach((h, i) => {
    const row = new Row(`r${i}`, h);
    rowsById.set(row.id, row);
    chat.addChild(row);
  });
  // interactive-mode: documentContainer = Container[header, loadedResources, chat]
  const header = new Row("header", headerHeight);
  const document = new Container();
  document.addChild(header);
  document.addChild(new Container());
  document.addChild(chat);
  const transcript = new ScrollView(document, { follow: "end", primary: true, overscroll: "chain" });
  const dock = new VStack([new Text("editor", 0, 0), new Text("footer", 0, 0)]);
  tui.setLayoutRoot(
    new VStack([
      { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
    ]),
  );
  tui.start();
  tui.renderNow();
  const viewportHeight = rows - DOCK_ROWS;
  const row = (id: string) => rowsById.get(id)!;
  /** Absolute document line of the first line of `id`, from the live tree (header included). */
  const topOf = (id: string) => {
    let y = header.height;
    for (const child of chat.children as Row[]) {
      if (child.id === id) return y;
      y += child.height;
    }
    throw new Error(`no row ${id}`);
  };
  /** Document line shown on the first viewport row. */
  const firstVisible = () => (tui as unknown as { getPrimaryScrollView(): ScrollView }).getPrimaryScrollView().scrollTop;
  return { tui, chat, header, transcript, terminal, viewportHeight, row, topOf, firstVisible };
}

describe("withTranscriptAnchor (real TuiAltScreen + ScrollView)", () => {
  test("scrolled away from the end: the row under the first viewport line keeps its on-screen offset when rows above it grow", async () => {
    const m = await mount([5, 5, 5, 5, 5, 5, 5, 5]); // 40 lines, viewport 10
    m.transcript.scrollTo(17); // first visible = r3 line 2
    m.tui.renderNow();
    expect(m.firstVisible()).toBe(17);
    expect(m.transcript.isFollowingEnd).toBe(false);

    withTranscriptAnchor(m.tui, m.chat, () => {
      m.row("r0").height = 25; // +20 lines above the anchor
      m.row("r1").height = 1; // -4 lines above the anchor
    });
    m.tui.renderNow();

    // r3 still starts at the same viewport row; still line 2 of r3 on the first row.
    expect(m.firstVisible()).toBe(m.topOf("r3") + 2);
    expect(m.transcript.isFollowingEnd).toBe(false);
    m.tui.stop();
  });

  test("the anchored row itself shrinks below the in-row offset: offset is clamped to the row's last line", async () => {
    const m = await mount([5, 5, 5, 5, 5, 5, 5, 5]);
    m.transcript.scrollTo(19); // r3 line 4
    m.tui.renderNow();

    withTranscriptAnchor(m.tui, m.chat, () => {
      m.row("r3").height = 2; // only lines 0..1 remain
      m.row("r0").height = 12; // shift everything, so the clamp is visible
    });
    m.tui.renderNow();

    expect(m.firstVisible()).toBe(m.topOf("r3") + 1);
    m.tui.stop();
  });

  test("content shrinks to fit the viewport: clamping must not resume follow or let later output steal the reading position", async () => {
    const m = await mount([5, 5, 5, 5, 5, 5, 5, 5]);
    m.transcript.scrollTo(25); // r5 line 0
    m.tui.renderNow();

    withTranscriptAnchor(m.tui, m.chat, () => {
      for (const id of ["r0", "r1", "r2", "r3", "r4", "r5"]) m.row(id).height = 1;
      m.row("r6").height = 2;
      m.row("r7").height = 2; // total 10 = viewport height
    });
    m.tui.renderNow();

    expect(m.firstVisible()).toBe(0);
    expect(m.transcript.isFollowingEnd).toBe(false);
    m.row("r7").height = 20;
    m.tui.renderNow();
    expect(m.firstVisible()).toBe(0);
    m.tui.stop();
  });

  test("following the end: no anchor is taken, follow stays on and the view shows the new end", async () => {
    const m = await mount([5, 5, 5, 5, 5, 5, 5, 5]);
    expect(m.transcript.isFollowingEnd).toBe(true);
    expect(m.firstVisible()).toBe(30);

    withTranscriptAnchor(m.tui, m.chat, () => {
      m.row("r7").height = 30;
    });
    m.tui.renderNow();

    expect(m.transcript.isFollowingEnd).toBe(true);
    expect(m.firstVisible()).toBe(65 - 10);
    m.tui.stop();
  });

  test("anchor row was removed from the chat: falls back to the next surviving row", async () => {
    const m = await mount([5, 5, 5, 5, 5, 5, 5, 5]);
    m.transcript.scrollTo(16); // r3 line 1
    m.tui.renderNow();

    withTranscriptAnchor(m.tui, m.chat, () => {
      m.chat.removeChild(m.row("r3"));
      m.row("r0").height = 15;
    });
    m.tui.renderNow();

    expect(m.firstVisible()).toBe(m.topOf("r4"));
    m.tui.stop();
  });

  test("clamping near the end keeps follow off even when the anchor can no longer occupy the first viewport line", async () => {
    const m = await mount([5, 5, 5, 5, 5, 5, 5, 5]);
    m.transcript.scrollTo(25); // r5 line 0, not following the end
    m.tui.renderNow();
    withTranscriptAnchor(m.tui, m.chat, () => {
      for (const id of ["r5", "r6", "r7"]) m.row(id).height = 1;
    });
    m.tui.renderNow();
    const clamped = m.firstVisible();
    expect(clamped).toBe(18); // total 28 minus viewport 10; r5 is still visible
    expect(m.transcript.isFollowingEnd).toBe(false);
    m.row("r7").height = 30;
    m.tui.renderNow();
    expect(m.firstVisible()).toBe(clamped);
    m.tui.stop();
  });

  test("reading the document header does not jump down to the first chat row", async () => {
    const m = await mount([5, 5, 5, 5], 12, 3);
    m.transcript.scrollTo(1);
    m.tui.renderNow();
    withTranscriptAnchor(m.tui, m.chat, () => { m.row("r0").height = 20; });
    m.tui.renderNow();
    expect(m.firstVisible()).toBe(1);
    expect(m.transcript.isFollowingEnd).toBe(false);
    m.tui.stop();
  });

  test("a shrinking header keeps its reading position inside the surviving header", async () => {
    const m = await mount([5, 5, 5, 5, 5, 5, 5, 5], 12, 20);
    m.transcript.scrollTo(15); // HEADER:15, not a chat row
    m.tui.renderNow();
    withTranscriptAnchor(m.tui, m.chat, () => { m.header.height = 3; });
    m.tui.renderNow();
    expect(m.firstVisible()).toBe(2); // last surviving header line
    expect(m.transcript.isFollowingEnd).toBe(false);
    m.tui.stop();
  });

  test("reading the header stays non-following after the document shrinks to one screen", async () => {
    const m = await mount([5, 5, 5, 5], 12, 20);
    m.transcript.scrollTo(1);
    m.tui.renderNow();
    withTranscriptAnchor(m.tui, m.chat, () => {
      m.header.height = 3;
      for (const id of ["r0", "r1", "r2", "r3"]) m.row(id).height = 1;
    });
    m.tui.renderNow();
    expect(m.firstVisible()).toBe(0);
    expect(m.transcript.isFollowingEnd).toBe(false);
    m.row("r3").height = 25;
    m.tui.renderNow();
    expect(m.firstVisible()).toBe(0);
    m.tui.stop();
  });

  test("rows above the chat (header / loaded resources) change height too: the anchor accounts for them", async () => {
    const m = await mount([5, 5, 5, 5, 5, 5, 5, 5], 12, 3);
    m.transcript.scrollTo(m.topOf("r3") + 2);
    m.tui.renderNow();

    withTranscriptAnchor(m.tui, m.chat, () => {
      m.header.height = 11;
      m.row("r1").height = 9;
    });
    m.tui.renderNow();

    expect(m.firstVisible()).toBe(m.topOf("r3") + 2);
    m.tui.stop();
  });

  test("the chat container's render hook (fold/tight recomputation) runs before positions are measured", async () => {
    const m = await mount([5, 5, 5, 5, 5, 5, 5, 5]);
    m.transcript.scrollTo(17); // r3 line 2
    m.tui.renderNow();
    // pi-frame replaces chat.render with a hook that recomputes the plan and then renders.
    // Here the hook decides r0 is folded to a single line; the rows do not know about it.
    const original = Container.prototype.render;
    let hookRuns = 0;
    (m.chat as unknown as { render: (w: number) => string[] }).render = function (this: Container, width: number) {
      hookRuns++;
      m.row("r0").height = 1;
      return original.call(this, width);
    };

    withTranscriptAnchor(m.tui, m.chat, () => {
      m.row("r0").height = 40; // would be the height without the hook
    });
    expect(hookRuns).toBeGreaterThan(0);
    m.tui.renderNow();

    expect(m.firstVisible()).toBe(m.topOf("r3") + 2); // r0 is 1 line, as the hook decided
    m.tui.stop();
  });

  test("restored position happens to be the new last line: follow stays off, later growth does not pull the view down", async () => {
    const m = await mount([5, 5, 5, 5, 5, 5, 5, 5]);
    m.transcript.scrollTo(15); // r3 line 0
    m.tui.renderNow();

    withTranscriptAnchor(m.tui, m.chat, () => {
      // r3..r7 collapse to exactly one viewport: r3 starts at the new maximum scrollTop.
      for (const id of ["r4", "r5", "r6", "r7"]) m.row(id).height = 1;
      m.row("r3").height = 6;
    });
    m.tui.renderNow();
    expect(m.firstVisible()).toBe(m.topOf("r3"));
    expect(m.transcript.isFollowingEnd).toBe(false);

    m.row("r7").height = 20; // new output arrives
    m.tui.renderNow();
    expect(m.firstVisible()).toBe(m.topOf("r3"));
    m.tui.stop();
  });

  test("regular (non-viewport) TUI or missing chat: the change still runs and nothing throws", () => {
    let ran = 0;
    const plain = Object.assign(new Container(), { requestRender() {} });
    expect(withTranscriptAnchor(plain, new Container(), () => ++ran)).toBe(1);
    expect(withTranscriptAnchor(undefined, undefined, () => ++ran)).toBe(2);
    expect(withTranscriptAnchor(plain, undefined, () => ++ran)).toBe(3);
  });

  test("fullscreen TUI whose layout has not been computed yet: the change runs, scroll state is untouched", async () => {
    const terminal = new SinkTerminal(80, 12);
    const tui = new TuiAltScreen(terminal);
    const chat = new Container();
    chat.addChild(new Row("r0", 30));
    const transcript = new ScrollView(chat, { follow: "end", primary: true });
    tui.setLayoutRoot(new VStack([{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 }]));
    // no start(), no render: currentLayout undefined
    let ran = false;
    withTranscriptAnchor(tui, chat, () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(transcript.scrollTop).toBe(0);
  });
});
