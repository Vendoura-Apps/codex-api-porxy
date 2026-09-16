import { createHash } from "node:crypto";
import path from "node:path";
import { AttachmentError } from "./errors.js";

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

export function xmlUnescape(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export function stripXml(xml: string, paragraphPattern = /<\/(?:[^:>]+:)?(?:p|h)>/gi): string {
  return xmlUnescape(xml
    .replace(/<(?:[^:>]+:)?(?:tab)\b[^>]*\/?\s*>/gi, "\t")
    .replace(/<(?:[^:>]+:)?(?:br|line-break)\b[^>]*\/?\s*>/gi, "\n")
    .replace(paragraphPattern, "\n")
    .replace(/<\/(?:[^:>]+:)?(?:tc|table-cell)>/gi, "\t")
    .replace(/<[^>]*>/g, ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function xmlAttribute(fragment: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = fragment.match(new RegExp(`(?:^|\\s)${escaped}=["']([^"']*)["']`, "i"));
  return match ? xmlUnescape(match[1]) : undefined;
}

export function validateArchiveEntryName(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  if (!normalized || /[\x00-\x1f\x7f]/.test(normalized) || normalized.startsWith("/") ||
      /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => part === "..")) {
    throw new AttachmentError("Archive contains an unsafe entry name", 400, "attachment_archive_unsafe");
  }
  return normalized.replace(/^\.\//, "");
}

export function safeNestedFilename(entryName: string): string {
  const base = path.posix.basename(validateArchiveEntryName(entryName));
  return base.normalize("NFKC").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "entry.bin";
}

export function printableStrings(bytes: Buffer, maxBytes = 1024): string {
  const strings = bytes.toString("latin1").match(/[\x20-\x7e]{4,}/g) || [];
  return truncateUtf8(strings.slice(0, 20).join("\n"), maxBytes).text;
}

export function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
