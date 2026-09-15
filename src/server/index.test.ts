import assert from "node:assert/strict";
import test from "node:test";
import { isValidBearerToken } from "./index.js";
import { AVAILABLE_MODEL_IDS } from "./routes.js";

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
