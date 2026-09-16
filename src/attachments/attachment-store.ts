/** Request-scoped attachment storage and universal extraction entry point. */

import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenAIImageDetail } from "../types/openai.js";
import { attachmentLimits, requestBodyMaxBytes, type AttachmentLimits } from "./config.js";
import { detectMimeType, validateNativeImage } from "./detect.js";
import { AttachmentError } from "./errors.js";
import { extractAttachment } from "./processor.js";
import type {
  ExtractionContext,
  NormalizedAttachmentResult,
  StoredExtractedFile,
  StoredImage,
} from "./types.js";

const IMAGE_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

const activeAttachmentStores = new Set<AttachmentStore>();

function parseDataUrl(value: unknown, maxBytes: number): { mimeType: string; bytes: Buffer } {
  if (typeof value !== "string") {
    throw new AttachmentError("Attachment data must be a base64 data URL", 400, "invalid_attachment_data_url");
  }
  if (/^https?:\/\//i.test(value)) {
    throw new AttachmentError(
      "Remote attachment URLs are disabled; send a base64 data URL",
      400,
      "remote_attachment_url_disabled"
    );
  }
  if (!value.startsWith("data:")) {
    throw new AttachmentError("Attachment data must be a base64 data URL", 400, "invalid_attachment_data_url");
  }
  const comma = value.indexOf(",");
  if (comma < 0) {
    throw new AttachmentError("Attachment data URL is malformed", 400, "invalid_attachment_data_url");
  }
  const metadata = value.slice(5, comma).split(";");
  const mimeType = metadata.shift()?.trim().toLowerCase() || "";
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mimeType) ||
      !metadata.some((part) => part.toLowerCase() === "base64")) {
    throw new AttachmentError("Attachment data URL must declare a MIME type and use base64", 400, "invalid_attachment_data_url");
  }
  const encoded = value.slice(comma + 1);
  if (encoded.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new AttachmentError("Attachment exceeds the per-attachment size limit", 413, "attachment_too_large");
  }
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new AttachmentError("Attachment contains invalid base64 data", 400, "invalid_attachment_base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (encoded.replace(/=+$/, "") !== bytes.toString("base64").replace(/=+$/, "")) {
    throw new AttachmentError("Attachment contains invalid base64 data", 400, "invalid_attachment_base64");
  }
  return { mimeType, bytes };
}

export function sanitizeFilename(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 255 || value.includes("\0") ||
      value.includes("/") || value.includes("\\") || value === "." || value === ".." ||
      path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new AttachmentError("Attachment filename is unsafe", 400, "invalid_attachment_filename");
  }
  const safe = value.normalize("NFKC").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  if (!safe || safe === "." || safe === "..") {
    throw new AttachmentError("Attachment filename is unsafe", 400, "invalid_attachment_filename");
  }
  return safe;
}

export class AttachmentStore {
  private directoryValue: string | undefined;
  private count = 0;
  private nestedCount = 0;
  private totalBytes = 0;
  private cleaned = false;
  private readonly limits = attachmentLimits();

  get directory(): string | undefined {
    return this.directoryValue;
  }

  async addImage(dataUrl: unknown, detail?: OpenAIImageDetail): Promise<StoredImage> {
    this.reserveCount();
    const { mimeType, bytes } = parseDataUrl(dataUrl, this.limits.maxBytes);
    const extension = IMAGE_MIME_EXTENSIONS[mimeType];
    if (!extension) {
      throw new AttachmentError("Unsupported native image MIME type", 400, "unsupported_attachment_mime");
    }
    this.reserveBytes(bytes.length);
    if (!validateNativeImage(mimeType, bytes)) {
      throw new AttachmentError("Image signature does not match its declared MIME type", 400, "invalid_image_signature");
    }
    const filename = `image-${this.count}${extension}`;
    const filePath = await this.write(filename, bytes);
    return { kind: "image", path: filePath, filename, mimeType, byteLength: bytes.length, detail };
  }

  async addFile(filenameValue: unknown, dataUrl: unknown, signal?: AbortSignal): Promise<StoredExtractedFile> {
    this.reserveCount();
    const filename = sanitizeFilename(filenameValue);
    const { mimeType: declaredMimeType, bytes } = parseDataUrl(dataUrl, this.limits.maxBytes);
    this.reserveBytes(bytes.length);
    const filePath = await this.write(`${this.count}-${filename}`, bytes);
    const detectedMimeType = detectMimeType(bytes, filename);
    const directory = this.directoryValue!;
    const context: ExtractionContext = {
      limits: this.limits,
      extractNested: async (nestedFilename, nestedDeclaredMime, nestedBytes, depth, nestedSignal) => {
        const safeName = sanitizeFilename(nestedFilename);
        const nestedDetectedMime = detectMimeType(nestedBytes, safeName);
        const needsMaterializedFile = nestedDetectedMime.startsWith("image/") ||
          nestedDetectedMime === "application/pdf" ||
          nestedDetectedMime.startsWith("audio/") || nestedDetectedMime.startsWith("video/");
        const nestedPath = needsMaterializedFile
          ? await this.write(`nested-${++this.nestedCount}-${safeName}`, nestedBytes)
          : path.join(directory, `in-memory-${++this.nestedCount}`);
        return extractAttachment({
          filename: safeName,
          declaredMimeType: nestedDeclaredMime,
          detectedMimeType: nestedDetectedMime,
          bytes: nestedBytes,
          path: nestedPath,
          directory,
          depth,
          signal: nestedSignal,
        }, context);
      },
    };
    const result = await extractAttachment({
      filename,
      declaredMimeType,
      detectedMimeType,
      bytes,
      path: filePath,
      directory,
      depth: 0,
      signal,
    }, context);
    return {
      kind: "extracted",
      path: filePath,
      filename,
      mimeType: result.detectedMimeType,
      byteLength: bytes.length,
      result,
    };
  }

  /** Backward-compatible method name retained for callers compiled against v1.1. */
  async addTextFile(filenameValue: unknown, dataUrl: unknown, signal?: AbortSignal): Promise<StoredExtractedFile> {
    return this.addFile(filenameValue, dataUrl, signal);
  }

  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.directoryValue) rmSync(this.directoryValue, { recursive: true, force: true });
    this.directoryValue = undefined;
    activeAttachmentStores.delete(this);
  }

  private reserveCount(): void {
    if (this.cleaned) throw new AttachmentError("Attachment store is already closed");
    if (this.count >= this.limits.maxCount) {
      throw new AttachmentError(
        `Too many attachments; maximum is ${this.limits.maxCount}`,
        413,
        "too_many_attachments"
      );
    }
    this.count += 1;
  }

  private reserveBytes(byteLength: number): void {
    if (byteLength > this.limits.maxBytes) {
      throw new AttachmentError("Attachment exceeds the per-attachment size limit", 413, "attachment_too_large");
    }
    if (this.totalBytes + byteLength > this.limits.maxTotalBytes) {
      throw new AttachmentError("Attachments exceed the total decoded size limit", 413, "attachments_total_too_large");
    }
    this.totalBytes += byteLength;
  }

  private async write(filename: string, bytes: Buffer): Promise<string> {
    if (!this.directoryValue) {
      const root = path.resolve(process.env.CODEX_ATTACHMENT_TMPDIR || os.tmpdir());
      await mkdir(root, { recursive: true, mode: 0o700 });
      this.directoryValue = await mkdtemp(path.join(root, "codex-attachments-"));
      await chmod(this.directoryValue, 0o700);
      activeAttachmentStores.add(this);
    }
    const filePath = path.join(this.directoryValue, filename);
    await writeFile(filePath, bytes, { mode: 0o600, flag: "wx" });
    return filePath;
  }
}

export { AttachmentError, attachmentLimits, requestBodyMaxBytes };
export type { AttachmentLimits, NormalizedAttachmentResult, StoredExtractedFile, StoredImage };

export const SUPPORTED_IMAGE_MIME_TYPES = Object.freeze(Object.keys(IMAGE_MIME_EXTENSIONS));

export function shutdownAttachmentStores(): void {
  for (const store of [...activeAttachmentStores]) store.cleanup();
}
