import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPonytailToPrompt,
  hasInvalidPonytailModelSuffix,
  normalizePonytailMode,
  parsePonytailModel,
  resolvePonytailMode,
} from "./ponytail.js";

describe("Ponytail request profile", () => {
  it("accepts named modes and boolean switches", () => {
    assert.equal(normalizePonytailMode("FULL"), "full");
    assert.equal(normalizePonytailMode(true), "full");
    assert.equal(normalizePonytailMode(false), "off");
    assert.equal(normalizePonytailMode("max"), undefined);
  });

  it("extracts the profile from a model alias", () => {
    assert.deepEqual(parsePonytailModel("codex@ponytail-full"), {
      model: "codex",
      mode: "full",
    });
    assert.deepEqual(parsePonytailModel("gpt-5.6-luna@ponytail"), {
      model: "gpt-5.6-luna",
      mode: "full",
    });
    assert.equal(hasInvalidPonytailModelSuffix("codex@ponytail-max"), true);
  });

  it("uses request value, then model alias, then server default", () => {
    assert.equal(resolvePonytailMode("off", "codex@ponytail-ultra", "full"), "off");
    assert.equal(resolvePonytailMode(undefined, "codex@ponytail-lite", "full"), "lite");
    assert.equal(resolvePonytailMode(undefined, "codex", "ultra"), "ultra");
    assert.equal(resolvePonytailMode(undefined, "codex", "invalid"), "off");
  });

  it("injects instructions only when enabled", () => {
    assert.equal(applyPonytailToPrompt("hello", "off"), "hello");
    const prompt = applyPonytailToPrompt("hello", "full");
    assert.match(prompt, /source="ponytail" mode="full"/);
    assert.match(prompt, /smallest correct change/);
    assert.match(prompt, /\n\nhello$/);
  });
});
