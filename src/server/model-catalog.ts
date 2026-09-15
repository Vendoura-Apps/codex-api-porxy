import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProxyModelCapabilities {
  context_window: number;
  max_output_tokens: number;
  auto_compact_threshold: number;
}

const MODEL_CAPABILITIES: Readonly<Record<string, ProxyModelCapabilities>> = {
  "gpt-6-astra": { context_window: 1_050_000, max_output_tokens: 128_000, auto_compact_threshold: 850_000 },
  "gpt-5.6-sol": { context_window: 1_050_000, max_output_tokens: 128_000, auto_compact_threshold: 850_000 },
  "gpt-5.6": { context_window: 1_050_000, max_output_tokens: 128_000, auto_compact_threshold: 850_000 },
  "gpt-5.6-terra": { context_window: 1_050_000, max_output_tokens: 128_000, auto_compact_threshold: 850_000 },
  "gpt-5.6-luna": { context_window: 1_050_000, max_output_tokens: 128_000, auto_compact_threshold: 850_000 },
  "gpt-5.5": { context_window: 1_050_000, max_output_tokens: 128_000, auto_compact_threshold: 850_000 },
  "gpt-5.3-codex-spark": { context_window: 128_000, max_output_tokens: 16_000, auto_compact_threshold: 90_000 },
};

export interface ProxyModelMetadata extends Partial<ProxyModelCapabilities> {
  resolved_model?: string;
}

export function modelMetadata(id: string, defaultModel?: string): ProxyModelMetadata {
  const requested = id.replace(/@ponytail-(?:off|lite|full|ultra)$/, "");
  const resolvedModel = requested === "codex" ? defaultModel : requested;
  if (!resolvedModel) return {};
  return {
    resolved_model: resolvedModel,
    ...(MODEL_CAPABILITIES[resolvedModel] || {}),
  };
}

export function configuredCodexModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.CODEX_DEFAULT_MODEL?.trim();
  if (override) return override;
  const codexHome = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  try {
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    return /^\s*model\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m.exec(config)?.[1];
  } catch {
    return undefined;
  }
}
