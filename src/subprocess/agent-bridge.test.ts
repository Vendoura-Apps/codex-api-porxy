import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAgentBridgeRequest, openaiToolsToDynamicTools } from "./agent-bridge.js";

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
});
