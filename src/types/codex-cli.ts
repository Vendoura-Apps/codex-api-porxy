/** Machine-readable events emitted by `codex exec --json`. */

export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
}

export interface CodexThreadStarted {
  type: "thread.started";
  thread_id: string;
}

export interface CodexAgentMessageItem {
  id: string;
  type: "agent_message";
  text: string;
}

export interface CodexItemCompleted {
  type: "item.completed";
  item: CodexAgentMessageItem | Record<string, unknown>;
}

export interface CodexAgentMessageCompleted {
  type: "item.completed";
  item: CodexAgentMessageItem;
}

export interface CodexTurnCompleted {
  type: "turn.completed";
  usage: CodexUsage;
}

export interface CodexFailureEvent {
  type: "turn.failed" | "error";
  error?: { message?: string } | string;
  message?: string;
}

export type CodexEvent =
  | CodexThreadStarted
  | CodexItemCompleted
  | CodexTurnCompleted
  | CodexFailureEvent
  | { type: string; [key: string]: unknown };

export interface CodexResult {
  threadId?: string;
  text: string;
  usage: CodexUsage;
}

export function isThreadStarted(event: CodexEvent): event is CodexThreadStarted {
  return event.type === "thread.started" && typeof (event as CodexThreadStarted).thread_id === "string";
}

export function isAgentMessage(event: CodexEvent): event is CodexAgentMessageCompleted {
  if (event.type !== "item.completed") return false;
  const item = (event as CodexItemCompleted).item;
  return item?.type === "agent_message" && typeof (item as CodexAgentMessageItem).text === "string";
}

export function isTurnCompleted(event: CodexEvent): event is CodexTurnCompleted {
  return event.type === "turn.completed" && typeof (event as CodexTurnCompleted).usage === "object";
}

export function isFailureEvent(event: CodexEvent): event is CodexFailureEvent {
  return event.type === "turn.failed" || event.type === "error";
}

export function failureMessage(event: CodexFailureEvent): string {
  if (typeof event.message === "string") return event.message;
  if (typeof event.error === "string") return event.error;
  if (event.error && typeof event.error.message === "string") return event.error.message;
  return `Codex CLI reported ${event.type}`;
}
