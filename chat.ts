// Locate pi's chat container and classify its rows. Read-only over pi internals.
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  CustomMessageComponent,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";

export interface Renderable {
  render(width: number): string[];
  invalidate?(): void;
}

export interface ContainerLike extends Renderable {
  children: Renderable[];
}

export interface TuiLike extends ContainerLike {
  requestRender(): void;
}

interface WidgetHost {
  setWidget(key: string, factory: unknown): void;
}

/** pi hands the live TUI to widget factories synchronously; grab it and drop the throwaway widget. */
export function captureTui(ui: WidgetHost, key: string): TuiLike | undefined {
  let captured: TuiLike | undefined;
  ui.setWidget(key, (tui: TuiLike) => {
    captured = tui;
    return { render: () => [] as string[], invalidate: () => {} };
  });
  ui.setWidget(key, undefined);
  return captured;
}

const USER_BOX_CUSTOM_TYPES = new Set(["pi-topping-prompt"]);

export function isUserRow(row: unknown): boolean {
  if (row instanceof UserMessageComponent) return true;
  if (row instanceof CustomMessageComponent) {
    const customType = (row as unknown as { message?: { customType?: string } }).message?.customType;
    return customType !== undefined && USER_BOX_CUSTOM_TYPES.has(customType);
  }
  return false;
}

export function isToolRow(row: unknown): row is ToolExecutionComponent {
  return row instanceof ToolExecutionComponent;
}

/** Skill block that pi renders next to the user prompt; belongs to the user side of a turn. */
export function isSkillRow(row: unknown): boolean {
  return row instanceof SkillInvocationMessageComponent;
}

/**
 * Process noise inside a turn: extension-injected custom messages that are not the user prompt box
 * (background task notifications, extension notes, …) and `!cmd` bash executions.
 */
export function isNoteRow(row: unknown): boolean {
  if (row instanceof BashExecutionComponent) return true;
  return row instanceof CustomMessageComponent && !isUserRow(row);
}

export function isAssistantRow(row: unknown): row is AssistantMessageComponent {
  return row instanceof AssistantMessageComponent;
}

export function isSpacerRow(row: unknown): boolean {
  return row instanceof Spacer;
}

/** Assistant row that renders anything at all (prose or thinking). */
export function assistantHasVisible(row: AssistantMessageComponent): boolean {
  const message = (row as unknown as { lastMessage?: { content?: Array<{ type: string; text?: string; thinking?: string }> } }).lastMessage;
  return message?.content?.some((c) => (c.type === "text" && !!c.text?.trim()) || (c.type === "thinking" && !!c.thinking?.trim())) ?? false;
}

/** Pure tool-call carrier: pi renders nothing for it (errors are shown on the tool row instead). */
export function assistantRendersNothing(row: AssistantMessageComponent): boolean {
  const message = (row as unknown as { lastMessage?: { content?: Array<{ type: string }>; stopReason?: string } }).lastMessage;
  if (!message || assistantHasVisible(row)) return false;
  const hasToolCalls = message.content?.some((c) => c.type === "toolCall") ?? false;
  return hasToolCalls && message.stopReason !== "length";
}

/** Assistant row that carries visible prose (not a pure tool-call carrier). */
export function assistantHasText(row: AssistantMessageComponent): boolean {
  const message = (row as unknown as { lastMessage?: { content?: Array<{ type: string; text?: string }> } }).lastMessage;
  return message?.content?.some((c) => c.type === "text" && !!c.text?.trim()) ?? false;
}

function isPlainContainer(node: unknown): node is ContainerLike {
  return node instanceof Container && (node as object).constructor === Container;
}

function hasChatRows(children: unknown[]): boolean {
  return children.some((c) => isUserRow(c) || isToolRow(c) || isAssistantRow(c));
}

/**
 * documentContainer = Container[headerContainer, loadedResourcesContainer, chatContainer], all plain Containers.
 * Prefer the container that already holds chat rows; fall back to that structural signature (empty session).
 */
export function findChatContainer(root: unknown): ContainerLike | undefined {
  const seen = new Set<unknown>();
  let structural: ContainerLike | undefined;
  const walk = (node: unknown): ContainerLike | undefined => {
    if (!node || typeof node !== "object" || seen.has(node)) return undefined;
    seen.add(node);
    const children = (node as { children?: unknown[] }).children;
    if (!Array.isArray(children)) return undefined;
    if (isPlainContainer(node) && hasChatRows(children)) return node;
    if (!structural && isPlainContainer(node) && children.length === 3 && children.every(isPlainContainer)) {
      structural = children[2] as ContainerLike;
    }
    for (const child of children) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  return walk(root) ?? structural;
}
