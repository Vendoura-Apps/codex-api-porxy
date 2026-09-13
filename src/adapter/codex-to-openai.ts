/** Convert a completed Codex turn into OpenAI-compatible response objects. */

import type { CodexResult } from "../types/codex-cli.js";
import type { OpenAIChatChunk, OpenAIChatResponse } from "../types/openai.js";

export function createTextChunk(
  requestId: string,
  model: string,
  text: string,
  isFirst: boolean
): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: { role: isFirst ? "assistant" : undefined, content: text },
      finish_reason: null,
    }],
  };
}

export function createDoneChunk(
  requestId: string,
  model: string,
  usage?: CodexResult["usage"]
): OpenAIChatChunk {
  const chunk: OpenAIChatChunk = {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  if (usage) {
    chunk.usage = {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    };
  }
  return chunk;
}

export function codexResultToOpenai(
  result: CodexResult,
  requestId: string,
  model: string
): OpenAIChatResponse {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: result.text },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: result.usage.input_tokens || 0,
      completion_tokens: result.usage.output_tokens || 0,
      total_tokens: (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0),
    },
  };
}
