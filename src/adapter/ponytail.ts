/** Optional Ponytail-inspired coding profile for each proxy request. */

export type PonytailMode = "off" | "lite" | "full" | "ultra";

const PONYTAIL_SUFFIX = /@ponytail(?:-(off|lite|full|ultra))?$/i;

export function normalizePonytailMode(value: unknown): PonytailMode | undefined {
  if (value === true) return "full";
  if (value === false) return "off";
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return ["off", "lite", "full", "ultra"].includes(normalized)
    ? normalized as PonytailMode
    : undefined;
}

export function parsePonytailModel(model?: string): { model?: string; mode?: PonytailMode } {
  if (!model) return { model };
  const match = model.match(PONYTAIL_SUFFIX);
  if (!match) return { model };
  return {
    model: model.slice(0, match.index),
    mode: normalizePonytailMode(match[1] || "full"),
  };
}

export function hasInvalidPonytailModelSuffix(model: unknown): boolean {
  return typeof model === "string" && /@ponytail(?:-|$)/i.test(model) && !PONYTAIL_SUFFIX.test(model);
}

export function resolvePonytailMode(
  requestValue: unknown,
  model?: string,
  defaultValue: unknown = process.env.CODEX_PONYTAIL_DEFAULT
): PonytailMode {
  const explicit = normalizePonytailMode(requestValue);
  if (explicit) return explicit;
  const modelMode = parsePonytailModel(model).mode;
  if (modelMode) return modelMode;
  return normalizePonytailMode(defaultValue) || "off";
}

export function ponytailInstructions(mode: PonytailMode): string | undefined {
  if (mode === "off") return undefined;

  const shared = [
    `Apply the optional Ponytail-inspired coding profile in ${mode} mode.`,
    "For coding tasks, inspect the relevant existing code before editing.",
    "Prefer this order: avoid speculative work, reuse existing code, use standard-library or native platform features, use installed dependencies, then add the smallest correct change.",
    "Fix root causes and keep the diff and explanation concise.",
    "Preserve explicit user requirements, security, validation, data-loss protections, accessibility, and necessary error handling.",
  ];

  if (mode === "lite") {
    shared.push("Deliver the requested result and briefly mention a materially simpler option when one exists.");
  } else if (mode === "full") {
    shared.push("Apply the preference order consistently and avoid unnecessary abstractions or dependencies.");
  } else {
    shared.push("Challenge speculative scope aggressively, seek deletion or reuse before addition, and still deliver the useful requested result.");
  }
  return shared.join(" ");
}

export function applyPonytailToPrompt(prompt: string, mode: PonytailMode): string {
  const instructions = ponytailInstructions(mode);
  if (!instructions) return prompt;
  return `<developer_instructions source="ponytail" mode="${mode}">\n${instructions}\n</developer_instructions>\n\n${prompt}`;
}
