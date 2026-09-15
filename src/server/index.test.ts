import assert from "node:assert/strict";
import test from "node:test";
import { isValidBearerToken } from "./index.js";
import { AVAILABLE_MODEL_IDS } from "./routes.js";
import { configuredCodexModel, modelMetadata } from "./model-catalog.js";

test("validates bearer API keys", () => {
  assert.equal(isValidBearerToken("Bearer secret-value", "secret-value"), true);
  assert.equal(isValidBearerToken("Bearer wrong-value", "secret-value"), false);
  assert.equal(isValidBearerToken(undefined, "secret-value"), false);
  assert.equal(isValidBearerToken("Basic secret-value", "secret-value"), false);
});

test("advertises explicit Codex model choices", () => {
  assert.deepEqual(AVAILABLE_MODEL_IDS, [
    "codex",
    "codex@ponytail-off",
    "codex@ponytail-lite",
    "codex@ponytail-full",
    "codex@ponytail-ultra",
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.3-codex-spark",
  ]);
});

test("publishes model-aware context and compaction metadata", () => {
  assert.deepEqual(modelMetadata("gpt-5.6-terra"), {
    resolved_model: "gpt-5.6-terra",
    context_window: 1_050_000,
    max_output_tokens: 128_000,
    auto_compact_threshold: 850_000,
  });
  assert.deepEqual(modelMetadata("codex@ponytail-full", "gpt-5.3-codex-spark"), {
    resolved_model: "gpt-5.3-codex-spark",
    context_window: 128_000,
    max_output_tokens: 16_000,
    auto_compact_threshold: 90_000,
  });
  assert.equal(configuredCodexModel({ CODEX_DEFAULT_MODEL: "gpt-test" }), "gpt-test");
});
