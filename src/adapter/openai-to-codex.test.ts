import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractModel,
  messagesToPrompt,
  normalizeReasoningEffort,
  openaiToCodex,
  openaiToCodexDelta,
} from "./openai-to-codex.js";

describe("OpenAI to Codex adapter", () => {
  it("uses the CLI default model for the codex alias", () => {
    assert.deepEqual(extractModel("codex-cli/codex"), { responseModel: "codex" });
    assert.deepEqual(extractModel("gpt-example"), {
      cliModel: "gpt-example",
      responseModel: "gpt-example",
    });
  });

  it("preserves system, user, assistant, and content-block text", () => {
    const prompt = messagesToPrompt([
      { role: "system", content: "Be concise." },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { role: "assistant", content: "hi" },
    ]);
    assert.match(prompt, /<system>\nBe concise\.\n<\/system>/);
    assert.match(prompt, /hello/);
    assert.match(prompt, /<previous_response>\nhi\n<\/previous_response>/);
  });

  it("sends only new user input when resuming a thread", () => {
    const input = openaiToCodexDelta({
      model: "codex",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "second" },
      ],
    }, 1);
    assert.equal(input.prompt, "second");
  });

  it("normalizes Codex UI reasoning effort names", () => {
    assert.equal(normalizeReasoningEffort("light"), "low");
    assert.equal(normalizeReasoningEffort("Extra High"), "xhigh");
    assert.equal(normalizeReasoningEffort("max"), "max");
    assert.equal(normalizeReasoningEffort("ultra"), undefined);
  });

  it("adds a normalized reasoning effort to Codex input", () => {
    const input = openaiToCodex({
      model: "codex",
      reasoning_effort: "extra-high",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(input.reasoningEffort, "xhigh");
  });
});
