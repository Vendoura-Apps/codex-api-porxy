import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AgentBridgeError,
  isAgentBridgeRequest,
  openaiToolsToDynamicTools,
  runAgentBridge,
  shutdownAgentBridges,
} from "./agent-bridge.js";

describe("Codex agent bridge", () => {
  it("converts OpenAI function tools to app-server dynamic tools", () => {
    assert.deepEqual(openaiToolsToDynamicTools([{
      type: "function",
      function: {
        name: "read_file",
        description: "Read a client file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    }]), [{
      type: "function",
      name: "read_file",
      description: "Read a client file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    }]);
  });

  it("detects initial and continuing tool requests", () => {
    assert.equal(isAgentBridgeRequest({
      model: "codex",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    }), true);
    assert.equal(isAgentBridgeRequest({
      model: "codex",
      messages: [{ role: "tool", tool_call_id: "call-1", content: "result" }],
    }), true);
    assert.equal(isAgentBridgeRequest({
      model: "codex",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
      tool_choice: "none",
    }), false);
    assert.equal(isAgentBridgeRequest({
      model: "codex",
      messages: [{ role: "user", content: "hello" }],
    }), false);
  });

  it("rejects invalid dynamic tool names", () => {
    assert.throws(() => openaiToolsToDynamicTools([{
      type: "function",
      function: { name: "terminal command" },
    }]), /Function tool names/);
  });

  it("expires an abandoned turn while waiting for client tool output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-agent-bridge-test-"));
    const fakeCodex = join(directory, "fake-codex.cjs");
    const previousBin = process.env.CODEX_BIN;
    const previousTimeout = process.env.CODEX_AGENT_BRIDGE_TOOL_OUTPUT_TIMEOUT_MS;
    await writeFile(fakeCodex, `#!/usr/bin/env node
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-test" } } });
  else if (message.method === "turn/start") {
    send({ id: message.id, result: {} });
    setTimeout(() => send({
      id: 99,
      method: "item/tool/call",
      params: { threadId: "thread-test", turnId: "turn-test", callId: "call-test", tool: "read_file", arguments: { path: "README.md" } }
    }), 5);
  }
});
`, { mode: 0o700 });
    await chmod(fakeCodex, 0o700);

    try {
      process.env.CODEX_BIN = fakeCodex;
      process.env.CODEX_AGENT_BRIDGE_TOOL_OUTPUT_TIMEOUT_MS = "25";
      const first = await runAgentBridge({
        model: "codex",
        messages: [{ role: "user", content: "Read the file" }],
        tools: [{ type: "function", function: { name: "read_file" } }],
      });
      assert.equal(first.finishReason, "tool_calls");
      assert.equal(first.toolCalls[0]?.id, "call-test");

      await new Promise((resolve) => setTimeout(resolve, 75));
      await assert.rejects(
        runAgentBridge({
          model: "codex",
          messages: [{ role: "tool", tool_call_id: "call-test", content: "file contents" }],
        }),
        (error: unknown) => error instanceof AgentBridgeError && error.code === "invalid_tool_call_id"
      );
    } finally {
      shutdownAgentBridges();
      if (previousBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previousBin;
      if (previousTimeout === undefined) delete process.env.CODEX_AGENT_BRIDGE_TOOL_OUTPUT_TIMEOUT_MS;
      else process.env.CODEX_AGENT_BRIDGE_TOOL_OUTPUT_TIMEOUT_MS = previousTimeout;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
