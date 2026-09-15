/** Decode, validate, store, and clean up request-scoped attachments. */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { OpenAIImageDetail } from "../types/openai.js";

const MIB = 1024 * 1024;
const DEFAULT_MAX_COUNT = 10;
const DEFAULT_MAX_BYTES = 10 * MIB;
const DEFAULT_MAX_TOTAL_BYTES = 25 * MIB;
const DEFAULT_BODY_MAX_BYTES = 40 * MIB;

const IMAGE_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "text/html",
  "text/css",
  "text/xml",
  "text/yaml",
  "text/javascript",
  "text/typescript",
  "text/x-python",
  "text/x-c",
  "text/x-c++src",
  "text/x-java-source",
  "text/x-rust",
  "text/x-go",
  "text/x-shellscript",
  "text/x-ruby",
  "text/x-php",
  "text/x-sql",
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/typescript",
  "application/sql",
]);

export interface AttachmentLimits {
  maxCount: number;
  maxBytes: number;
  maxTotalBytes: number;
}

export interface StoredImage {
  kind: "image";
  path: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  detail?: OpenAIImageDetail;
}

export interface StoredTextFile {
  kind: "text";
  path: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  text: string;
}

export class AttachmentError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid_attachment") {
    super(message);
  }
}

const activeAttachmentStores = new Set<AttachmentStore>();

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function attachmentLimits(): AttachmentLimits {
  return {
    maxCount: positiveInteger("CODEX_ATTACHMENT_MAX_COUNT", DEFAULT_MAX_COUNT),
    maxBytes: positiveInteger("CODEX_ATTACHMENT_MAX_BYTES", DEFAULT_MAX_BYTES),
    maxTotalBytes: positiveInteger("CODEX_ATTACHMENT_MAX_TOTAL_BYTES", DEFAULT_MAX_TOTAL_BYTES),
  };
}

export function requestBodyMaxBytes(): number {
  return positiveInteger("CODEX_HTTP_BODY_MAX_BYTES", DEFAULT_BODY_MAX_BYTES);
}

function parseDataUrl(value: unknown): { mimeType: string; bytes: Buffer } {
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
  if (!mimeType || !metadata.some((part) => part.toLowerCase() === "base64")) {
    throw new AttachmentError("Attachment data URL must use base64 encoding", 400, "invalid_attachment_data_url");
  }

  const encoded = value.slice(comma + 1);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new AttachmentError("Attachment contains invalid base64 data", 400, "invalid_attachment_base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  const canonicalInput = encoded.replace(/=+$/, "");
  const canonicalDecoded = bytes.toString("base64").replace(/=+$/, "");
  if (canonicalInput !== canonicalDecoded) {
    throw new AttachmentError("Attachment contains invalid base64 data", 400, "invalid_attachment_base64");
  }
  return { mimeType, bytes };
}

function validateImageSignature(mimeType: string, bytes: Buffer): void {
  const valid = mimeType === "image/png"
    ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType === "image/jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mimeType === "image/webp"
        ? bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
          bytes.subarray(8, 12).toString("ascii") === "WEBP"
        : false;
  if (!valid) {
    throw new AttachmentError("Image signature does not match its declared MIME type", 400, "invalid_image_signature");
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AttachmentError("Text attachment must contain valid UTF-8", 400, "invalid_attachment_utf8");
  }
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
  private totalBytes = 0;
  private cleaned = false;
  private readonly limits = attachmentLimits();

  get directory(): string | undefined {
    return this.directoryValue;
  }

  async addImage(dataUrl: unknown, detail?: OpenAIImageDetail): Promise<StoredImage> {
    this.reserveCount();
    const { mimeType, bytes } = parseDataUrl(dataUrl);
    const extension = IMAGE_MIME_EXTENSIONS[mimeType];
    if (!extension) {
      if (mimeType === "application/pdf") {
        throw new AttachmentError("PDF attachments are not supported by this proxy", 400, "pdf_attachment_unsupported");
      }
      throw new AttachmentError("Unsupported image MIME type", 400, "unsupported_attachment_mime");
    }
    this.reserveBytes(bytes.length);
    validateImageSignature(mimeType, bytes);
    const filename = `image-${this.count}${extension}`;
    const filePath = await this.write(filename, bytes);
    return { kind: "image", path: filePath, filename, mimeType, byteLength: bytes.length, detail };
  }

  async addTextFile(filenameValue: unknown, dataUrl: unknown): Promise<StoredTextFile> {
    this.reserveCount();
    const filename = sanitizeFilename(filenameValue);
    const { mimeType, bytes } = parseDataUrl(dataUrl);
    if (mimeType === "application/pdf") {
      throw new AttachmentError("PDF attachments are not supported by this proxy", 400, "pdf_attachment_unsupported");
    }
    if (!TEXT_MIME_TYPES.has(mimeType)) {
      throw new AttachmentError("Unsupported file MIME type", 400, "unsupported_attachment_mime");
    }
    this.reserveBytes(bytes.length);
    const text = decodeUtf8(bytes);
    const storedName = `${this.count}-${filename}`;
    const filePath = await this.write(storedName, bytes);
    return { kind: "text", path: filePath, filename, mimeType, byteLength: bytes.length, text };
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
      activeAttachmentStores.add(this);
    }
    const filePath = path.join(this.directoryValue, filename);
    await writeFile(filePath, bytes, { mode: 0o600, flag: "wx" });
    return filePath;
  }
}

export const SUPPORTED_IMAGE_MIME_TYPES = Object.freeze(Object.keys(IMAGE_MIME_EXTENSIONS));
export const SUPPORTED_TEXT_MIME_TYPES = Object.freeze([...TEXT_MIME_TYPES]);

export function shutdownAttachmentStores(): void {
  for (const store of [...activeAttachmentStores]) store.cleanup();
}
