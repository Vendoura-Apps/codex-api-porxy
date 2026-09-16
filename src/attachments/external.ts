import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import path from "node:path";
import { AttachmentError, checkAborted } from "./errors.js";

export async function executableAvailable(command: string): Promise<boolean> {
  if (command.includes("/") || command.includes("\\")) {
    try {
      await access(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const paths = (process.env.PATH || "").split(path.delimiter);
  for (const directory of paths) {
    if (!directory) continue;
    try {
      await access(path.join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Continue feature detection without invoking a shell.
    }
  }
  return false;
}

export interface ExternalResult {
  stdout: Buffer;
  stderr: string;
}

export async function runExternal(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }
): Promise<ExternalResult> {
  checkAborted(options.signal);
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;

    const finishError = (error: AttachmentError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
      reject(error);
    };
    const abort = () => finishError(new AttachmentError(
      "Attachment extraction was cancelled", 499, "attachment_extraction_aborted"
    ));
    const timer = setTimeout(() => finishError(new AttachmentError(
      "Attachment extractor timed out", 408, "attachment_extraction_timeout"
    )), options.timeoutMs);

    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxOutputBytes) {
        finishError(new AttachmentError(
          "Attachment extractor produced too much output", 413, "attachment_extracted_too_large"
        ));
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4_096);
    });
    child.once("error", () => finishError(new AttachmentError(
      "Attachment extractor is unavailable", 422, "attachment_extractor_unavailable"
    )));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (code !== 0) {
        const encrypted = /password|encrypted|incorrect password/i.test(stderr);
        reject(new AttachmentError(
          encrypted ? "Encrypted attachments are not supported" : "Attachment extraction failed",
          422,
          encrypted ? "attachment_encrypted" : "attachment_extraction_failed"
        ));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr });
    });
  });
}
