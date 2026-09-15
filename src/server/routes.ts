/** OpenAI-compatible HTTP route handlers backed by Codex CLI. */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { CodexSubprocess } from "../subprocess/manager.js";
import {
  normalizeReasoningEffort,
  openaiToCodex,
  prepareCodexInput,
  type PreparedCodexInput,
} from "../adapter/openai-to-codex.js";
import { AttachmentError } from "../attachments/attachment-store.js";
import { createDoneChunk, createTextChunk, codexResultToOpenai } from "../adapter/codex-to-openai.js";
import { clearSession, getSession, setSession } from "../subprocess/session-store.js";
import {
  AgentBridgeError,
  isAgentBridgeRequest,
  runAgentBridge,
  type AgentBridgeOutput,
} from "../subprocess/agent-bridge.js";
import type { OpenAIChatChunk, OpenAIChatRequest, OpenAIChatResponse } from "../types/openai.js";
import type { CodexResult } from "../types/codex-cli.js";

interface SessionContext {
  sessionKey?: string;
  threadId?: string;
  resume: boolean;
  messageCount: number;
}

/** Model IDs available through the authenticated Codex CLI on this server. */
export const AVAILABLE_MODEL_IDS = [
  "codex",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.3-codex-spark",
] as const;

async function resolveCliInput(body: OpenAIChatRequest): Promise<{ input: PreparedCodexInput; session: SessionContext }> {
  const sessionKey = body.user;
  const existing = sessionKey ? getSession(sessionKey) : undefined;
  if (existing) {
    const appended = body.messages.slice(existing.messageCount).filter((message) => message.role !== "assistant");
    return {
      input: await prepareCodexInput(body, appended.length ? appended : body.messages),
      session: {
        sessionKey,
        threadId: existing.threadId,
        resume: true,
        messageCount: body.messages.length,
      },
    };
  }
  return {
    input: await prepareCodexInput(body),
    session: { sessionKey, resume: false, messageCount: body.messages.length },
  };
}

export async function handleChatCompletions(req: Request, res: Response): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({
      error: {
        message: "messages is required and must be a non-empty array",
        type: "invalid_request_error",
        code: "invalid_messages",
      },
    });
    return;
  }

  if (body.reasoning_effort !== undefined && !normalizeReasoningEffort(body.reasoning_effort)) {
    res.status(400).json({
      error: {
        message: "reasoning_effort must be one of: none, minimal, light, low, medium, high, extra-high, xhigh, max",
        type: "invalid_request_error",
        code: "invalid_reasoning_effort",
      },
    });
    return;
  }

  try {
    if (isAgentBridgeRequest(body)) {
      const isContinuation = body.messages.some((message) => message.role === "tool");
      const preparedInput = isContinuation ? undefined : await prepareCodexInput(body);
      await handleAgentBridgeResponse(res, body, requestId, preparedInput);
      return;
    }

    const { input, session } = await resolveCliInput(body);
    const subprocess = new CodexSubprocess();
    if (body.stream === true) {
      await handleStreamingResponse(res, subprocess, input, requestId, session);
    } else {
      await handleNonStreamingResponse(res, subprocess, input, requestId, session);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (!res.headersSent) {
      const structured = error instanceof AgentBridgeError || error instanceof AttachmentError;
      const status = structured ? error.status : 500;
      const code = structured ? error.code : null;
      res.status(status).json({ error: { message, type: status < 500 ? "invalid_request_error" : "server_error", code } });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

async function handleAgentBridgeResponse(
  res: Response,
  body: OpenAIChatRequest,
  requestId: string,
  preparedInput?: PreparedCodexInput
): Promise<void> {
  const responseModel = openaiToCodex(body).responseModel;
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", abort);
  if (body.stream === true) {
    await writeAgentBridgeStream(res, body, requestId, responseModel, controller.signal, preparedInput);
    res.removeListener("close", abort);
    return;
  }
  try {
    const output = await runAgentBridge(body, { signal: controller.signal, preparedInput });
    res.json(agentBridgeResponse(output, requestId, responseModel));
  } finally {
    res.removeListener("close", abort);
  }
}

function agentBridgeResponse(
  output: AgentBridgeOutput,
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
      message: {
        role: "assistant",
        content: output.text || null,
        tool_calls: output.toolCalls.length ? output.toolCalls : undefined,
      },
      finish_reason: output.finishReason,
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function writeAgentBridgeStream(
  res: Response,
  body: OpenAIChatRequest,
  requestId: string,
  model: string,
  signal: AbortSignal,
  preparedInput?: PreparedCodexInput
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);
  res.flushHeaders();
  res.write(":ok\n\n");

  const created = Math.floor(Date.now() / 1000);
  let first = true;
  let streamedText = "";
  const writeText = (delta: string) => {
    if (!delta || res.writableEnded || res.destroyed) return;
    streamedText += delta;
    res.write(`data: ${JSON.stringify(createTextChunk(requestId, model, delta, first))}\n\n`);
    first = false;
  };

  try {
    const output = await runAgentBridge(body, { onTextDelta: writeText, signal, preparedInput });
    if (output.text.startsWith(streamedText)) writeText(output.text.slice(streamedText.length));
    else if (!streamedText) writeText(output.text);

    if (output.toolCalls.length && !res.writableEnded && !res.destroyed) {
      const tools: OpenAIChatChunk = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: {
            ...(first ? { role: "assistant" as const } : {}),
            tool_calls: output.toolCalls.map((call, index) => ({
              index,
              id: call.id,
              type: "function" as const,
              function: call.function,
            })),
          },
          finish_reason: null,
        }],
      };
      res.write(`data: ${JSON.stringify(tools)}\n\n`);
      first = false;
    }

    if (!res.writableEnded && !res.destroyed) {
      const done: OpenAIChatChunk = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: output.finishReason }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      res.write(`data: ${JSON.stringify(done)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (error) {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : "Unknown error", type: "server_error", code: null } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
}

function rememberSession(session: SessionContext, result: CodexResult): void {
  if (session.sessionKey && result.threadId) {
    setSession(session.sessionKey, result.threadId, session.messageCount);
  }
}

function forgetFailedResume(session: SessionContext): void {
  if (session.resume && session.sessionKey) clearSession(session.sessionKey);
}

async function handleStreamingResponse(
  res: Response,
  subprocess: CodexSubprocess,
  input: PreparedCodexInput,
  requestId: string,
  session: SessionContext
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);
  res.flushHeaders();
  res.write(":ok\n\n");

  return new Promise<void>((resolve) => {
    let finished = false;
    let first = true;

    const finish = () => {
      if (finished) return;
      finished = true;
      input.attachmentStore.cleanup();
      if (!res.writableEnded) res.end();
      resolve();
    };

    res.on("close", () => {
      if (!finished) subprocess.kill();
      input.attachmentStore.cleanup();
      finished = true;
      resolve();
    });

    subprocess.on("agent_message", (text: string) => {
      if (finished || res.writableEnded || !text) return;
      const chunk = createTextChunk(requestId, input.responseModel, text, first);
      first = false;
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    });

    subprocess.on("result", (result: CodexResult) => {
      if (finished) return;
      rememberSession(session, result);
      const done = createDoneChunk(requestId, input.responseModel, result.usage);
      res.write(`data: ${JSON.stringify(done)}\n\n`);
      res.write("data: [DONE]\n\n");
      finish();
    });

    subprocess.on("error", (error: Error) => {
      if (finished) return;
      forgetFailedResume(session);
      res.write(`data: ${JSON.stringify({
        error: { message: error.message, type: "server_error", code: null },
      })}\n\n`);
      finish();
    });

    subprocess.on("close", (code: number | null) => {
      if (finished) return;
      forgetFailedResume(session);
      res.write(`data: ${JSON.stringify({
        error: {
          message: `Codex CLI exited with code ${code} without completing a turn`,
          type: "server_error",
          code: null,
        },
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      finish();
    });

    subprocess.start(input.prompt, {
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      threadId: session.threadId,
      resume: session.resume,
      imagePaths: input.imagePaths,
      redactAttachmentData: input.attachmentStore.directory !== undefined,
    }).catch((error: Error) => {
      if (finished) return;
      forgetFailedResume(session);
      res.write(`data: ${JSON.stringify({
        error: { message: error.message, type: "server_error", code: null },
      })}\n\n`);
      finish();
    });
  });
}

async function handleNonStreamingResponse(
  res: Response,
  subprocess: CodexSubprocess,
  input: PreparedCodexInput,
  requestId: string,
  session: SessionContext
): Promise<void> {
  return new Promise<void>((resolve) => {
    let finished = false;

    const sendError = (message: string) => {
      if (finished) return;
      finished = true;
      input.attachmentStore.cleanup();
      forgetFailedResume(session);
      res.status(500).json({ error: { message, type: "server_error", code: null } });
      resolve();
    };

    subprocess.on("result", (result: CodexResult) => {
      if (finished) return;
      finished = true;
      input.attachmentStore.cleanup();
      rememberSession(session, result);
      res.json(codexResultToOpenai(result, requestId, input.responseModel));
      resolve();
    });
    subprocess.on("error", (error: Error) => sendError(error.message));
    res.on("close", () => {
      if (finished) return;
      finished = true;
      subprocess.kill();
      input.attachmentStore.cleanup();
      resolve();
    });
    subprocess.on("close", (code: number | null) => {
      if (!finished) sendError(`Codex CLI exited with code ${code} without completing a turn`);
    });
    subprocess.start(input.prompt, {
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      threadId: session.threadId,
      resume: session.resume,
      imagePaths: input.imagePaths,
      redactAttachmentData: input.attachmentStore.directory !== undefined,
    }).catch((error: Error) => sendError(error.message));
  });
}

export function handleModels(_req: Request, res: Response): void {
  res.json({
    object: "list",
    data: AVAILABLE_MODEL_IDS.map((id) => ({
      id,
      object: "model",
      owned_by: "openai",
      created: Math.floor(Date.now() / 1000),
    })),
  });
}

export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "codex-cli",
    timestamp: new Date().toISOString(),
  });
}
