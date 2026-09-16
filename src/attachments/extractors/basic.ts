import type { AttachmentLimits } from "../config.js";
import type { ExtractionInput, NormalizedAttachmentResult } from "../types.js";
import { printableStrings, sha256, truncateUtf8 } from "../util.js";

export function extractText(input: ExtractionInput, limits: AttachmentLimits): NormalizedAttachmentResult {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  const bounded = truncateUtf8(decoded, limits.maxExtractedBytes);
  return {
    filename: input.filename,
    detectedMimeType: input.detectedMimeType,
    kind: "text",
    extractedText: bounded.text,
    imagePaths: [],
    metadata: { sha256: sha256(input.bytes), declaredMimeType: input.declaredMimeType },
    warnings: bounded.truncated ? ["Text was truncated at the configured extraction limit."] : [],
    truncated: bounded.truncated,
    byteLength: input.bytes.length,
    extractedByteLength: Buffer.byteLength(bounded.text),
  };
}

export function extractUnknownBinary(input: ExtractionInput): NormalizedAttachmentResult {
  const preview = printableStrings(input.bytes);
  const notice = [
    "Semantic content was not extracted from this binary attachment.",
    "Do not infer its contents from the filename or extension.",
    preview ? `Limited printable-string preview:\n${preview}` : "No safe printable-string preview was available.",
  ].join("\n");
  return {
    filename: input.filename,
    detectedMimeType: input.detectedMimeType,
    kind: "binary",
    extractedText: notice,
    imagePaths: [],
    metadata: {
      sha256: sha256(input.bytes),
      declaredMimeType: input.declaredMimeType,
      detectedType: input.detectedMimeType,
    },
    warnings: ["No semantic extractor is available; only safe metadata and a bounded printable preview are included."],
    truncated: false,
    byteLength: input.bytes.length,
    extractedByteLength: Buffer.byteLength(notice),
  };
}
