import type {
	AgentSettledEvent,
	AgentStartEvent,
	CustomEntry,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionEvent,
	InputEvent,
	InputEventResult,
	SessionShutdownEvent,
	SessionStartEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { ActivityMeter, rateToLevel, TokRateTracker } from "./activity-meter.ts";
import {
	buildWorkingMessage,
	DEFAULT_WORKING_WORD,
	dimAttribute,
	getThinkingLevelColorizer,
	isThinkingLevel,
	ELAPSED_INTERVAL_MS,
	fadeThemeColorString,
	formatElapsed,
	formatTokenRate,
	formatTokens,
	isFullyDefaultAppearance,
	METER_INTERVAL_MS,
	RESPONSE_MODEL_FADE_MS,
	RESPONSE_MODEL_HOLD_MS,
	SHIMMER_INTERVAL_MS,
	shimmerString,
	SPINNER_FRAME_MS,
	SPINNER_FRAMES,
	TOKEN_RATE_FADE_SHADE_COUNT,
	TOKEN_RATE_PLACEHOLDER,
	StreamingWordCounter,
	type ThinkingLevel,
} from "./format.ts";
import { showMenu } from "./menu.ts";
import { getResponseModelColorizer } from "./nvidia-green.ts";
import { applyMenuResult, buildMenuSections, loadSettings, saveSettings, type LoaderMenuPage, type ThinkingLevelColor } from "./settings.ts";
import { PreviewRenderer } from "./preview.ts";
import { PROMPT_BOX_TYPE, promptBoxRenderer, type PromptBoxDetails } from "./prompt-decorator.ts";
import { isPlainObject, modelsResemble, stripControlChars } from "./util.ts";
import { loadBundledWordPacks, loadUserWordPacks, pickWorkingTextSelection, type WorkingTextSelection, type WordPack } from "./word-packs.ts";

type MessageStartEvent = Extract<ExtensionEvent, { type: "message_start" }>;
type MessageUpdateEvent = Extract<ExtensionEvent, { type: "message_update" }>;
type MessageEndEvent = Extract<ExtensionEvent, { type: "message_end" }>;
type ToolExecutionStartEvent = Extract<ExtensionEvent, { type: "tool_execution_start" }>;
type UIPromptStartEvent = Extract<ExtensionEvent, { type: "ui_prompt_start" }>;
type UIPromptEndEvent = Extract<ExtensionEvent, { type: "ui_prompt_end" }>;
type UIPromptKind = UIPromptStartEvent["kind"];

const RESPONSE_MODEL_STATUS_KEY = "pi-frame-response-model";
const WAITING_LABELS: Record<UIPromptKind, string> = {
	select: "等你选一个",
	confirm: "等你点头",
	input: "等你输入",
	editor: "等你在编辑器里写完",
	custom: "等你输入",
};
const WAITING_PULSE_FRAMES = ["·", "•", "●", "•"];
const WAITING_PULSE_INTERVAL_MS = 120;
// Reconciliation resets the EMA at message boundaries, so retain and then fade the last rate to avoid flicker.
const TOKEN_RATE_HOLD_MS = 1_500;
const TOKEN_RATE_FADE_MS = 250;

interface DoneEntryData {
	word: string;
	elapsedMs: number;
	tokens?: number;
	midTurnInputs?: number;
	thinkingLevel?: ThinkingLevel;
	model?: string;
}

interface SessionState {
	startTime: number;
	workingText: WorkingTextSelection;
	confirmTokens: number;
	liveTokens: number;
	shimmerOrigin: number;
	activityMeter: ActivityMeter;
	rateTracker: TokRateTracker;
	lastTokenRateSampledAt: number;
	lastTokenRateTotal: number;
	responseModel: string;
	/** Last raw responseModel value seen, or the NOT_SENT sentinel before the first call. */
	lastResponseModelRaw: unknown;
	responseModelHoldTimer: ReturnType<typeof setTimeout> | null;
	responseModelFadeTimer: ReturnType<typeof setInterval> | null;
	responseModelFadeGeneration: number;
	tokenRateText: string;
	tokenRateFadeStartsAt: number;
	timer: ReturnType<typeof setInterval> | null;
	busy: boolean;
	waiting: { kind: UIPromptKind; title?: string } | null;
	midTurnInputs: number;
	/** Last string passed to setWorkingMessage(), or the NOT_SENT sentinel before the first call. */
	lastMessage: string | undefined | typeof NOT_SENT;
}

/** Sentinel distinguishing "never called setWorkingMessage()" from an explicit `undefined` message. */
const NOT_SENT = Symbol("not-sent");

/** Reset all token-rate tracking fields on `state` to their fresh-turn values. */
function resetTokenRateState(state: SessionState): void {
	state.rateTracker.reset();
	state.lastTokenRateSampledAt = 0;
	state.lastTokenRateTotal = 0;
	state.tokenRateText = "";
	state.tokenRateFadeStartsAt = 0;
}

function makeFreshState(): SessionState {
	return {
		startTime: 0,
		workingText: { text: "", pastTense: "Worked" },
		confirmTokens: 0,
		liveTokens: 0,
		shimmerOrigin: 0,
		activityMeter: new ActivityMeter(),
		rateTracker: new TokRateTracker(),
		lastTokenRateSampledAt: 0,
		lastTokenRateTotal: 0,
		responseModel: "",
		lastResponseModelRaw: NOT_SENT,
		responseModelHoldTimer: null,
		responseModelFadeTimer: null,
		responseModelFadeGeneration: 0,
		tokenRateText: "",
		tokenRateFadeStartsAt: 0,
		timer: null,
		busy: false,
		waiting: null,
		midTurnInputs: 0,
		lastMessage: NOT_SENT,
	};
}

function waitingLabel(waiting: NonNullable<SessionState["waiting"]>): string {
	const title = waiting.title ? stripControlChars(waiting.title).trim() : "";
	return title ? `等待：${title}` : WAITING_LABELS[waiting.kind];
}

function responseModelOf(message: unknown): unknown {
	return isPlainObject(message) ? message.responseModel : undefined;
}

/** Owns mutable extension state and Pi lifecycle registrations. */
export class SessionManager {
	#counter = new StreamingWordCounter();
	#state = makeFreshState();
	#settings = loadSettings();
	#userPacks: WordPack[] = [];
	#bundledPacks = loadBundledWordPacks();
	#allPacks: WordPack[] = [...this.#bundledPacks];
	#currentCtx: ExtensionContext | null = null;
	readonly #pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.#pi = pi;
	}

	#onSessionStart = async (_e: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
		this.#currentCtx = ctx;
		this.stopTimer();
		this.cancelResponseModelFade(ctx);
		this.#counter.reset();
		this.#state = makeFreshState();
		this.#settings = loadSettings();
		this.#userPacks = loadUserWordPacks();
		this.#allPacks = [...this.#bundledPacks, ...this.#userPacks];
		this.#state.activityMeter.setDirection(this.#settings.decorations.meterDirection);
		if (this.usable(ctx)) {
			this.applyIndicator(ctx);
		}
	};

	// Observe only: the prompt is never rewritten or re-sent, so Pi's native user-message path
	// (before_agent_start, role=user history) stays intact for other extensions.
	#onInput = async (event: InputEvent, ctx: ExtensionContext): Promise<void> => {
		this.#currentCtx = ctx;
		if (!this.usable(ctx)) return;
		if (!event.streamingBehavior && !this.#state.busy) this.resetTurn(Date.now());
	};

	#onAgentStart = async (_e: AgentStartEvent, ctx: ExtensionContext): Promise<void> => {
		this.#currentCtx = ctx;
		this.cancelResponseModelFade(ctx);
		if (!this.usable(ctx)) return;
		if (!this.#state.startTime) this.resetTurn(Date.now());
		this.#state.busy = true;
		if (!this.#state.waiting) this.applyIndicator(ctx);
		this.startTimer();
		this.tick();
	};

	#onMessageStart = async (event: MessageStartEvent, ctx: ExtensionContext): Promise<void> => {
		this.#currentCtx = ctx;
		if (this.usable(ctx) && event.message.role === "assistant") {
			this.#state.liveTokens = 0;
			this.#counter.reset();
			this.updateResponseModel(responseModelOf(event.message));
		}
	};

	#onMessageUpdate = async (event: MessageUpdateEvent, ctx: ExtensionContext): Promise<void> => {
		this.#currentCtx = ctx;
		if (!this.usable(ctx)) return;
		const assistantEvent = event.assistantMessageEvent;
		if (
			assistantEvent &&
			(assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta")
		) {
			this.#state.liveTokens += this.#counter.count(assistantEvent.delta, assistantEvent.type);
		}
		const rawResponseModel = (assistantEvent as { partial?: { responseModel?: unknown } } | undefined)?.partial?.responseModel
			?? responseModelOf(event.message);
		this.updateResponseModel(rawResponseModel);
	};

	#onMessageEnd = async (event: MessageEndEvent, ctx: ExtensionContext): Promise<void> => {
		this.#currentCtx = ctx;
		if (!this.usable(ctx) || event.message.role !== "assistant") return;

		const rawTokens = event.message.usage?.output;
		const exactTokens =
			typeof rawTokens === "number" && Number.isFinite(rawTokens) && rawTokens >= 0 ? rawTokens : undefined;
		this.#state.confirmTokens += exactTokens ?? this.#state.liveTokens;
		if (exactTokens !== undefined) {
			// Only reset the sampling state here, not tokenRateText/tokenRateFadeStartsAt:
			// those must keep holding/fading across message boundaries to avoid flicker.
			this.#state.rateTracker.reset();
			this.#state.lastTokenRateSampledAt = 0;
			this.#state.lastTokenRateTotal = this.#state.confirmTokens;
		}
		this.#state.liveTokens = 0;
		this.#counter.reset();
		this.updateResponseModel(responseModelOf(event.message));
	};

	#onToolExecutionStart = async (_e: ToolExecutionStartEvent, ctx: ExtensionContext): Promise<void> => {
		this.#currentCtx = ctx;
		if (this.usable(ctx)) {
			this.#state.workingText = this.pickWorkingWord();
			this.#state.shimmerOrigin = Date.now();
			this.tick();
		}
	};

	#onUIPromptStart = (event: UIPromptStartEvent, ctx: ExtensionContext): void => {
		this.#currentCtx = ctx;
		if (!this.usable(ctx) || !this.#state.busy) return;
		this.#state.waiting = { kind: event.kind, title: event.title };
		this.applyWaitingIndicator(ctx);
		this.tick();
	};

	#onUIPromptEnd = (_event: UIPromptEndEvent, ctx: ExtensionContext): void => {
		this.#currentCtx = ctx;
		if (!this.usable(ctx) || !this.#state.waiting) return;
		this.#state.waiting = null;
		if (!this.#state.busy) return;
		this.applyIndicator(ctx);
		this.tick();
	};

	#onAgentSettled = async (_e: AgentSettledEvent, ctx: ExtensionContext): Promise<void> => {
		this.#currentCtx = ctx;
		if (!this.usable(ctx)) return;

		const responseModel = this.#settings.features.responseModel ? this.#state.responseModel : "";
		const responseModelColor = this.#settings.decorations.responseModelColor;
		const responseModelDimmed = this.#settings.decorations.responseModelDimmed;
		this.#state.busy = false;
		this.#state.waiting = null;
		this.#state.startTime = 0;
		this.#counter.reset();
		this.stopTimer();
		this.applyIndicator(ctx);
		ctx.ui.setWorkingMessage();
		if (responseModel) this.startResponseModelFade(ctx, responseModel, responseModelColor, responseModelDimmed);
		this.#state.activityMeter.reset();
		resetTokenRateState(this.#state);
		this.#state.lastMessage = NOT_SENT;
		this.#currentCtx = null;
	};

	#onSessionShutdown = async (_e: SessionShutdownEvent, ctx: ExtensionContext): Promise<void> => {
		this.#state.waiting = null;
		this.cancelResponseModelFade(ctx);
		this.stopTimer();
	};

	install(): void {
		this.#pi.on("session_start", this.#onSessionStart);
		this.#pi.on("input", this.#onInput);
		this.#pi.on("agent_start", this.#onAgentStart);
		this.#pi.on("message_start", this.#onMessageStart);
		this.#pi.on("message_update", this.#onMessageUpdate);
		this.#pi.on("message_end", this.#onMessageEnd);
		this.#pi.on("tool_execution_start", this.#onToolExecutionStart);
		this.#pi.on("agent_settled", this.#onAgentSettled);
		this.#pi.on("ui_prompt_start", this.#onUIPromptStart);
		this.#pi.on("ui_prompt_end", this.#onUIPromptEnd);
		this.#pi.on("session_shutdown", this.#onSessionShutdown);
		// Sessions recorded while pi-topping decorated prompts still hold these messages.
		this.#pi.registerMessageRenderer<PromptBoxDetails>(PROMPT_BOX_TYPE, promptBoxRenderer);
	}

	get settings() {
		return this.#settings;
	}

	private usable(ctx: ExtensionContext): boolean {
		return !!ctx.hasUI && ctx.mode !== "print";
	}

	/**
	 * Pi's Loader always prepends its indicator to the working message, so a spinner
	 * that is not the leading element has to be drawn inside the message instead.
	 */
	private spinnerInMessage(): boolean {
		return this.#settings.decorations.animatedSpinner && this.#settings.loaderOrder[0] !== "spinner";
	}

	private indicatorFingerprint(): string {
		const decorations = this.#settings.decorations;
		return `${decorations.animatedSpinner}:${decorations.spinnerColor}:${decorations.spinnerColorEnabled}:${this.#settings.loaderOrder[0]}`;
	}

	private applyWaitingIndicator(ctx: ExtensionContext): void {
		ctx.ui.setWorkingIndicator({
			frames: WAITING_PULSE_FRAMES.map((frame) => ctx.ui.theme.fg("dim", frame)),
			intervalMs: WAITING_PULSE_INTERVAL_MS,
		});
	}

	private applyIndicator(ctx: ExtensionContext): void {
		if (!this.#settings.decorations.animatedSpinner || this.spinnerInMessage()) {
			ctx.ui.setWorkingIndicator({ frames: [] });
			return;
		}

		const color = this.#settings.decorations.spinnerColor;
		ctx.ui.setWorkingIndicator({
			frames: SPINNER_FRAMES.map((frame) => getThinkingLevelColorizer(ctx.ui.theme, color, ctx.thinkingLevel)(frame)),
		});
	}

	private stopTimer(): void {
		if (this.#state.timer) {
			clearInterval(this.#state.timer);
			this.#state.timer = null;
		}
	}

	private updateResponseModel(raw: unknown): void {
		if (raw === this.#state.lastResponseModelRaw) return;
		this.#state.lastResponseModelRaw = raw;
		const responseModel = typeof raw === "string" ? stripControlChars(raw).trim() : "";
		const selectedModel = this.#currentCtx?.model?.id;
		if (responseModel && modelsResemble(selectedModel, responseModel)) {
			if (this.#state.responseModel) {
				this.#state.responseModel = "";
				this.tick();
			}
			return;
		}
		if (responseModel && responseModel !== this.#state.responseModel) {
			this.#state.responseModel = responseModel;
			this.tick();
		}
	}

	private cancelResponseModelFade(ctx?: ExtensionContext | null): void {
		const state = this.#state;
		state.responseModelFadeGeneration++;
		if (state.responseModelHoldTimer) {
			clearTimeout(state.responseModelHoldTimer);
			state.responseModelHoldTimer = null;
		}
		if (state.responseModelFadeTimer) {
			clearInterval(state.responseModelFadeTimer);
			state.responseModelFadeTimer = null;
		}
		const activeCtx = ctx ?? this.#currentCtx;
		if (activeCtx && this.usable(activeCtx)) {
			activeCtx.ui.setStatus(RESPONSE_MODEL_STATUS_KEY, undefined);
		}
	}

	private startResponseModelFade(ctx: ExtensionContext, model: string, color: ThinkingLevelColor, dimmed: boolean): void {
		this.cancelResponseModelFade(ctx);
		const generation = this.#state.responseModelFadeGeneration;
		const colorizer = getResponseModelColorizer(ctx.ui.theme, color, ctx.thinkingLevel, ctx.model?.provider);
		const render = (shade?: number): void => {
			const colored = shade === undefined
				? colorizer(model)
				: fadeThemeColorString(
					model,
					shade,
					ctx.ui.theme,
					colorizer,
				);
			const responseModel = dimmed ? dimAttribute(colored) : colored;
			ctx.ui.setStatus(RESPONSE_MODEL_STATUS_KEY, responseModel);
		};
		render();
		this.#state.responseModelHoldTimer = setTimeout(() => {
			if (this.#state.responseModelFadeGeneration !== generation) return;
			this.#state.responseModelHoldTimer = null;
			let shade = 0;
			render(shade++);
			this.#state.responseModelFadeTimer = setInterval(() => {
				if (this.#state.responseModelFadeGeneration !== generation) return;
				if (shade >= TOKEN_RATE_FADE_SHADE_COUNT) {
					this.cancelResponseModelFade(ctx);
					return;
				}
				render(shade++);
			}, RESPONSE_MODEL_FADE_MS / TOKEN_RATE_FADE_SHADE_COUNT);
		}, RESPONSE_MODEL_HOLD_MS);
	}

	private startTimer(): void {
		if (this.#state.timer) return;

		const features = this.#settings.features;
		const decorations = this.#settings.decorations;
		let interval: number | undefined;
		if (decorations.shimmer) interval = SHIMMER_INTERVAL_MS;
		else if (decorations.tokenActivityMonitor || features.outputTokens || features.tokenRate) interval = METER_INTERVAL_MS;
		else if (features.elapsedTime) interval = ELAPSED_INTERVAL_MS;
		if (this.spinnerInMessage()) interval = Math.min(interval ?? SPINNER_FRAME_MS, SPINNER_FRAME_MS);
		if (interval) this.#state.timer = setInterval(() => this.tick(), interval);
	}

	private pickWorkingWord(): WorkingTextSelection {
		return pickWorkingTextSelection(this.#settings.wordPacks, this.#allPacks);
	}

	private resetTurn(now: number): void {
		this.cancelResponseModelFade();
		const state = this.#state;
		state.startTime = now;
		state.shimmerOrigin = now;
		state.workingText = this.pickWorkingWord();
		state.confirmTokens = 0;
		state.liveTokens = 0;
		state.responseModel = "";
		state.lastResponseModelRaw = NOT_SENT;
		state.activityMeter.reset();
		resetTokenRateState(state);
		state.midTurnInputs = 0;
		state.lastMessage = NOT_SENT;
		this.#counter.reset();
	}

	private tick(): void {
		const ctx = this.#currentCtx;
		const state = this.#state;
		if (!state.busy || !ctx) return;
		if (state.waiting) {
			const msg = ctx.ui.theme.fg("dim", waitingLabel(state.waiting));
			if (msg !== state.lastMessage) {
				state.lastMessage = msg;
				ctx.ui.setWorkingMessage(msg);
			}
			return;
		}

		const now = Date.now();
		const total = state.confirmTokens + state.liveTokens;
		const features = this.#settings.features;
		const decorations = this.#settings.decorations;
		let hasNewTokenCount = false;
		if ((decorations.tokenActivityMonitor || features.tokenRate) && now - state.lastTokenRateSampledAt >= METER_INTERVAL_MS) {
			// Do not reset the fade for an EMA-only decay while output is quiet.
			hasNewTokenCount = total > state.lastTokenRateTotal;
			state.lastTokenRateTotal = total;
			const tokenRate = state.rateTracker.sample(total, now);
			if (decorations.tokenActivityMonitor) state.activityMeter.push(rateToLevel(tokenRate));
			state.lastTokenRateSampledAt = now;
		}
		const spinner = this.spinnerInMessage()
			? getThinkingLevelColorizer(ctx.ui.theme, decorations.spinnerColor, ctx.thinkingLevel)(SPINNER_FRAMES[Math.floor(now / SPINNER_FRAME_MS) % SPINNER_FRAMES.length]!)
			: "";
		const responseModelColored = features.responseModel && state.responseModel
			? getResponseModelColorizer(ctx.ui.theme, decorations.responseModelColor, ctx.thinkingLevel, ctx.model?.provider)(state.responseModel)
			: "";
		const responseModel = responseModelColored && decorations.responseModelDimmed ? dimAttribute(responseModelColored) : responseModelColored;
		if (isFullyDefaultAppearance(features, decorations)) {
			const msg = spinner || responseModel
				? buildWorkingMessage(ctx.ui.theme, { spinner, text: ctx.ui.theme.fg("dim", DEFAULT_WORKING_WORD), responseModel }, this.#settings.loaderOrder)
				: undefined;
			if (msg !== state.lastMessage) {
				state.lastMessage = msg;
				ctx.ui.setWorkingMessage(msg);
			}
			return;
		}

		const word = features.substituteDefaultMessage ? state.workingText.text : DEFAULT_WORKING_WORD;
		const styled = decorations.shimmer
			? shimmerString(word, now - state.shimmerOrigin, ctx.ui.theme, decorations.shimmerDirection, decorations.shimmerSpeed, decorations.shimmerInverted)
			: ctx.ui.theme.fg("text", word);
		let meter = "";
		if (decorations.tokenActivityMonitor) {
			const meterColorizer = getThinkingLevelColorizer(ctx.ui.theme, decorations.meterColor, ctx.thinkingLevel);
			meter = state.activityMeter.render((level, char) =>
				ActivityMeter.colorizeCell(level, char, ctx.ui.theme, meterColorizer, decorations.meterDimmed),
			);
		}
		let tokenRateText = "";
		if (features.tokenRate) {
			const latestTokenRate = formatTokenRate(state.rateTracker.tokenRate);
			if (latestTokenRate && hasNewTokenCount) {
				state.tokenRateText = latestTokenRate;
				state.tokenRateFadeStartsAt = now + TOKEN_RATE_HOLD_MS;
			} else if (now >= state.tokenRateFadeStartsAt + TOKEN_RATE_FADE_MS) {
				state.tokenRateText = "";
			}
			tokenRateText = state.tokenRateText;
		}
		let tokenRateSegment = "";
		if (features.tokenRate) {
			if (!tokenRateText) {
				tokenRateSegment = ctx.ui.theme.fg("dim", TOKEN_RATE_PLACEHOLDER);
			} else {
				const tokenRateColorizer = getThinkingLevelColorizer(ctx.ui.theme, decorations.tokenRateColor, ctx.thinkingLevel);
				tokenRateSegment = now < state.tokenRateFadeStartsAt
					? tokenRateColorizer(tokenRateText)
					: fadeThemeColorString(
						tokenRateText,
						Math.floor((now - state.tokenRateFadeStartsAt) / (TOKEN_RATE_FADE_MS / TOKEN_RATE_FADE_SHADE_COUNT)),
						ctx.ui.theme,
						tokenRateColorizer,
					);
			}
		}
		const tokenRateStyled = tokenRateSegment && decorations.tokenRateDimmed ? dimAttribute(tokenRateSegment) : tokenRateSegment;
		const msg = buildWorkingMessage(
			ctx.ui.theme,
			{
				spinner,
				text: styled,
				meter,
				elapsed: features.elapsedTime ? formatElapsed(now - state.startTime) : "",
				tokens: features.outputTokens ? `↓ ${formatTokens(total)} tokens` : "",
				tokenRate: tokenRateStyled,
				responseModel,
			},
			this.#settings.loaderOrder,
		);
		if (msg !== state.lastMessage) {
			state.lastMessage = msg;
			ctx.ui.setWorkingMessage(msg);
		}
	}

	async showSettings(ctx: ExtensionCommandContext, page: LoaderMenuPage): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/frame-settings 需要在 TUI 模式下使用", "error");
			return;
		}

		this.#userPacks = loadUserWordPacks();
		this.#allPacks = [...this.#bundledPacks, ...this.#userPacks];
		const before = this.indicatorFingerprint();
		const preview = new PreviewRenderer(ctx, this.#allPacks);
		const result = await showMenu<Record<string, boolean | string>>(ctx, {
			title: page === "prompt" ? "pi-frame 设置 · 输入框" : "pi-frame 设置 · 加载动画",
			maxHeight: "75%",
			sections: buildMenuSections(page, this.#settings, this.#bundledPacks, this.#userPacks),
			hints: ["↑↓ 移动", "PgUp/PgDn 翻页", "←→ 切换选项", "␣ 开关", "⏎ 应用", "esc 取消"],
			preview: preview.render.bind(preview),
		});
		if (!result.applied) return;

		const updatedSettings = applyMenuResult(this.#settings, result.values);
		try {
			saveSettings(updatedSettings);
		} catch {
			ctx.ui.notify("设置保存失败", "error");
			return;
		}

		this.#settings = updatedSettings;
		if (before !== this.indicatorFingerprint()) {
			if (this.#state.waiting) this.applyWaitingIndicator(ctx);
			else this.applyIndicator(ctx);
		}
		this.#state.activityMeter.setDirection(this.#settings.decorations.meterDirection);
		if (this.#state.busy) {
			this.stopTimer();
			this.startTimer();
			this.tick();
		}
		ctx.ui.notify("输入框与加载动画设置已保存", "info");
	}
}
