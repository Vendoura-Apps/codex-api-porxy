/** Spawn Codex CLI and translate its JSONL stream into typed events. */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import type { CodexEvent, CodexResult, CodexUsage } from "../types/codex-cli.js";
import type { CodexReasoningEffort } from "../adapter/openai-to-codex.js";
import {
  failureMessage,
  isAgentMessage,
  isFailureEvent,
  isThreadStarted,
  isTurnCompleted,
} from "../types/codex-cli.js";

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface SubprocessOptions {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  threadId?: string;
  resume?: boolean;
  cwd?: string;
  timeout?: number;
  sandbox?: CodexSandbox;
}

const DEFAULT_TIMEOUT = 15 * 60 * 1000;
const DEFAULT_SANDBOX: CodexSandbox = "read-only";

function resolveCodexBin(): string {
  return process.env.CODEX_BIN || "codex";
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): boolean {
  const pid = child.pid;
  if (!pid) return false;

  if (process.platform === "win32") {
    const taskkill = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "taskkill.exe")
      : "taskkill.exe";
    const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return true;
    try { child.kill(signal); } catch {}
    return false;
  }

  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try { return child.kill(signal); } catch { return false; }
  }
}

export class CodexSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = "";
  private stderr = "";
  private timeoutId: NodeJS.Timeout | null = null;
  private isKilled = false;
  private completed = false;
  private threadId: string | undefined;
  private messages: string[] = [];

  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const args = this.buildArgs(options);
    const timeout = options.timeout || DEFAULT_TIMEOUT;

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(resolveCodexBin(), args, {
          cwd: options.cwd || process.env.CODEX_WORKING_DIR || process.cwd(),
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          detached: process.platform !== "win32",
          windowsHide: true,
        });
        this.armTimeout(timeout);
        let started = false;

        this.process.once("spawn", () => {
          started = true;
          this.process?.stdin?.end(prompt);
          resolve();
        });
        this.process.once("error", (error) => {
          this.clearTimeout();
          const wrapped = (error as NodeJS.ErrnoException).code === "ENOENT"
            ? new Error("Codex CLI not found. Install it and ensure `codex` is available in PATH.")
            : error;
          if (!started) reject(wrapped);
          else this.emitError(wrapped);
        });
        this.process.stdout?.on("data", (chunk: Buffer) => {
          this.buffer += chunk.toString();
          this.processBuffer(false);
        });
        this.process.stderr?.on("data", (chunk: Buffer) => {
          this.stderr = (this.stderr + chunk.toString()).slice(-8000);
          if (process.env.DEBUG_SUBPROCESS) console.error("[Codex stderr]", chunk.toString().trim());
        });
        this.process.on("close", (code) => {
          this.clearTimeout();
          this.processBuffer(true);
          if (code !== 0 && !this.completed && !this.isKilled) {
            this.emitError(new Error(this.stderr.trim() || `Codex CLI exited with code ${code}`));
          }
          this.emit("close", code);
        });
      } catch (error) {
        this.clearTimeout();
        reject(error);
      }
    });
  }

  private buildArgs(options: SubprocessOptions): string[] {
    const sandbox = options.sandbox || parseSandbox(process.env.CODEX_SANDBOX) || DEFAULT_SANDBOX;
    const common = ["--json"];
    if (options.model) common.push("--model", options.model);
    if (options.reasoningEffort) {
      common.push("--config", `model_reasoning_effort="${options.reasoningEffort}"`);
    }
    if (options.resume && options.threadId) {
      return ["exec", "--sandbox", sandbox, "resume", ...common, options.threadId, "-"];
    }
    return ["exec", ...common, "--color", "never", "--sandbox", sandbox, "-"];
  }

  private processBuffer(flush: boolean): void {
    const lines = this.buffer.split("\n");
    this.buffer = flush ? "" : (lines.pop() || "");
    if (flush && lines.at(-1) === "") lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as CodexEvent;
        this.emit("message", event);
        if (isThreadStarted(event)) {
          this.threadId = event.thread_id;
          this.emit("thread", event.thread_id);
        } else if (isAgentMessage(event)) {
          const text = event.item.text;
          this.messages.push(text);
          this.emit("agent_message", text);
        } else if (isTurnCompleted(event)) {
          this.completed = true;
          const result: CodexResult = {
            threadId: this.threadId,
            text: this.messages.join("\n\n"),
            usage: normalizeUsage(event.usage),
          };
          this.emit("result", result);
        } else if (isFailureEvent(event)) {
          this.emitError(new Error(failureMessage(event)));
        }
      } catch {
        this.emit("raw", trimmed);
      }
    }
  }

  private emitError(error: Error): void {
    if (this.completed) return;
    this.completed = true;
    this.emit("error", error);
  }

  private clearTimeout(): void {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = null;
  }

  private armTimeout(timeout: number): void {
    this.clearTimeout();
    this.timeoutId = setTimeout(() => {
      if (this.isKilled || this.completed) return;
      if (this.process) this.isKilled = killProcessTree(this.process);
      this.emitError(new Error(`Request timed out after ${timeout}ms`));
    }, timeout);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.isKilled && this.process) {
      this.clearTimeout();
      this.isKilled = killProcessTree(this.process, signal);
    }
  }

  isRunning(): boolean {
    return this.process !== null && !this.isKilled && this.process.exitCode === null;
  }
}

function normalizeUsage(usage: CodexUsage): CodexUsage {
  return {
    input_tokens: usage?.input_tokens || 0,
    cached_input_tokens: usage?.cached_input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
    reasoning_output_tokens: usage?.reasoning_output_tokens || 0,
  };
}

function parseSandbox(value: string | undefined): CodexSandbox | undefined {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value;
  return undefined;
}

export async function verifyCodex(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(resolveCodexBin(), ["--version"], { stdio: "pipe", shell: false });
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.once("error", () => resolve({ ok: false, error: "Codex CLI not found in PATH" }));
    proc.once("close", (code) => resolve(code === 0
      ? { ok: true, version: output.trim() }
      : { ok: false, error: "Codex CLI returned a non-zero exit code" }));
  });
}

export async function verifyAuth(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(resolveCodexBin(), ["login", "status"], { stdio: "ignore", shell: false });
    proc.once("error", () => resolve({ ok: false, error: "Could not run `codex login status`" }));
    proc.once("close", (code) => resolve(code === 0
      ? { ok: true }
      : { ok: false, error: "Codex CLI is not authenticated. Run `codex` and sign in." }));
  });
}
