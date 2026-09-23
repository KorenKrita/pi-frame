/**
 * The statusline page of /frame-settings: menu sections for the settings
 * model, a live preview that renders the real box bars with the un-applied
 * menu values, and the page opener.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { makeBoxPainters, renderBoxRow } from "./box.js";
import type { SegmentContextBuilder } from "./context.js";
import { buildStatusLine } from "./layout.js";
import { showMenu, type MenuSection, type MenuValue, type PreviewResult } from "./menu.js";
import { NvidiaGreenBorder, isSwitchyardProvider } from "./nvidia-green.js";
import { RAINBOW_CYCLE_MS, RAINBOW_FRAME_MS, RainbowBorder } from "./rainbow.js";
import {
	applySettings,
	BORDER_STYLES,
	DEFAULT_FEEDS,
	DEFAULT_SEGMENTS,
	FEED_FORMATS,
	resolveEffectiveSettings,
	saveSettings,
	sanitizeFeeds,
	SEPARATORS,
	topLeftSegments,
	type SettingsState,
} from "./settings.js";
import { theme, type BorderStyle, type SymbolPreset } from "./theme.js";
import type {
	FeedFormat,
	SegmentContext,
	SegmentIncludes,
	StatusLineFeed,
	StatusLineSegmentToggles,
	StatusLineSeparatorStyle,
	StatusLineSettings,
} from "./types.js";

const SYMBOL_LABELS: Record<SymbolPreset, string> = { nerd: "nerdfont", unicode: "unicode", ascii: "ascii" };
const SYMBOL_VALUES: readonly string[] = Object.values(SYMBOL_LABELS);
const SYMBOL_FROM_LABEL: Record<string, SymbolPreset> = Object.fromEntries(
	(Object.entries(SYMBOL_LABELS) as [SymbolPreset, string][]).map(([preset, label]) => [label, preset]),
);

const SECTION_TITLES = ["左上分组", "右上分组", "右下分组", "左下分组"] as const;

const SEGMENT_ROWS: readonly {
	id: keyof StatusLineSegmentToggles;
	label: string;
	section: (typeof SECTION_TITLES)[number];
}[] = [
	{ id: "pi", label: "Pi 图标", section: "左上分组" },
	{ id: "model", label: "模型", section: "左上分组" },
	{ id: "provider", label: "服务商", section: "左上分组" },
	{ id: "thinking", label: "思考级别", section: "左上分组" },
	{ id: "path", label: "路径", section: "左上分组" },
	{ id: "git", label: "Git", section: "左上分组" },
	{ id: "pr", label: "PR", section: "左上分组" },
	{ id: "tokenRateTopRight", label: "Token 速率", section: "右上分组" },
	{ id: "sessionName", label: "会话名", section: "右上分组" },
	{ id: "feeds", label: "数据源", section: "右下分组" },
	{ id: "tokenRate", label: "Token 速率", section: "右下分组" },
	{ id: "piStats", label: "Pi 统计", section: "右下分组" },
	{ id: "contextBar", label: "上下文进度条", section: "右下分组" },
	{ id: "contextStats", label: "上下文统计", section: "右下分组" },
	{ id: "scrollHint", label: "滚动提示", section: "左下分组" },
	{ id: "feedsBottomLeft", label: "数据源", section: "左下分组" },
	{ id: "tokenRateBottomLeft", label: "Token 速率", section: "左下分组" },
];

// Feed rows are addressed by index so a rebuild can drop one cleanly.
const FEED_PREFIX = "feed";
const feedKey = (index: number, part: keyof StatusLineFeed) => `${FEED_PREFIX}.${index}.${part}`;
const ADD_FEED_ID = `${FEED_PREFIX}.add`;
const removeFeedId = (index: number) => `${FEED_PREFIX}.${index}.remove`;
const FEED_ROW_RE = new RegExp(`^${FEED_PREFIX}\\.(\\d+)\\.`);

function feedSection(feeds: readonly StatusLineFeed[]): MenuSection {
	const items: MenuSection["items"] = [];
	for (const [index, feed] of feeds.entries()) {
		const n = index + 1;
		items.push(
			{ id: feedKey(index, "customType"), label: `${n}. 消息类型`, value: feed.customType, text: true, placeholder: "ext/custom-type" },
			{ id: feedKey(index, "field"), label: `${n}. 字段`, value: feed.field, text: true, placeholder: "fieldName" },
			{ id: feedKey(index, "prefix"), label: `${n}. 前缀`, value: feed.prefix, text: true, placeholder: "（无）" },
			{ id: feedKey(index, "format"), label: `${n}. 格式`, value: feed.format, cycleValues: FEED_FORMATS },
			{ id: removeFeedId(index), label: `${n}. 删除这个数据源`, value: false, action: true },
		);
	}
	items.push({ id: ADD_FEED_ID, label: "+ 添加数据源", value: false, action: true });
	return { title: "数据源（其他插件发布的数值）", items };
}

/** Read the feed rows back out of the menu's flat value map. */
function feedsFromValues(values: Record<string, MenuValue>): StatusLineFeed[] {
	const indices = new Set<number>();
	for (const key of Object.keys(values)) {
		const match = FEED_ROW_RE.exec(key);
		if (match) indices.add(Number(match[1]));
	}
	return [...indices]
		.sort((a, b) => a - b)
		.map((index): StatusLineFeed => {
			const rawFormat = String(values[feedKey(index, "format")] ?? "text");
			return {
				customType: String(values[feedKey(index, "customType")] ?? ""),
				field: String(values[feedKey(index, "field")] ?? ""),
				prefix: String(values[feedKey(index, "prefix")] ?? ""),
				format: FEED_FORMATS.includes(rawFormat as FeedFormat) ? (rawFormat as FeedFormat) : "text",
			};
		})
		.filter(feed => feed.customType.trim() || feed.field.trim() || feed.prefix.trim());
}

function buildSections(settings: StatusLineSettings): MenuSection[] {
	const seg = { ...DEFAULT_SEGMENTS, ...settings.segments };
	const global: MenuSection = {
		title: "全局",
		items: [
			{ id: "transparent", label: "透明分段", value: settings.transparent ?? true },
			{
				id: "separator",
				label: "分隔符",
				value: settings.separator ?? "powerline-thin",
				cycleValues: SEPARATORS,
			},
			{ id: "symbols", label: "符号集", value: SYMBOL_LABELS[settings.symbols ?? "nerd"], cycleValues: SYMBOL_VALUES },
			{
				id: "borderStyle",
				label: "边框样式",
				value: settings.borderStyle ?? "rounded",
				cycleValues: BORDER_STYLES,
			},
			{
				id: "rainbowBorder",
				label: "最高思考级别时彩虹边框",
				value: settings.rainbowBorder ?? true,
			},
			{
				id: "rainbowAnimation",
				label: "彩虹边框动画",
				value: settings.rainbowAnimation ?? true,
			},
			{
				id: "nvidiaGreenBorder",
				label: "使用 Switchyard 时 NVIDIA 绿边框",
				value: settings.nvidiaGreenBorder ?? true,
			},
			{
				id: "nvidiaGreenAnimation",
				label: "Switchyard 绿边框动画",
				value: settings.nvidiaGreenAnimation ?? true,
			},
			{
				id: "embedWorkingStatus",
				label: "把状态动画嵌进边框",
				value: settings.embedWorkingStatus ?? false,
			},
		],
	};
	return [
		global,
		...SECTION_TITLES.map(title => ({
			title,
			items: SEGMENT_ROWS.filter(row => row.section === title).map(row => ({
				id: row.id,
				label: row.label,
				value: seg[row.id],
			})),
		})),
		feedSection(settings.feeds ? sanitizeFeeds(settings.feeds) : DEFAULT_FEEDS),
	];
}

function valuesToSettings(values: Record<string, MenuValue>): StatusLineSettings {
	const segments: StatusLineSegmentToggles = {};
	for (const row of SEGMENT_ROWS) segments[row.id] = values[row.id] === true;
	const separator = values.separator as StatusLineSeparatorStyle;
	const borderStyle = values.borderStyle as BorderStyle;
	return {
		transparent: values.transparent === true,
		separator: SEPARATORS.includes(separator) ? separator : "powerline-thin",
		symbols: SYMBOL_FROM_LABEL[values.symbols as string] ?? "nerd",
		borderStyle: BORDER_STYLES.includes(borderStyle) ? borderStyle : "rounded",
		segments,
		feeds: sanitizeFeeds(feedsFromValues(values)),
		rainbowBorder: values.rainbowBorder === true,
		rainbowAnimation: values.rainbowAnimation === true,
		nvidiaGreenBorder: values.nvidiaGreenBorder === true,
		nvidiaGreenAnimation: values.nvidiaGreenAnimation === true,
		embedWorkingStatus: values.embedWorkingStatus === true,
	};
}

// Canned stand-ins keep every toggle visible in the preview even when the
// live session lacks the data (no PR, no scrollback, fresh session).
const CANNED_PR = { number: 42, url: "https://github.com/underactive/pi-topping-statusline/pull/42" };
const CANNED_TOKEN_RATE = { rate: 87, phase: "active", fadeShade: 0 } as const;
/** Stand-in payloads so configured feeds still preview without a live publisher. */
const CANNED_FEED_NUMBER = 1.23;
const CANNED_HINT = "↑ 3 more";
const CANNED_STATS = "↑ 12.4K ↓ 3.1K R 148K W 12K 92.3% $0.42";
const CANNED_GIT = { branch: "main", status: { staged: 1, unstaged: 2, untracked: 3 } };
const CANNED_PERCENT = 42;
const CANNED_WINDOW = 200_000;
/** What pi's border indicator looks like mid-stream with pi-topping's loader installed. */
const CANNED_WORKING = "⠙ 渡劫中 ⢾⣿⣿⣿⣿⣿⢾⢾  28 tps · 11s · ↓ 316 tokens";
/** pi 0.86's compaction spinner: the longest status the bar has to carry. */
const CANNED_COMPACTION = "⠙ Context overflow detected, Auto-compacting... (esc to cancel)";

/** Fill any feed the live session has no entry for, so the preview stays legible. */
function cannedFeedData(
	feeds: readonly StatusLineFeed[],
	live: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const data: Record<string, unknown> = { ...live };
	for (const feed of feeds) {
		if (data[feed.customType] !== undefined || !feed.field) continue;
		data[feed.customType] = {
			[feed.field]: feed.format === "text" ? "sample" : CANNED_FEED_NUMBER,
		};
	}
	return data;
}

class StatusLinePreview {
	readonly #builder: SegmentContextBuilder;
	readonly #uiTheme: Theme;

	constructor(builder: SegmentContextBuilder, uiTheme: Theme) {
		this.#builder = builder;
		this.#uiTheme = uiTheme;
	}

	render(
		values: Record<string, MenuValue>,
		elapsedMs: number,
		activeItemId: string | undefined,
		innerWidth: number,
	): PreviewResult {
		const effective = resolveEffectiveSettings(valuesToSettings(values));
		// Preview lines are indented one cell by the menu; mirror renderBoxed's
		// 6-cell chrome budget for the bars themselves.
		const boxWidth = Math.max(24, innerWidth - 1);
		const barWidth = boxWidth - 6;

		// The theme singleton drives glyph lookups everywhere, so swap the
		// symbol preset for this synchronous render only; the live bar behind
		// the overlay keeps the applied preset.
		const applied = theme.setSymbolPreset(effective.symbols);
		try {
			const include: SegmentIncludes = {
				git: true,
				pr: true,
				piStats: true,
				tokenRate: true,
				feeds: effective.segmentOptions.feeds.map(f => f.customType),
			};
			const base = this.#builder.build(barWidth, effective.segmentOptions, include, CANNED_HINT);
			const greenOn = effective.nvidiaGreenBorder && isSwitchyardProvider(base.model?.provider);
			const rainbowOn = !greenOn && effective.rainbowBorder;
			const animationOn = greenOn ? effective.nvidiaGreenAnimation : rainbowOn && effective.rainbowAnimation;
			const phase = animationOn ? (elapsedMs * 360) / RAINBOW_CYCLE_MS : 0;
			const contextWindow = base.contextWindow || CANNED_WINDOW;
			const ctx: SegmentContext = {
				...base,
				// The preview demos the rainbow whenever the toggle is on,
				// regardless of the live session's thinking level.
				thinkingLevel: rainbowOn ? "max" : base.thinkingLevel,
				git: {
					branch: base.git.branch ?? CANNED_GIT.branch,
					status: base.git.status ?? CANNED_GIT.status,
					pr: base.git.pr ?? CANNED_PR,
				},
				contextPercent: base.contextPercent ?? CANNED_PERCENT,
				contextTokens: base.contextPercent == null ? Math.round((contextWindow * CANNED_PERCENT) / 100) : base.contextTokens,
				contextWindow,
				piStats: base.piStats ?? CANNED_STATS,
				tokenRate: base.tokenRate ?? CANNED_TOKEN_RATE,
				feedData: cannedFeedData(effective.segmentOptions.feeds, base.feedData),
			};

			const box = theme.getBox(effective.borderStyle);
			// The preview box is three rows tall: top bar, side verticals, bottom bar.
			const bottomIdx = 2;
			const colorizer = greenOn ? new NvidiaGreenBorder(phase) : new RainbowBorder(phase);
			const painters = makeBoxPainters({
				colorizerOn: greenOn || rainbowOn,
				colorizer,
				box,
				width: boxWidth,
				bottomIdx,
				flat: s => this.#uiTheme.fg("border", s),
			});
			const embedOn = effective.embedWorkingStatus;
			// Focusing the embed row demos the message-style spinners pi 0.86
			// routes through the same slot, including their ellipsis truncation.
			const compactionDemo = activeItemId === "embedWorkingStatus";
			const sample = compactionDemo ? CANNED_COMPACTION : CANNED_WORKING;
			const top = buildStatusLine(
				barWidth,
				embedOn ? { ...ctx, workingStatus: this.#uiTheme.fg("border", sample) } : ctx,
				effective,
				painters.gapColor,
				{
					left: topLeftSegments(effective, embedOn),
					right: effective.rightSegments,
				},
				{ col: 3, row: 0 },
				{ workingEllipsis: compactionDemo ? "…" : "" },
			);
			const bottom = buildStatusLine(
				barWidth,
				ctx,
				effective,
				painters.gapColor,
				{
					left: effective.bottomLeftSegments,
					right: effective.bottomRightSegments,
				},
				{ col: 3, row: bottomIdx },
			);
			return {
				lines: [
					renderBoxRow(painters, top, 0, boxWidth, box.topLeft, box.topRight),
					painters.paint(1, 0, box.vertical) +
						" ".repeat(Math.max(0, boxWidth - 2)) +
						painters.paint(1, boxWidth - 1, box.vertical),
					renderBoxRow(painters, bottom, bottomIdx, boxWidth, box.bottomLeft, box.bottomRight),
				],
				// A static colorizer stays at phase zero and needs no repaint timer.
				nextRefreshInMs: animationOn ? RAINBOW_FRAME_MS : undefined,
			};
		} finally {
			theme.setSymbolPreset(applied);
		}
	}
}

/** The statusline page of /frame-settings. */
export async function openStatuslineSettings(
	ctx: ExtensionCommandContext,
	state: SettingsState,
	builder: SegmentContextBuilder,
	onChange: () => void,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/frame-settings 需要在 TUI 模式下使用", "error");
		return;
	}
	const preview = new StatusLinePreview(builder, ctx.ui.theme);
	const result = await showMenu<Record<string, MenuValue>>(ctx, {
		title: "pi-frame 设置 · 状态栏",
		sections: buildSections(state.settings),
		hints: ["↑↓ 移动", "←→ 切换选项", "␣ 开关", "⏎ 应用/编辑", "esc 取消"],
		preview: preview.render.bind(preview),
		onAction: (id, values) => {
			const feeds = feedsFromValues(values);
			if (id === ADD_FEED_ID) {
				feeds.push({ customType: "", field: "", prefix: "", format: "currency" });
			} else {
				const match = new RegExp(`^${FEED_PREFIX}\\.(\\d+)\\.remove$`).exec(id);
				if (!match) return undefined;
				feeds.splice(Number(match[1]), 1);
			}
			// Rows are index-addressed, so the whole menu is regenerated to
			// keep ids contiguous after an insert or removal.
			return [...buildSections(valuesToSettings(values)).slice(0, -1), feedSection(feeds)];
		},
	});
	if (!result.applied) return;
	const next = valuesToSettings(result.values);
	applySettings(state, next);
	onChange();
	try {
		saveSettings(next);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`状态栏设置保存失败：${message}`, "error");
	}
}
