/** Convert OpenAI chat requests into input for Codex CLI. */

import type { OpenAIChatRequest, OpenAIContentBlock } from "../types/openai.js";

export interface CodexInput {
  prompt: string;
  /** Undefined means: use the model configured by Codex CLI. */
  model?: string;
  responseModel: string;
}

export function extractModel(model?: string): { cliModel?: string; responseModel: string } {
  const stripped = (model || "codex").replace(/^(?:codex-cli|codex)\//, "");
  if (stripped === "codex" || stripped === "default" || stripped === "") {
    return { responseModel: "codex" };
  }
  return { cliModel: stripped, responseModel: stripped };
}

function extractText(content: string | OpenAIContentBlock[]): string {
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
      return text;
    })
    .join("\n\n")
    .trim();
}

export function openaiToCodex(request: OpenAIChatRequest): CodexInput {
  return { prompt: messagesToPrompt(request.messages), ...extractModel(request.model) };
}

export function openaiToCodexDelta(request: OpenAIChatRequest, sinceIndex: number): CodexInput {
  const appended = request.messages.slice(sinceIndex).filter((message) => message.role !== "assistant");
  return {
    prompt: messagesToPrompt(appended.length ? appended : request.messages),
    ...extractModel(request.model),
  };
}
