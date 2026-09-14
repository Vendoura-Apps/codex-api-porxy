/**
 * End-to-end test for the Codex CLI API proxy.
 *
 * Starts the real server, sends HTTP requests, and verifies responses
 * against the OpenAI API format. Live completion tests require an installed
 * and authenticated Codex CLI and RUN_CODEX_E2E=1.
 *
 * Run: npm run test:e2e
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./server/index.js";
import { shutdownAgentBridges } from "./subprocess/agent-bridge.js";
import type { Server } from "http";
import type { AddressInfo } from "net";

const RUN_LIVE = process.env.RUN_CODEX_E2E === "1";

let baseUrl: string;
let server: Server;

// Longer timeout — Codex CLI can take a while
const TEST_TIMEOUT = 120_000;

before(async () => {
  server = await startServer({ port: 0 });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  shutdownAgentBridges();
  await stopServer();
});

// ─── Health & Models ────────────────────────────────────────────────

describe("health and models", () => {
  it("GET /health returns ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.status, "ok");
    assert.equal(body.provider, "codex-cli");
    assert.ok(body.timestamp);
  });

  it("GET /v1/models lists all model IDs", async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data));

    const ids = body.data.map((m: any) => m.id);
    for (const expected of ["codex"]) {
      assert.ok(ids.includes(expected), `missing model ${expected}`);
    }

    for (const model of body.data) {
      assert.equal(model.object, "model");
      assert.equal(model.owned_by, "openai");
      assert.ok(typeof model.created === "number");
    }
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/v1/nonexistent`);
    assert.equal(res.status, 404);
  });

  it("returns 400 for empty messages", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "codex", messages: [] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.ok(body.error);
    assert.equal(body.error.code, "invalid_messages");
  });
});

// ─── Non-streaming completion ───────────────────────────────────────

describe("non-streaming completion", { timeout: TEST_TIMEOUT, skip: !RUN_LIVE }, () => {
  it("bridges a client function tool through Codex app-server", async () => {
    const tools = [{
      type: "function",
      function: {
        name: "client_echo",
        description: "Returns the supplied text from the client. Use it when asked to echo.",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    }];
    const userMessage = {
      role: "user",
      content: "Call client_echo with HELLO and then reply with its returned text only.",
    };
    const first = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        reasoning_effort: "low",
        messages: [userMessage],
        tools,
      }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as any;
    assert.equal(firstBody.choices[0].finish_reason, "tool_calls");
    const toolCall = firstBody.choices[0].message.tool_calls[0];
    assert.equal(toolCall.function.name, "client_echo");

    const second = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        reasoning_effort: "low",
        messages: [
          userMessage,
          firstBody.choices[0].message,
          { role: "tool", tool_call_id: toolCall.id, content: "CLIENT-BRIDGE-OK" },
        ],
        tools,
      }),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json() as any;
    assert.equal(secondBody.choices[0].finish_reason, "stop");
    assert.match(secondBody.choices[0].message.content, /CLIENT-BRIDGE-OK/);
  });

  it("returns a valid OpenAI response for a simple prompt", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        stream: false,
        messages: [
          {
            role: "user",
            content: "Reply with exactly the word 'pong' and nothing else.",
          },
        ],
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as any;

    // Shape checks
    assert.ok(body.id, "missing id");
    assert.equal(body.object, "chat.completion");
    assert.ok(typeof body.created === "number");
    assert.ok(body.model, "missing model");

    // Choices
    assert.ok(Array.isArray(body.choices));
    assert.equal(body.choices.length, 1);
    const choice = body.choices[0];
    assert.equal(choice.index, 0);
    assert.equal(choice.finish_reason, "stop");
    assert.equal(choice.message.role, "assistant");
    assert.ok(typeof choice.message.content === "string");
    assert.ok(choice.message.content.length > 0, "empty content");

    // Usage
    assert.ok(body.usage, "missing usage");
    assert.ok(typeof body.usage.prompt_tokens === "number");
    assert.ok(typeof body.usage.completion_tokens === "number");
    assert.ok(typeof body.usage.total_tokens === "number");
    assert.ok(body.usage.prompt_tokens > 0, "prompt_tokens should be > 0");
    assert.ok(body.usage.total_tokens > 0, "total_tokens should be > 0");
  });

  it("handles array-style content blocks", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        stream: false,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Reply with exactly 'ok'." }],
          },
        ],
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.choices[0].message.content.length > 0);
  });

  it("resumes a Codex thread when request.user is stable", async () => {
    const user = `e2e-${Date.now()}`;
    const first = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        user,
        messages: [{ role: "user", content: "Remember the codeword LANTERN. Reply ACK." }],
      }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as any;

    const second = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        user,
        messages: [
          { role: "user", content: "Remember the codeword LANTERN. Reply ACK." },
          { role: "assistant", content: firstBody.choices[0].message.content },
          { role: "user", content: "What codeword did I ask you to remember? Reply with only it." },
        ],
      }),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json() as any;
    assert.match(secondBody.choices[0].message.content, /LANTERN/i);
  });
});

// ─── Streaming completion ───────────────────────────────────────────

describe("streaming completion", { timeout: TEST_TIMEOUT, skip: !RUN_LIVE }, () => {
  it("streams an OpenAI-compatible client tool call", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        reasoning_effort: "low",
        stream: true,
        messages: [{ role: "user", content: "Call client_echo with STREAM." }],
        tools: [{
          type: "function",
          function: {
            name: "client_echo",
            description: "Returns text from the client. Always use it for echo requests.",
            parameters: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        }],
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const events = (await res.text())
      .split("\n")
      .filter((line) => line.startsWith("data: {") )
      .map((line) => JSON.parse(line.slice(6)));
    const toolChunk = events.find((event) => event.choices?.[0]?.delta?.tool_calls?.length);
    assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.name, "client_echo");
    assert.ok(events.some((event) => event.choices?.[0]?.finish_reason === "tool_calls"));
  });

  it("returns valid SSE chunks with usage in final chunk", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        stream: true,
        messages: [
          {
            role: "user",
            content: "Reply with exactly the word 'pong' and nothing else.",
          },
        ],
      }),
    });

    assert.equal(res.status, 200);
    assert.ok(
      res.headers.get("content-type")?.includes("text/event-stream"),
      "expected text/event-stream content type"
    );

    // Read the full SSE stream
    const text = await res.text();
    const lines = text.split("\n");

    const chunks: any[] = [];
    let gotDone = false;

    for (const line of lines) {
      if (line === "data: [DONE]") {
        gotDone = true;
        continue;
      }
      if (!line.startsWith("data: ")) continue;
      const json = JSON.parse(line.slice(6));
      chunks.push(json);
    }

    assert.ok(gotDone, "stream should end with [DONE]");
    assert.ok(chunks.length >= 1, "should have at least one chunk");

    // First data chunk should have role: "assistant" in delta
    const firstContentChunk = chunks.find(
      (c) => c.choices?.[0]?.delta?.role === "assistant"
    );
    assert.ok(firstContentChunk, "first chunk should set role to assistant");

    // All chunks should have correct shape
    for (const chunk of chunks) {
      assert.ok(chunk.id, "chunk missing id");
      assert.equal(chunk.object, "chat.completion.chunk");
      assert.ok(typeof chunk.created === "number");
      assert.ok(chunk.model, "chunk missing model");
      assert.ok(Array.isArray(chunk.choices));
      assert.equal(chunk.choices.length, 1);
    }

    // Last chunk should have finish_reason: "stop"
    const lastChunk = chunks[chunks.length - 1];
    assert.equal(lastChunk.choices[0].finish_reason, "stop");

    // Last chunk should include usage (our new feature)
    assert.ok(lastChunk.usage, "final chunk should include usage");
    assert.ok(typeof lastChunk.usage.prompt_tokens === "number");
    assert.ok(typeof lastChunk.usage.completion_tokens === "number");
    assert.ok(typeof lastChunk.usage.total_tokens === "number");

    // Concatenated text from all deltas should be non-empty
    const fullText = chunks
      .map((c) => c.choices[0].delta.content || "")
      .join("");
    assert.ok(fullText.length > 0, "streamed text should be non-empty");
  });
});
