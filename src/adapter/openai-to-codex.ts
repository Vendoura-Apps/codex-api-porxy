/** Convert OpenAI chat requests into input for Codex CLI. */

import type { OpenAIChatRequest, OpenAIContentBlock } from "../types/openai.js";

export interface CodexInput {
  prompt: string;
  /** Undefined means: use the model configured by Codex CLI. */
  model?: string;
  /** Undefined means: use the reasoning effort configured by Codex CLI. */
  reasoningEffort?: CodexReasoningEffort;
  responseModel: string;
}

export type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const REASONING_EFFORTS: Readonly<Record<string, CodexReasoningEffort>> = {
  none: "none",
  minimal: "minimal",
  light: "low",
  low: "low",
  medium: "medium",
  high: "high",
  "extra-high": "xhigh",
  extra_high: "xhigh",
  "extra high": "xhigh",
  xhigh: "xhigh",
  max: "max",
};

export function normalizeReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  if (typeof value !== "string") return undefined;
  return REASONING_EFFORTS[value.trim().toLowerCase()];
}

export function extractModel(model?: string): { cliModel?: string; responseModel: string } {
  const stripped = (model || "codex").replace(/^(?:codex-cli|codex)\//, "");
  if (stripped === "codex" || stripped === "default" || stripped === "") {
    return { responseModel: "codex" };
  }
  return { cliModel: stripped, responseModel: stripped };
}

function extractText(content: string | OpenAIContentBlock[] | null): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content
    .filter((block) => block.type === "text" || block.type === "input_text")
    .map((block) => block.text)
    .join("\n");
}

export function messagesToPrompt(messages: OpenAIChatRequest["messages"]): string {
  return messages
    .map((message) => {
      const text = extractText(message.content);
      if (message.role === "system") return `<system>\n${text}\n</system>`;
      if (message.role === "assistant") return `<previous_response>\n${text}\n</previous_response>`;
      if (message.role === "tool") {
        const tool = message.name || message.tool_call_id || "tool";
        return `<tool_result name="${tool}">\n${text}\n</tool_result>`;
      }
      return text;
    })
    .join("\n\n")
    .trim();
}

export function openaiToCodex(request: OpenAIChatRequest): CodexInput {
  return {
    prompt: messagesToPrompt(request.messages),
    reasoningEffort: normalizeReasoningEffort(request.reasoning_effort),
    ...extractModel(request.model),
  };
}

export function openaiToCodexDelta(request: OpenAIChatRequest, sinceIndex: number): CodexInput {
  const appended = request.messages.slice(sinceIndex).filter((message) => message.role !== "assistant");
  return {
    prompt: messagesToPrompt(appended.length ? appended : request.messages),
    reasoningEffort: normalizeReasoningEffort(request.reasoning_effort),
    ...extractModel(request.model),
  };
}
