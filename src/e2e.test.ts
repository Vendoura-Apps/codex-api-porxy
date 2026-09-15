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
import { deflateSync } from "node:zlib";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RUN_LIVE = process.env.RUN_CODEX_E2E === "1";

let baseUrl: string;
let server: Server;

// Longer timeout — Codex CLI can take a while
const TEST_TIMEOUT = 120_000;

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function redPngDataUrl(): string {
  const width = 8;
  const height = 8;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.from([0, ...Array.from({ length: width }, () => [255, 0, 0]).flat()]);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

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

  it("returns a structured error for remote attachment URLs", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "codex",
        messages: [{
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/private.png" } }],
        }],
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.equal(body.error.code, "remote_attachment_url_disabled");
    assert.doesNotMatch(body.error.message, /private\.png/);
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

  it("passes a PNG to codex exec for a non-streaming completion", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        reasoning_effort: "low",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Identify the dominant color in the attached image. Reply with only the color name." },
            { type: "image_url", image_url: { url: redPngDataUrl(), detail: "auto" } },
          ],
        }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.match(body.choices[0].message.content, /red/i);
  });

  it("keeps an image through an agent tool continuation and cleans it afterward", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-attachment-e2e-"));
    const previousRoot = process.env.CODEX_ATTACHMENT_TMPDIR;
    process.env.CODEX_ATTACHMENT_TMPDIR = root;
    try {
      const tools = [{
        type: "function",
        function: {
          name: "client_echo",
          description: "Return the supplied text. Always call it when the user asks.",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      }];
      const user = {
        role: "user",
        content: [
          { type: "text", text: "Inspect the image, call client_echo with READY, then report its dominant color and the tool result." },
          { type: "image_url", image_url: { url: redPngDataUrl() } },
        ],
      };
      const firstResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-luna", reasoning_effort: "low", messages: [user], tools }),
      });
      assert.equal(firstResponse.status, 200);
      const first = await firstResponse.json() as any;
      assert.equal(first.choices[0].finish_reason, "tool_calls");
      assert.ok((await readdir(root)).length > 0, "attachment should remain while the tool call is pending");
      const call = first.choices[0].message.tool_calls[0];

      const secondResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          reasoning_effort: "low",
          messages: [user, first.choices[0].message, {
            role: "tool", tool_call_id: call.id, content: "READY-OK",
          }],
          tools,
        }),
      });
      assert.equal(secondResponse.status, 200);
      const second = await secondResponse.json() as any;
      assert.match(second.choices[0].message.content, /red/i);
      assert.match(second.choices[0].message.content, /READY-OK/i);
      assert.deepEqual(await readdir(root), []);
    } finally {
      if (previousRoot === undefined) delete process.env.CODEX_ATTACHMENT_TMPDIR;
      else process.env.CODEX_ATTACHMENT_TMPDIR = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
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

  it("streams a multimodal PNG response", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        reasoning_effort: "low",
        stream: true,
        messages: [{
          role: "user",
          content: [
            { type: "input_text", text: "Identify the dominant color in this image. Reply with only the color name." },
            { type: "input_image", image_url: redPngDataUrl() },
          ],
        }],
      }),
    });
    assert.equal(res.status, 200);
    const chunks = (await res.text()).split("\n")
      .filter((line) => line.startsWith("data: {") )
      .map((line) => JSON.parse(line.slice(6)));
    const text = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || "").join("");
    assert.match(text, /red/i);
    assert.equal(chunks.at(-1)?.choices?.[0]?.finish_reason, "stop");
  });
});
