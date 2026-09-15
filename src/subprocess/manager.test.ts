import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexSubprocess } from "./manager.js";
import type { CodexResult } from "../types/codex-cli.js";

describe("CodexSubprocess", () => {
  it("builds a safe initial codex exec command", () => {
    const subprocess = new CodexSubprocess() as unknown as {
      buildArgs: (options: object) => string[];
    };
    assert.deepEqual(subprocess.buildArgs({
      model: "gpt-example",
      reasoningEffort: "xhigh",
      sandbox: "read-only",
    }), [
      "exec", "--json", "--model", "gpt-example",
      "--config", "model_reasoning_effort=\"xhigh\"", "--color", "never",
      "--sandbox", "read-only", "-",
    ]);
  });

  it("builds a resume command with a specific thread", () => {
    const subprocess = new CodexSubprocess() as unknown as {
      buildArgs: (options: object) => string[];
    };
    assert.deepEqual(subprocess.buildArgs({
      threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      resume: true,
      sandbox: "workspace-write",
    }), [
      "exec", "--sandbox", "workspace-write", "resume", "--json",
      "0199a213-81c0-7800-8aa1-bbab2a035a53", "-",
    ]);
  });

  it("passes image paths as argv entries for initial and resumed turns", () => {
    const subprocess = new CodexSubprocess() as unknown as {
      buildArgs: (options: object) => string[];
    };
    const initial = subprocess.buildArgs({
      imagePaths: ["/tmp/one.png", "/tmp/two.webp"],
      sandbox: "read-only",
    });
    assert.deepEqual(initial.slice(0, 6), [
      "exec", "--json", "--image", "/tmp/one.png", "--image", "/tmp/two.webp",
    ]);

    const resumed = subprocess.buildArgs({
      threadId: "thread-123",
      resume: true,
      imagePaths: ["/tmp/one.png"],
      sandbox: "read-only",
    });
    assert.deepEqual(resumed, [
      "exec", "--sandbox", "read-only", "resume", "--json",
      "--image", "/tmp/one.png", "thread-123", "-",
    ]);
  });

  it("parses thread, agent message, and usage events", async () => {
    const subprocess = new CodexSubprocess();
    const testable = subprocess as unknown as {
      buffer: string;
      processBuffer: (flush: boolean) => void;
    };
    const thread = new Promise<string>((resolve) => subprocess.once("thread", resolve));
    const message = new Promise<string>((resolve) => subprocess.once("agent_message", resolve));
    const result = new Promise<CodexResult>((resolve) => subprocess.once("result", resolve));

    testable.buffer = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-1", type: "agent_message", text: "pong" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 3 },
      }),
    ].join("\n");
    testable.processBuffer(true);

    assert.equal(await thread, "thread-123");
    assert.equal(await message, "pong");
    assert.deepEqual(await result, {
      threadId: "thread-123",
      text: "pong",
      usage: {
        input_tokens: 12,
        cached_input_tokens: 4,
        output_tokens: 3,
        reasoning_output_tokens: 0,
      },
    });
  });

  it("turns Codex error events into errors", async () => {
    const subprocess = new CodexSubprocess();
    const testable = subprocess as unknown as {
      buffer: string;
      processBuffer: (flush: boolean) => void;
    };
    const error = new Promise<Error>((resolve) => subprocess.once("error", resolve));
    testable.buffer = JSON.stringify({ type: "error", message: "authentication failed" });
    testable.processBuffer(true);
    assert.equal((await error).message, "authentication failed");
  });
});
