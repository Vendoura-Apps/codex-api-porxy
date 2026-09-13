/** OpenAI-compatible HTTP route handlers backed by Codex CLI. */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { CodexSubprocess } from "../subprocess/manager.js";
import { openaiToCodex, openaiToCodexDelta, type CodexInput } from "../adapter/openai-to-codex.js";
import { createDoneChunk, createTextChunk, codexResultToOpenai } from "../adapter/codex-to-openai.js";
import { clearSession, getSession, setSession } from "../subprocess/session-store.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type { CodexResult } from "../types/codex-cli.js";

interface SessionContext {
  sessionKey?: string;
  threadId?: string;
  resume: boolean;
  messageCount: number;
}

function resolveCliInput(body: OpenAIChatRequest): { input: CodexInput; session: SessionContext } {
  const sessionKey = body.user;
  const existing = sessionKey ? getSession(sessionKey) : undefined;
  if (existing) {
    return {
      input: openaiToCodexDelta(body, existing.messageCount),
      session: {
        sessionKey,
        threadId: existing.threadId,
        resume: true,
        messageCount: body.messages.length,
      },
    };
  }
  return {
    input: openaiToCodex(body),
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

  const { input, session } = resolveCliInput(body);
  const subprocess = new CodexSubprocess();
  try {
    if (body.stream === true) {
      await handleStreamingResponse(res, subprocess, input, requestId, session);
    } else {
      await handleNonStreamingResponse(res, subprocess, input, requestId, session);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (!res.headersSent) {
      res.status(500).json({ error: { message, type: "server_error", code: null } });
    } else if (!res.writableEnded) {
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
  input: CodexInput,
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
      if (!res.writableEnded) res.end();
      resolve();
    };

    res.on("close", () => {
      if (!finished) subprocess.kill();
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
      threadId: session.threadId,
      resume: session.resume,
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
  input: CodexInput,
  requestId: string,
  session: SessionContext
): Promise<void> {
  return new Promise<void>((resolve) => {
    let finished = false;

    const sendError = (message: string) => {
      if (finished) return;
      finished = true;
      forgetFailedResume(session);
      res.status(500).json({ error: { message, type: "server_error", code: null } });
      resolve();
    };

    subprocess.on("result", (result: CodexResult) => {
      if (finished) return;
      finished = true;
      rememberSession(session, result);
      res.json(codexResultToOpenai(result, requestId, input.responseModel));
      resolve();
    });
    subprocess.on("error", (error: Error) => sendError(error.message));
    subprocess.on("close", (code: number | null) => {
      if (!finished) sendError(`Codex CLI exited with code ${code} without completing a turn`);
    });
    subprocess.start(input.prompt, {
      model: input.model,
      threadId: session.threadId,
      resume: session.resume,
    }).catch((error: Error) => sendError(error.message));
  });
}

export function handleModels(_req: Request, res: Response): void {
  res.json({
    object: "list",
    data: [{
      id: "codex",
      object: "model",
      owned_by: "openai",
      created: Math.floor(Date.now() / 1000),
    }],
  });
}

export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "codex-cli",
    timestamp: new Date().toISOString(),
  });
}
