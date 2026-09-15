/** Bridge OpenAI function tools to Codex app-server dynamic tools. */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  extractText,
  prepareCodexInput,
  type PreparedCodexInput,
} from "../adapter/openai-to-codex.js";
import type {
  OpenAIChatMessage,
  OpenAIChatRequest,
  OpenAIFunctionTool,
  OpenAIToolCall,
} from "../types/openai.js";

type RpcId = number | string;

interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface RpcWaiter {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface OutputWaiter {
  resolve: (output: AgentBridgeOutput) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: unknown;
}

export interface AgentBridgeOutput {
  text: string;
  toolCalls: OpenAIToolCall[];
  finishReason: "stop" | "tool_calls";
}

export interface AgentBridgeEvents {
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal;
  preparedInput?: PreparedCodexInput;
}

interface ToolOutput {
  callId: string;
  content: string;
}

interface DynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TURN_TIMEOUT = 15 * 60 * 1000;
const RPC_TIMEOUT = 30 * 1000;
const TOOL_BATCH_DELAY = 20;
const BRIDGE_CWD = path.join(os.tmpdir(), "codex-api-proxy-agent-bridge");
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const pendingToolCalls = new Map<string, CodexAgentTurn>();
const activeTurns = new Set<CodexAgentTurn>();

export class AgentBridgeError extends Error {
  constructor(message: string, readonly status = 500, readonly code = "agent_bridge_error") {
    super(message);
  }
}

export function openaiToolsToDynamicTools(tools: OpenAIFunctionTool[]): DynamicToolSpec[] {
  if (tools.length > 128) {
    throw new AgentBridgeError("Agent requests support at most 128 tools", 400, "invalid_tools");
  }
  return tools.map((tool) => ({
    type: "function",
    name: validateToolName(tool.function?.name),
    description: tool.function.description || `Run ${tool.function.name} on the client device.`,
    inputSchema: tool.function.parameters || { type: "object", properties: {} },
  }));
}

function validateToolName(name: string | undefined): string {
  if (!name || !TOOL_NAME_PATTERN.test(name)) {
    throw new AgentBridgeError(
      "Function tool names must contain 1-64 letters, numbers, underscores, or hyphens",
      400,
      "invalid_tools"
    );
  }
  return name;
}

function toolMessageContent(message: OpenAIChatMessage): string {
  return extractText(message.content);
}

function configuredCodexBin(): string {
  return process.env.CODEX_BIN || "codex";
}

function maxActiveTurns(): number {
  const configured = Number(process.env.CODEX_AGENT_BRIDGE_MAX_ACTIVE || 16);
  return Number.isInteger(configured) && configured > 0 ? configured : 16;
}

function toolChoiceInstruction(choice: OpenAIChatRequest["tool_choice"]): string | undefined {
  if (choice === "required") return "You must call at least one client-provided tool before answering.";
  if (choice && typeof choice === "object") {
    const selected = (choice as { function?: { name?: unknown } }).function?.name;
    if (typeof selected === "string" && TOOL_NAME_PATTERN.test(selected)) {
      return `You must call the client-provided ${selected} tool before answering.`;
    }
  }
  return undefined;
}

function safeBridgeCwd(): string {
  const configured = process.env.CODEX_AGENT_BRIDGE_CWD;
  const cwd = configured ? path.resolve(configured) : BRIDGE_CWD;
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

class CodexAgentTurn {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRpcId = 1;
  private rpcWaiters = new Map<RpcId, RpcWaiter>();
  private outputWaiter: OutputWaiter | null = null;
  private threadId: string | undefined;
  private text = "";
  private toolCalls: OpenAIToolCall[] = [];
  private serverRequestIds = new Map<string, RpcId>();
  private toolBatchTimer: NodeJS.Timeout | null = null;
  private stderr = "";
  private disposed = false;
  private abortHandler: (() => void) | undefined;
  private preparedInput: PreparedCodexInput | undefined;

  constructor(private streamEvents?: AgentBridgeEvents) {}

  async start(request: OpenAIChatRequest): Promise<AgentBridgeOutput> {
    activeTurns.add(this);
    try {
      this.preparedInput = this.streamEvents?.preparedInput || await prepareCodexInput(request);
      this.spawn();

      await this.rpc("initialize", {
        clientInfo: {
          name: "codex_api_proxy_agent_bridge",
          title: "Codex API Proxy Agent Bridge",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      this.notify("initialized", {});

      const model = request.model && !["codex", "default"].includes(request.model)
        ? request.model.replace(/^(?:codex-cli|codex)\//, "")
        : undefined;
      const dynamicTools = openaiToolsToDynamicTools(request.tools || []);
      const choiceInstruction = toolChoiceInstruction(request.tool_choice);
      const threadResult = await this.rpc("thread/start", {
        model,
        cwd: safeBridgeCwd(),
        approvalPolicy: "on-request",
        sandbox: "read-only",
        ephemeral: true,
        dynamicTools,
        baseInstructions: [
          "You are the VTI remote coding agent.",
          "The app-server working directory is an isolated proxy implementation detail, not the user's workspace.",
          "Use only the client-provided dynamic tools for every workspace operation.",
        ].join(" "),
        config: {
          features: {
            shell_tool: false,
            unified_exec: false,
            code_mode: false,
          },
        },
        developerInstructions: [
          "You are controlling a coding workspace on a remote client device.",
          "Use only the client-provided dynamic tools for files, search, edits, and terminal commands.",
          "Do not use built-in shell, filesystem, or patch tools because they run on the proxy server.",
          "The path /tmp/codex-api-proxy-agent-bridge is never the client workspace; do not inspect, report, or mention it as one.",
          "When asked about the active workspace, call the client workspace-info tool before answering.",
          "Inspect the client workspace with tools before making claims about its code.",
          choiceInstruction,
        ].filter(Boolean).join(" "),
      }) as { thread?: { id?: string } };

      this.threadId = threadResult.thread?.id;
      if (!this.threadId) throw new AgentBridgeError("Codex app-server did not return a thread id");

      const output = this.waitForOutput();
      try {
        await this.rpc("turn/start", {
          threadId: this.threadId,
          input: this.preparedInput.appServerInput,
          effort: this.preparedInput.reasoningEffort,
        });
      } catch (error) {
        output.catch(() => undefined);
        throw error;
      }
      return await output;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async continueWithToolOutputs(outputs: ToolOutput[], streamEvents?: AgentBridgeEvents): Promise<AgentBridgeOutput> {
    if (this.disposed) throw new AgentBridgeError("Agent turn is no longer active", 400, "expired_tool_call");
    if (outputs.length !== this.serverRequestIds.size ||
        outputs.some((output) => !this.serverRequestIds.has(output.callId))) {
      throw new AgentBridgeError(
        "Return all pending tool outputs for this turn in one request",
        400,
        "incomplete_tool_outputs"
      );
    }
    this.streamEvents = streamEvents;
    const output = this.waitForOutput();
    try {
      for (const item of outputs) {
        const requestId = this.serverRequestIds.get(item.callId)!;
        this.serverRequestIds.delete(item.callId);
        pendingToolCalls.delete(item.callId);
        this.send({
          id: requestId,
          result: {
            contentItems: [{ type: "inputText", text: item.content }],
            success: true,
          },
        });
      }
      return await output;
    } catch (error) {
      this.rejectOutput(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  ownsCall(callId: string): boolean {
    return this.serverRequestIds.has(callId);
  }

  shutdown(): void {
    this.rejectOutput(new AgentBridgeError("Agent bridge is shutting down", 503, "agent_bridge_shutdown"));
  }

  private spawn(): void {
    this.child = spawn(configuredCodexBin(), [
      "app-server",
      "--disable", "shell_tool",
      "--disable", "unified_exec",
      "--disable", "code_mode",
    ], {
      cwd: safeBridgeCwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8000);
      if (process.env.DEBUG_SUBPROCESS) {
        console.error(this.hasAttachments()
          ? "[Codex app-server stderr redacted for attachment request]"
          : `[Codex app-server stderr] ${chunk.toString().trim()}`);
      }
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("close", (code) => {
      if (!this.disposed) this.fail(new Error(this.safeErrorMessage(
        this.stderr.trim() || `Codex app-server exited with code ${code}`
      )));
    });
  }

  private rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rpcWaiters.delete(id);
        reject(new AgentBridgeError(`Codex app-server request timed out: ${method}`));
      }, RPC_TIMEOUT);
      this.rpcWaiters.set(id, { resolve, reject, timeout });
      this.send({ method, id, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private send(message: RpcMessage): void {
    if (!this.child?.stdin.writable) throw new AgentBridgeError("Codex app-server is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }

    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const waiter = this.rpcWaiters.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timeout);
      this.rpcWaiters.delete(message.id);
      if (message.error) waiter.reject(new AgentBridgeError(this.safeErrorMessage(
        message.error.message || "Codex app-server request failed"
      )));
      else waiter.resolve(message.result);
      return;
    }

    this.handleNotification(message);
  }

  private handleServerRequest(message: RpcMessage): void {
    if (message.method === "item/tool/call") {
      const params = message.params as unknown as DynamicToolCallParams;
      const call: OpenAIToolCall = {
        id: params.callId,
        type: "function",
        function: {
          name: params.tool,
          arguments: JSON.stringify(params.arguments ?? {}),
        },
      };
      this.serverRequestIds.set(call.id, message.id!);
      pendingToolCalls.set(call.id, this);
      this.toolCalls.push(call);
      if (this.toolBatchTimer) clearTimeout(this.toolBatchTimer);
      this.toolBatchTimer = setTimeout(() => this.resolveOutput("tool_calls"), TOOL_BATCH_DELAY);
      return;
    }

    if (message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval") {
      this.send({ id: message.id, result: { decision: "decline" } });
      return;
    }

    if (message.method === "item/permissions/requestApproval") {
      this.send({ id: message.id, result: { permissions: {}, scope: "turn" } });
      return;
    }

    this.send({ id: message.id, error: { code: -32601, message: "Unsupported server request" } });
  }

  private handleNotification(message: RpcMessage): void {
    const params = message.params || {};
    if (this.threadId && params.threadId && params.threadId !== this.threadId) return;

    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.text += params.delta;
      this.streamEvents?.onTextDelta?.(params.delta);
      return;
    }

    if (message.method === "error") {
      const error = params.error as { message?: string } | undefined;
      if (params.willRetry !== true) this.rejectOutput(new AgentBridgeError(this.safeErrorMessage(
        error?.message || "Codex agent turn failed"
      )));
      return;
    }

    if (message.method === "turn/completed") {
      const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
      if (turn?.status === "failed") {
        this.rejectOutput(new AgentBridgeError(this.safeErrorMessage(
          turn.error?.message || "Codex agent turn failed"
        )));
      } else {
        this.resolveOutput("stop");
      }
    }
  }

  private waitForOutput(): Promise<AgentBridgeOutput> {
    if (this.outputWaiter) throw new AgentBridgeError("Agent turn already has a waiting request", 409, "agent_turn_busy");
    this.text = "";
    this.toolCalls = [];
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectOutput(new AgentBridgeError("Agent turn timed out"));
      }, TURN_TIMEOUT);
      this.outputWaiter = { resolve, reject, timeout };
      const signal = this.streamEvents?.signal;
      this.abortHandler = () => this.rejectOutput(
        new AgentBridgeError("Client disconnected before the agent turn completed", 499, "client_disconnected")
      );
      if (signal?.aborted) this.abortHandler();
      else signal?.addEventListener("abort", this.abortHandler, { once: true });
    });
  }

  private clearAbortHandler(): void {
    if (this.abortHandler) this.streamEvents?.signal?.removeEventListener("abort", this.abortHandler);
    this.abortHandler = undefined;
  }

  private hasAttachments(): boolean {
    return this.preparedInput?.attachmentStore.directory !== undefined;
  }

  private safeErrorMessage(message: string): string {
    return this.hasAttachments() ? "Codex failed while processing an attachment" : message;
  }

  private resolveOutput(reason: "stop" | "tool_calls"): void {
    const waiter = this.outputWaiter;
    if (!waiter) return;
    if (this.toolBatchTimer) clearTimeout(this.toolBatchTimer);
    this.toolBatchTimer = null;
    clearTimeout(waiter.timeout);
    this.outputWaiter = null;
    this.clearAbortHandler();
    this.streamEvents = undefined;
    waiter.resolve({ text: this.text, toolCalls: [...this.toolCalls], finishReason: reason });
    if (reason === "stop") this.dispose();
  }

  private rejectOutput(error: Error): void {
    const waiter = this.outputWaiter;
    if (waiter) {
      clearTimeout(waiter.timeout);
      this.outputWaiter = null;
      this.clearAbortHandler();
      waiter.reject(error);
    }
    this.dispose();
  }

  private fail(error: Error): void {
    for (const waiter of this.rpcWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.rpcWaiters.clear();
    this.rejectOutput(error);
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.toolBatchTimer) clearTimeout(this.toolBatchTimer);
    for (const callId of this.serverRequestIds.keys()) pendingToolCalls.delete(callId);
    this.serverRequestIds.clear();
    activeTurns.delete(this);
    this.preparedInput?.attachmentStore.cleanup();
    this.preparedInput = undefined;
    this.child?.kill();
    this.child = null;
  }
}

export function isAgentBridgeRequest(request: OpenAIChatRequest): boolean {
  return Boolean(
    (request.tools?.length && request.tool_choice !== "none") ||
    request.messages.some((message) => message.role === "tool")
  );
}

export async function runAgentBridge(request: OpenAIChatRequest, streamEvents?: AgentBridgeEvents): Promise<AgentBridgeOutput> {
  const toolMessages = request.messages.filter((message) => message.role === "tool");
  if (toolMessages.length === 0) {
    if (!request.tools?.length) {
      throw new AgentBridgeError("Agent requests must include at least one function tool", 400, "missing_tools");
    }
    if (activeTurns.size >= maxActiveTurns()) {
      streamEvents?.preparedInput?.attachmentStore.cleanup();
      throw new AgentBridgeError("Too many active agent turns; try again later", 429, "agent_bridge_busy");
    }
    return new CodexAgentTurn(streamEvents).start(request);
  }

  const pendingMessages = toolMessages.filter((message) =>
    Boolean(message.tool_call_id && pendingToolCalls.has(message.tool_call_id))
  );
  if (pendingMessages.length === 0) {
    throw new AgentBridgeError("Unknown or expired tool_call_id values", 400, "invalid_tool_call_id");
  }
  const outputs = pendingMessages.map((message) => {
    if (!message.tool_call_id) {
      throw new AgentBridgeError("Tool messages must include tool_call_id", 400, "missing_tool_call_id");
    }
    return { callId: message.tool_call_id, content: toolMessageContent(message) };
  });
  const turn = pendingToolCalls.get(outputs[0].callId);
  if (!turn || outputs.some((output) => !turn.ownsCall(output.callId))) {
    throw new AgentBridgeError("Unknown, expired, or mixed tool_call_id values", 400, "invalid_tool_call_id");
  }
  return turn.continueWithToolOutputs(outputs, streamEvents);
}

export function shutdownAgentBridges(): void {
  for (const turn of [...activeTurns]) turn.shutdown();
}
