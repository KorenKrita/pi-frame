# pi-frame

Borders, tool inspection, and turn folding for Pi's terminal transcript.

## Tool display

`Ctrl+O` cycles through three modes:

| Mode | Display |
| --- | --- |
| `1-line` | Compact tool name, argument summary, and estimated output tokens. Long summaries may omit their middle. |
| `preview` | Complete **Input** as formatted JSON, plus the first 10 logical lines of **Output**. |
| `native` | Complete **Input** and **Output**. The historical mode name is retained for commands and saved sessions. |

The input is never shortened in either detailed mode. Output combines the text blocks Pi received from the tool; it cannot recover content already truncated by the tool itself. An empty result and a pending result have explicit placeholders.

For tools with custom renderers, a supplementary **Tool view** retains Pi's original call/result rendering, including code highlighting, edit diffs, and custom components. Images also stay on Pi's rendering path. This view can repeat information from the raw I/O; it is not used as a substitute for the actual inputs and outputs, because renderers may summarize or suppress those values. Its collapsed/expanded behavior remains controlled by the tool renderer.

The frame title retains Pi's display-text token estimate (including image placeholders when images are hidden), not input. The raw Output section itself contains only text blocks and never adds image placeholders.

Rendering does not change tool schemas, execution, stored arguments, or results, and does not append copies of input to model context.

## Settings: `/frame-settings`

First pick a page (prompt box, working loader, statusline, or tool display); each opens a settings menu (Chinese UI) with a live preview and applies on ⏎. Settings persist to `~/.pi/agent/pi-frame/prompt-loader.json` and `~/.pi/agent/pi-frame/statusline.json`; tool display is stored in the session, like `Ctrl+O`. On first run, existing `~/.pi/agent/pi-topping/settings.json` and `~/.pi/agent/pi-topping-statusline/settings.json` are used as the starting point.

## User prompt box

User messages render in a bordered box: icon top-left, send time top-right, provider/model bottom-right. Border style (double/single/rounded/heavy), border color (thinking level or a theme color), and each label are configurable. Time, model, and thinking level come from the session branch (`message`, `model_change`, `thinking_level_change` entries), so resumed sessions keep their original labels. For the brief moment before a new prompt's entry is saved, the box has no labels and uses the current thinking level.

This is display-only. The prompt still goes through Pi's native user-message path, so `before_agent_start` and extensions that read user messages (memory plugins, for example) are unaffected. Copy mode drops the side bars; widths under 16 columns fall back to Pi's native rendering. Prompt boxes recorded by pi-topping (`pi-topping-prompt` messages) still render in old sessions.

## Working loader

While Pi works, the loader line shows an animated spinner, a random activity word, a shimmer, a token activity meter, the token rate, elapsed time, output tokens, and the response model when it differs from the selected one. Every element can be toggled, recolored, and reordered. Activity words come from pi-frame's own Chinese list (`loader/words.ts`) plus optional Chinese word packs (AI 娘, 二次元, 程序员黑话, 甄嬛传 in `loader/wordpacks/`, all off by default), or your own in `~/.pi/agent/pi-frame/word-packs.json`. pi-topping's English packs are not shipped.

The loader and prompt box are adapted from [pi-topping](https://github.com/underactive/pi-topping) (MIT, see `loader/LICENSE`). Unlike pi-topping, pi-frame never intercepts `input` and has no completion marker.

## Statusline

The editor is wrapped in a box whose borders carry segment groups: Pi symbol, model, provider, thinking level, path, git, PR (top left); token rate and session name (top right); feeds, token rate, Pi stats, context bar and stats (bottom right); scroll hint (bottom left). Separator, symbol set, border style, transparency, the rainbow border at max thinking, and embedding Pi's status spinners in the border are configurable. Feeds show numbers other extensions publish as custom entries (seeded with pi-prompt-cache's savings).

Ported from [pi-topping-statusline](https://github.com/underactive/pi-topping-statusline) (MIT, itself a port of oh-my-pi's statusline; see `statusline/LICENSE`).

## Controls

- `Ctrl+O`: cycle the global tool mode. In fullscreen mode the current reading row stays anchored; a viewport already following the bottom continues following it.
- `/frame-settings` → 工具显示: select a tool mode (1-line, preview, native) and fold state directly.
- `Ctrl+Shift+O`: fold/unfold settled tool activity and intermediate prose.
- `Ctrl+T`: Pi's native thinking toggle.
- `/cp`: toggle copy mode, removing frame side bars so terminal text selection does not copy them.
- In `1-line`, click the **tool name** to open only that tool's Input and Output preview. Click its title name again to close it. Pending tools can be opened to inspect their Input too.
- Only an unmodified left click on the name opens a compact row. Its argument summary and padded name column remain available for text selection; dragging does not toggle it.
- Click a raw Output block to toggle its preview. Native tool-view mouse targets remain aligned beneath the raw I/O.

Per-row clicks are local to the current view: selecting the same global mode again does not reset a row. Changing to a different global mode resets local openings and Output overrides, including the `1-line` → `preview` transition. Reopening a tool by name always starts at preview.

Tool and fold modes persist in the session. Copy mode resets on startup.

After changing the extension, use Pi's `/reload` when no background jobs need to survive; other installed extensions may stop their jobs during reload. Restarting Pi also loads the new version.

## Verification

Run from this directory with the locally installed Pi packages resolved by `tsconfig.json`:

```bash
bun test
JITI_FS_CACHE=0 node test/node-render.mjs
bun test/smoke.ts
```

The automated regression suite uses Pi's real `ToolExecutionComponent`, registered tools without renderers, native write/edit renderers, custom mouse regions, and Kitty image output. It covers the three-mode cycle, long/multiblock output, mutable streaming updates, caching, text/image separation, errors, reload, folding, copy mode, and narrow widths. The Node script also exercises Pi's actual jiti loader/reload, a 150,000-line custom result, and warm-cache redraws of 100 tools with 50 KB of output each. `test/smoke.ts` is an additional visual transcript dump, not an assertion-based test.

The fullscreen interaction tests use Pi's real `TuiAltScreen`, `ScrollView`, chat viewport, and stable TUI reference with a memory-backed terminal. They inject keyboard and SGR mouse reports to check reading-position preservation, bottom following, local name/Output clicks, and drag selection. No tool commands are executed.

This extension reads Pi's internal component layout and is currently validated against Pi 0.85.1. Recheck it after upgrading Pi.
