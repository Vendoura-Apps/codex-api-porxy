import type { AttachmentLimits } from "../config.js";
import type { ContainerEntry } from "../containers.js";
import type { NormalizedAttachmentResult } from "../types.js";
import { stripXml, truncateUtf8 } from "../util.js";

function entryText(entries: Map<string, Buffer>, name: string): string {
  return entries.get(name)?.toString("utf8") || "";
}

function finalText(text: string, limits: AttachmentLimits): { text: string; truncated: boolean } {
  return truncateUtf8(text, limits.maxExtractedBytes);
}

export function extractDocx(
  filename: string,
  bytes: Buffer,
  entries: ContainerEntry[],
  limits: AttachmentLimits
): NormalizedAttachmentResult {
  const files = new Map(entries.map((entry) => [entry.name, entry.bytes]));
  const document = entryText(files, "word/document.xml");
  const headers = [...files.entries()]
    .filter(([name]) => /^word\/(?:header|footer)\d+\.xml$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, data]) => `\n--- ${name} ---\n${stripXml(data.toString("utf8"), /<\/w:p>/gi)}`)
    .join("");
  const extracted = finalText(stripXml(document, /<\/w:p>/gi) + headers, limits);
  return {
    filename,
    detectedMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    kind: "document",
    extractedText: extracted.text,
    imagePaths: [],
    metadata: { format: "DOCX", xmlParts: entries.length },
    warnings: extracted.truncated ? ["Document text was truncated at the configured extraction limit."] : [],
    truncated: extracted.truncated,
    byteLength: bytes.length,
    extractedByteLength: Buffer.byteLength(extracted.text),
  };
}

export function extractOdt(
  filename: string,
  bytes: Buffer,
  entries: ContainerEntry[],
  limits: AttachmentLimits
): NormalizedAttachmentResult {
  const content = entries.find((entry) => entry.name === "content.xml")?.bytes.toString("utf8") || "";
  const extracted = finalText(stripXml(content), limits);
  return {
    filename,
    detectedMimeType: "application/vnd.oasis.opendocument.text",
    kind: "document",
    extractedText: extracted.text,
    imagePaths: [],
    metadata: { format: "ODT" },
    warnings: extracted.truncated ? ["Document text was truncated at the configured extraction limit."] : [],
    truncated: extracted.truncated,
    byteLength: bytes.length,
    extractedByteLength: Buffer.byteLength(extracted.text),
  };
}

export function extractRtf(
  filename: string,
  bytes: Buffer,
  limits: AttachmentLimits
): NormalizedAttachmentResult {
  const source = bytes.toString("latin1");
  let text = source
    .replace(/\\'[0-9a-f]{2}/gi, (value) => String.fromCharCode(Number.parseInt(value.slice(2), 16)))
    .replace(/\\u(-?\d+)\??/g, (_, value: string) => String.fromCharCode((Number(value) + 65536) % 65536))
    .replace(/\\(?:par|line)\b/g, "\n")
    .replace(/\\tab\b/g, "\t")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/\\[{}\\]/g, (value) => value.slice(1))
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const extracted = finalText(text, limits);
  text = extracted.text;
  return {
    filename,
    detectedMimeType: "application/rtf",
    kind: "document",
    extractedText: text,
    imagePaths: [],
    metadata: { format: "RTF" },
    warnings: extracted.truncated ? ["Document text was truncated at the configured extraction limit."] : [],
    truncated: extracted.truncated,
    byteLength: bytes.length,
    extractedByteLength: Buffer.byteLength(text),
  };
}
