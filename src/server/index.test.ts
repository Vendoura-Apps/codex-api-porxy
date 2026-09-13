import assert from "node:assert/strict";
import test from "node:test";
import { isValidBearerToken } from "./index.js";

test("validates bearer API keys", () => {
  assert.equal(isValidBearerToken("Bearer secret-value", "secret-value"), true);
  assert.equal(isValidBearerToken("Bearer wrong-value", "secret-value"), false);
  assert.equal(isValidBearerToken(undefined, "secret-value"), false);
  assert.equal(isValidBearerToken("Basic secret-value", "secret-value"), false);
});
