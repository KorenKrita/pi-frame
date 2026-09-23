import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_LOADER_ORDER, type LoaderElement } from "./format.ts";
import type { MenuSection } from "./menu.ts";
import { isWordPackEnabled, isWordPackId, type WordPack } from "./word-packs.ts";
import { isPlainObject } from "./util.ts";

export const SETTING_COLOR_VALUES = ["accent", "border", "borderAccent", "success", "error", "warning"] as const;
export const LOADER_COLOR_VALUES = [...SETTING_COLOR_VALUES, "text", "muted"] as const;
export const THINKING_LEVEL_COLOR_VALUES = ["thinking-level", ...LOADER_COLOR_VALUES] as const;
export type ThinkingLevelColor = (typeof THINKING_LEVEL_COLOR_VALUES)[number];
export const THINKING_LEVEL_SETTING_COLOR_VALUES = ["thinking-level", ...SETTING_COLOR_VALUES] as const;
export type ThinkingLevelSettingColor = (typeof THINKING_LEVEL_SETTING_COLOR_VALUES)[number];
export const SPINNER_COLOR_VALUES = THINKING_LEVEL_SETTING_COLOR_VALUES;
export type SpinnerColor = ThinkingLevelSettingColor;
export const PROMPT_BORDER_COLOR_VALUES = THINKING_LEVEL_SETTING_COLOR_VALUES;
export type PromptBorderColor = ThinkingLevelSettingColor;
export const DONE_MARKER_BORDER_COLOR_VALUES = THINKING_LEVEL_SETTING_COLOR_VALUES;
export type DoneMarkerBorderColor = ThinkingLevelSettingColor;
const THINKING_LEVEL_COLOR_MIGRATION_VERSION = 2;
const DONE_MARKER_BORDER_COLOR_MIGRATION_VERSION = 3;
export const SETTINGS_SCHEMA_VERSION = 3;

export const BORDER_STYLE_VALUES = ["double", "single", "rounded", "heavy"] as const;
export type BorderStyle = (typeof BORDER_STYLE_VALUES)[number];
export const DONE_MARKER_BORDER_STYLE_VALUES = [...BORDER_STYLE_VALUES, "none"] as const;
export type DoneMarkerBorderStyle = (typeof DONE_MARKER_BORDER_STYLE_VALUES)[number];
export const DONE_MARKER_STYLE_VALUES = ["elite", "bookend"] as const;
export type DoneMarkerStyle = (typeof DONE_MARKER_STYLE_VALUES)[number];

export function isBorderStyle(value: unknown): value is BorderStyle {
	return typeof value === "string" && BORDER_STYLE_VALUES.some(style => style === value);
}

export function isDoneMarkerBorderStyle(value: unknown): value is DoneMarkerBorderStyle {
	return typeof value === "string" && DONE_MARKER_BORDER_STYLE_VALUES.some(style => style === value);
}

export function isDoneMarkerStyle(value: unknown): value is DoneMarkerStyle {
	return typeof value === "string" && DONE_MARKER_STYLE_VALUES.some(style => style === value);
}

export function isThinkingLevelColor(value: unknown): value is ThinkingLevelColor {
	return typeof value === "string" && THINKING_LEVEL_COLOR_VALUES.some(color => color === value);
}

export function isThinkingLevelSettingColor(value: unknown): value is ThinkingLevelSettingColor {
	return typeof value === "string" && THINKING_LEVEL_SETTING_COLOR_VALUES.some(color => color === value);
}

export const isSpinnerColor = isThinkingLevelSettingColor;
export const isPromptBorderColor = isThinkingLevelSettingColor;
export const isDoneMarkerBorderColor = isThinkingLevelSettingColor;

export interface DecoratorSettings {
	decorations: {
		animatedSpinner: boolean;
		shimmer: boolean;
		shimmerInverted: boolean;
		shimmerDirection: "ltr" | "rtl";
		shimmerDirectionEnabled: boolean;
		shimmerSpeed: "slow" | "normal" | "fast";
		shimmerSpeedEnabled: boolean;
		tokenActivityMonitor: boolean;
		meterDirection: "ltr" | "rtl";
		meterDirectionEnabled: boolean;
		decorateUserPrompt: boolean;
		borderColor: PromptBorderColor;
		borderColorEnabled: boolean;
		borderStyle: BorderStyle;
		borderStyleEnabled: boolean;
		doneMarkerBorderStyle: DoneMarkerBorderStyle;
		doneMarkerBorderColor: DoneMarkerBorderColor;
		doneMarkerStyle: DoneMarkerStyle;
		doneMarkerModelColor: ThinkingLevelColor;
		doneMarkerModelDimmed: boolean;
		spinnerColor: SpinnerColor;
		spinnerColorEnabled: boolean;
		meterColor: ThinkingLevelColor;
		meterColorEnabled: boolean;
		meterDimmed: boolean;
		tokenRateColor: ThinkingLevelColor;
		tokenRateDimmed: boolean;
		responseModelColor: ThinkingLevelColor;
		responseModelDimmed: boolean;
		promptIcon: boolean;
		promptTimestamp: boolean;
		promptProvider: boolean;
		promptModel: boolean;
		useNerdFont: boolean;
	};
	features: {
		substituteDefaultMessage: boolean;
		elapsedTime: boolean;
		outputTokens: boolean;
		tokenRate: boolean;
		responseModel: boolean;
		doneMarker: boolean;
		doneMarkerIcon: boolean;
		randomizeDoneMarker: boolean;
		doneMarkerTokens: boolean;
		doneMarkerInputs: boolean;
		doneMarkerModel: boolean;
	};
	loaderOrder: LoaderElement[];
	wordPacks: Record<string, boolean>;
}

export const DEFAULT_SETTINGS: DecoratorSettings = {
	decorations: { animatedSpinner: true, shimmer: true, shimmerInverted: false, shimmerDirection: "ltr", shimmerDirectionEnabled: true, shimmerSpeed: "normal", shimmerSpeedEnabled: true, tokenActivityMonitor: true, meterDirection: "rtl", meterDirectionEnabled: true, decorateUserPrompt: true, borderColor: "thinking-level", borderColorEnabled: true, borderStyle: "double", borderStyleEnabled: true, doneMarkerBorderStyle: "none", doneMarkerBorderColor: "thinking-level", doneMarkerStyle: "elite", doneMarkerModelColor: "muted", doneMarkerModelDimmed: false, spinnerColor: "thinking-level", spinnerColorEnabled: true, meterColor: "accent", meterColorEnabled: true, meterDimmed: false, tokenRateColor: "warning", tokenRateDimmed: false, responseModelColor: "accent", responseModelDimmed: false, promptIcon: true, promptTimestamp: true, promptProvider: true, promptModel: true, useNerdFont: true },
	features: { substituteDefaultMessage: true, elapsedTime: true, outputTokens: true, tokenRate: true, responseModel: true, doneMarker: true, doneMarkerIcon: true, randomizeDoneMarker: true, doneMarkerTokens: true, doneMarkerInputs: true, doneMarkerModel: true },
	loaderOrder: [...DEFAULT_LOADER_ORDER],
	wordPacks: {},
};

/** Menu key carrying the loader element order as a comma-joined list of element ids. */
export const LOADER_ORDER_ID = "loaderOrder";
const LOADER_ELEMENT_LABELS: Record<LoaderElement, string> = {
	spinner: "转圈动画",
	text: "动作词",
	meter: "token 活动条",
	elapsed: "已用时间",
	tokens: "输出 token 数",
	tokenRate: "token 速率",
	responseModel: "实际响应模型",
};

/**
 * Normalize an element order from disk or from the menu, tolerating hand edits and
 * version skew: unknown entries and duplicates are dropped, missing elements are
 * appended in their default positions.
 */
export function parseLoaderOrder(value: unknown): LoaderElement[] {
	const entries = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
	const order: LoaderElement[] = [];
	for (const entry of entries) {
		const element = typeof entry === "string" ? entry.trim() as LoaderElement : undefined;
		if (element && DEFAULT_LOADER_ORDER.includes(element) && !order.includes(element)) order.push(element);
	}
	for (const element of DEFAULT_LOADER_ORDER) if (!order.includes(element)) order.push(element);
	return order;
}

export function settingsPath(): string { return join(getAgentDir(), "pi-frame", "prompt-loader.json"); }
/** pi-topping's file; read once as the starting point until pi-frame saves its own. */
function legacySettingsPath(): string { return join(getAgentDir(), "pi-topping", "settings.json"); }
function mergeGroup<T extends Record<string, boolean | string>>(defaults: T, parsed: unknown): T {
	const merged = { ...defaults };
	if (!isPlainObject(parsed)) return merged;
	for (const [key, value] of Object.entries(parsed)) {
		if (!Object.hasOwn(merged, key)) continue;
		let valid: boolean | string | undefined;
		if (typeof merged[key] === "boolean" && typeof value === "boolean") valid = value;
		else if ((key === "meterDirection" || key === "shimmerDirection") && (value === "ltr" || value === "rtl")) valid = value;
		else if (key === "shimmerSpeed" && (value === "slow" || value === "normal" || value === "fast")) valid = value;
		else if (key === "spinnerColor" && value === "default") valid = "thinking-level";
		else if (key === "spinnerColor" && isSpinnerColor(value)) valid = value;
		else if (key === "borderColor" && isPromptBorderColor(value)) valid = value;
		else if (key === "doneMarkerBorderColor" && value === "default") valid = "thinking-level";
		else if (key === "doneMarkerBorderColor" && isDoneMarkerBorderColor(value)) valid = value;
		else if ((key === "meterColor" || key === "tokenRateColor" || key === "responseModelColor" || key === "doneMarkerModelColor") && isThinkingLevelColor(value)) valid = value;
		else if (key === "borderStyle" && isBorderStyle(value)) valid = value;
		else if (key === "doneMarkerBorderStyle" && isDoneMarkerBorderStyle(value)) valid = value;
		else if (key === "doneMarkerStyle" && isDoneMarkerStyle(value)) valid = value;
		if (valid !== undefined) (merged as Record<string, boolean | string>)[key] = valid;
	}
	return merged;
}

/** Convert a persisted or menu direction to a safe preview direction. */
export function fromCycleDirection(value: unknown): "ltr" | "rtl" {
	return value === "rtl" ? "rtl" : "ltr";
}

/** Convert a persisted or menu speed to a safe preview speed. */
export function fromCycleSpeed(value: unknown): "slow" | "normal" | "fast" {
	return value === "slow" || value === "fast" ? value : "normal";
}

type MenuSectionName = "输入框" | "加载动画";
export type LoaderMenuPage = "prompt" | "loader";
type DecorationSettings = DecoratorSettings["decorations"];
type FeatureSettings = DecoratorSettings["features"];
type DecorationBooleanKey = { [Key in keyof DecorationSettings]: DecorationSettings[Key] extends boolean ? Key : never }[keyof DecorationSettings];
type MenuEntryBase = { id: string; label: string; section: MenuSectionName };
type DecorationMenuEntry = MenuEntryBase & { group: "decorations"; key: keyof DecorationSettings; cycleValues?: readonly string[]; cycleValueLabels?: Readonly<Record<string, string>>; cycleEnabledBy?: DecorationBooleanKey; cycleDisabledValue?: string };
type FeatureMenuEntry = MenuEntryBase & { group: "features"; key: keyof FeatureSettings; cycleValues?: never; cycleValueLabels?: never; cycleEnabledBy?: never; cycleDisabledValue?: never };
type MenuEntry = DecorationMenuEntry | FeatureMenuEntry;
const COLOR_CYCLE_LABELS = {
	"thinking-level": "跟随思考等级",
	accent: "强调色",
	border: "边框色",
	borderAccent: "边框强调色",
	success: "成功色",
	error: "错误色",
	warning: "警告色",
	text: "正文色",
	muted: "弱化色",
} as const;
const BORDER_STYLE_LABELS = { double: "双线", single: "单线", rounded: "圆角", heavy: "粗线" } as const;
const DIRECTION_CYCLE_LABELS = { ltr: "从左到右", rtl: "从右到左" } as const;
const SPEED_CYCLE_LABELS = { slow: "慢", normal: "中", fast: "快" } as const;
export const MENU_ENTRIES: readonly MenuEntry[] = [
	// decorateUserPrompt is render-only here: it switches between the framed box and Pi's native prompt row.
	{ id: "decorateUserPrompt", label: "边框输入框", section: "输入框", group: "decorations", key: "decorateUserPrompt" },
	{ id: "borderStyle", label: "边框样式", section: "输入框", group: "decorations", key: "borderStyle", cycleValues: BORDER_STYLE_VALUES, cycleValueLabels: BORDER_STYLE_LABELS, cycleEnabledBy: "borderStyleEnabled", cycleDisabledValue: "double" },
	{ id: "borderColor", label: "边框颜色", section: "输入框", group: "decorations", key: "borderColor", cycleValues: PROMPT_BORDER_COLOR_VALUES, cycleValueLabels: COLOR_CYCLE_LABELS, cycleEnabledBy: "borderColorEnabled", cycleDisabledValue: "thinking-level" },
	{ id: "promptIcon", label: "π 图标", section: "输入框", group: "decorations", key: "promptIcon" },
	{ id: "promptTimestamp", label: "发送时间", section: "输入框", group: "decorations", key: "promptTimestamp" },
	{ id: "promptProvider", label: "服务商", section: "输入框", group: "decorations", key: "promptProvider" },
	{ id: "promptModel", label: "模型", section: "输入框", group: "decorations", key: "promptModel" },
	{ id: "animatedSpinner", label: "转圈动画", section: "加载动画", group: "decorations", key: "animatedSpinner" },
	{ id: "spinnerColor", label: "转圈颜色", section: "加载动画", group: "decorations", key: "spinnerColor", cycleValues: SPINNER_COLOR_VALUES, cycleValueLabels: COLOR_CYCLE_LABELS, cycleEnabledBy: "spinnerColorEnabled", cycleDisabledValue: "thinking-level" },
	{ id: "substituteDefaultMessage", label: "随机动作词", section: "加载动画", group: "features", key: "substituteDefaultMessage" },
	{ id: "shimmer", label: "文字流光", section: "加载动画", group: "decorations", key: "shimmer" },
	{ id: "shimmerInverted", label: "流光反色", section: "加载动画", group: "decorations", key: "shimmerInverted" },
	{ id: "shimmerDirection", label: "流光方向", section: "加载动画", group: "decorations", key: "shimmerDirection", cycleValues: ["ltr", "rtl"], cycleValueLabels: DIRECTION_CYCLE_LABELS, cycleEnabledBy: "shimmerDirectionEnabled", cycleDisabledValue: "ltr" },
	{ id: "shimmerSpeed", label: "流光速度", section: "加载动画", group: "decorations", key: "shimmerSpeed", cycleValues: ["slow", "normal", "fast"], cycleValueLabels: SPEED_CYCLE_LABELS, cycleEnabledBy: "shimmerSpeedEnabled", cycleDisabledValue: "normal" },
	{ id: "tokenActivityMonitor", label: "token 活动条", section: "加载动画", group: "decorations", key: "tokenActivityMonitor" },
	{ id: "meterColor", label: "活动条颜色", section: "加载动画", group: "decorations", key: "meterColor", cycleValues: THINKING_LEVEL_COLOR_VALUES, cycleValueLabels: COLOR_CYCLE_LABELS, cycleEnabledBy: "meterColorEnabled", cycleDisabledValue: "accent" },
	{ id: "meterDirection", label: "活动条方向", section: "加载动画", group: "decorations", key: "meterDirection", cycleValues: ["ltr", "rtl"], cycleValueLabels: DIRECTION_CYCLE_LABELS, cycleEnabledBy: "meterDirectionEnabled", cycleDisabledValue: "rtl" },
	{ id: "meterDimmed", label: "活动条调暗", section: "加载动画", group: "decorations", key: "meterDimmed" },
	{ id: "elapsedTime", label: "已用时间", section: "加载动画", group: "features", key: "elapsedTime" },
	{ id: "outputTokens", label: "输出 token 数", section: "加载动画", group: "features", key: "outputTokens" },
	// id differs from key: the Elements Order row already owns "tokenRate" in the menu's shared value namespace.
	{ id: "showTokenRate", label: "token 速率", section: "加载动画", group: "features", key: "tokenRate" },
	{ id: "tokenRateColor", label: "速率颜色", section: "加载动画", group: "decorations", key: "tokenRateColor", cycleValues: THINKING_LEVEL_COLOR_VALUES, cycleValueLabels: COLOR_CYCLE_LABELS },
	{ id: "tokenRateDimmed", label: "速率调暗", section: "加载动画", group: "decorations", key: "tokenRateDimmed" },
	// id differs from key: the Elements Order row already owns "responseModel" in the menu's shared value namespace.
	{ id: "showResponseModel", label: "实际响应模型", section: "加载动画", group: "features", key: "responseModel" },
	{ id: "responseModelColor", label: "响应模型颜色", section: "加载动画", group: "decorations", key: "responseModelColor", cycleValues: THINKING_LEVEL_COLOR_VALUES, cycleValueLabels: COLOR_CYCLE_LABELS },
	{ id: "responseModelDimmed", label: "响应模型调暗", section: "加载动画", group: "decorations", key: "responseModelDimmed" },
	{ id: "useNerdFont", label: "使用 Nerd Font 图标", section: "输入框", group: "decorations", key: "useNerdFont" },
];

function menuItem(entry: MenuEntry, settings: DecoratorSettings): MenuSection["items"][number] {
	const value = entry.group === "decorations" ? settings.decorations[entry.key] : settings.features[entry.key];
	const cycleEnabled = entry.group === "decorations" && entry.cycleEnabledBy
		? settings.decorations[entry.cycleEnabledBy]
		: undefined;
	return { id: entry.id, label: entry.label, cycleValues: entry.cycleValues, cycleValueLabels: entry.cycleValueLabels, cycleEnabledBy: entry.cycleEnabledBy, cycleDisabledValue: entry.cycleDisabledValue, cycleEnabled, value };
}

function isDecorationBooleanKey(key: keyof DecorationSettings): key is DecorationBooleanKey {
	return typeof DEFAULT_SETTINGS.decorations[key] === "boolean";
}

function setDecorationCycleValue(decorations: DecorationSettings, key: keyof DecorationSettings, value: string): void {
	switch (key) {
		case "borderColor":
			if (isPromptBorderColor(value)) decorations[key] = value;
			return;
		case "spinnerColor":
			if (isSpinnerColor(value)) decorations[key] = value;
			return;
		case "meterColor":
		case "tokenRateColor":
		case "responseModelColor":
		case "doneMarkerModelColor":
			if (isThinkingLevelColor(value)) decorations[key] = value;
			return;
		case "doneMarkerBorderColor":
			if (isDoneMarkerBorderColor(value)) decorations[key] = value;
			return;
		case "borderStyle":
			if (isBorderStyle(value)) decorations[key] = value;
			return;
		case "doneMarkerBorderStyle":
			if (isDoneMarkerBorderStyle(value)) decorations[key] = value;
			return;
		case "doneMarkerStyle":
			if (isDoneMarkerStyle(value)) decorations[key] = value;
			return;
		case "shimmerDirection":
		case "meterDirection":
			if (value === "ltr" || value === "rtl") decorations[key] = value;
			return;
		case "shimmerSpeed":
			if (value === "slow" || value === "normal" || value === "fast") decorations[key] = value;
			return;
		default:
			// Fail loudly if a MENU_ENTRIES cycle entry is added without a handler here.
			throw new Error(`Unhandled cycle setting: ${String(key)}`);
	}
}

function buildSection(title: MenuSectionName, settings: DecoratorSettings): MenuSection {
	return { title, items: MENU_ENTRIES.filter(entry => entry.section === title).map(entry => menuItem(entry, settings)) };
}

export function buildMenuSections(page: LoaderMenuPage, settings: DecoratorSettings, bundledPacks: readonly WordPack[], userPacks: readonly WordPack[] = []): MenuSection[] {
	if (page === "prompt") return [buildSection("输入框", settings)];
	const packs = [...bundledPacks, ...userPacks];
	return [
		buildSection("加载动画", settings),
		{ title: "元素顺序", items: parseLoaderOrder(settings.loaderOrder).map(id => ({ id, label: LOADER_ELEMENT_LABELS[id], value: false, reorderGroup: LOADER_ORDER_ID })) },
		{ title: "词包", items: packs.map((pack) => ({ id: `pack:${pack.id}`, label: pack.name, value: isWordPackEnabled(pack.id, settings.wordPacks) })) },
	];
}

export function applyMenuResult(settings: DecoratorSettings, values: Record<string, boolean | string>): DecoratorSettings {
	const next = structuredClone(settings);
	for (const entry of MENU_ENTRIES) {
		const value = values[entry.id];
		if (value === undefined) continue;
		if (entry.group === "decorations" && entry.cycleValues && typeof value === "string" && entry.cycleValues.includes(value)) {
			setDecorationCycleValue(next.decorations, entry.key, value);
			if (entry.cycleEnabledBy) next.decorations[entry.cycleEnabledBy] = values[entry.cycleEnabledBy] !== false;
		} else if (entry.group === "decorations" && typeof value === "boolean" && isDecorationBooleanKey(entry.key)) {
			next.decorations[entry.key] = value;
		} else if (entry.group === "features" && typeof value === "boolean") {
			next.features[entry.key] = value;
		}
	}
	for (const [id, value] of Object.entries(values)) {
		if (!id.startsWith("pack:") || typeof value !== "boolean") continue;
		const packId = id.slice("pack:".length);
		if (isWordPackId(packId)) next.wordPacks[packId] = value;
	}
	if (typeof values[LOADER_ORDER_ID] === "string") next.loaderOrder = parseLoaderOrder(values[LOADER_ORDER_ID]);
	return next;
}

/**
 * Read settings.json, merging valid leaves over the defaults and falling back
 * to defaults on any read/parse error. When a cycle setting's enabled flag is
 * off, its stored value resets to the menu's disabled default so stale choices
 * don't resurface on re-enable.
 * Files with `schemaVersion` below 2 get spinner color reset to `thinking-level` and
 * `borderAccent` prompt borders moved to `thinking-level`; below 3, the completion-marker
 * border color is reset.
 */
export function loadSettings(): DecoratorSettings {
	try {
		// pi-topping's file only seeds a missing pi-frame file; the seed is written below so it is read once.
		const legacy = !existsSync(settingsPath());
		const raw = readFileSync(legacy ? legacySettingsPath() : settingsPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (!isPlainObject(parsed)) return structuredClone(DEFAULT_SETTINGS);
		const wordPacks: Record<string, boolean> = { ...DEFAULT_SETTINGS.wordPacks };
		if (isPlainObject(parsed.wordPacks)) {
			for (const [id, enabled] of Object.entries(parsed.wordPacks)) {
				if (isWordPackId(id) && typeof enabled === "boolean") wordPacks[id] = enabled;
			}
		}
		const settings = { decorations: mergeGroup(DEFAULT_SETTINGS.decorations, parsed.decorations), features: mergeGroup(DEFAULT_SETTINGS.features, parsed.features), loaderOrder: parseLoaderOrder(parsed.loaderOrder), wordPacks };
		const schemaVersion = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1;
		if (schemaVersion < THINKING_LEVEL_COLOR_MIGRATION_VERSION) {
			settings.decorations.spinnerColor = "thinking-level";
			if (settings.decorations.borderColor === "borderAccent") settings.decorations.borderColor = "thinking-level";
		}
		if (schemaVersion < DONE_MARKER_BORDER_COLOR_MIGRATION_VERSION) {
			settings.decorations.doneMarkerBorderColor = "thinking-level";
		}
		// In pi-topping this flag re-sent prompts as custom messages; here it only picks the renderer,
		// so an imported `false` (turned off to keep prompts native) must not hide the box.
		if (legacy) settings.decorations.decorateUserPrompt = true;
		for (const entry of MENU_ENTRIES) {
			if (entry.group === "decorations" && entry.cycleEnabledBy && entry.cycleDisabledValue !== undefined && !settings.decorations[entry.cycleEnabledBy]) {
				setDecorationCycleValue(settings.decorations, entry.key, entry.cycleDisabledValue);
			}
		}
		if (legacy) {
			try {
				saveSettings(settings);
			} catch {
				// Unwritable agent dir: keep using the imported values for this run.
			}
		}
		return settings;
	} catch { return structuredClone(DEFAULT_SETTINGS); }
}

export function atomicWriteFile(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tmpPath, contents, { flag: "wx" });
		renameSync(tmpPath, path);
	} catch (err) {
		try { unlinkSync(tmpPath); } catch { /* tmp file was never created */ }
		throw err;
	}
}

export function saveSettings(settings: DecoratorSettings): void {
	atomicWriteFile(settingsPath(), `${JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, ...settings }, null, 2)}\n`);
}
