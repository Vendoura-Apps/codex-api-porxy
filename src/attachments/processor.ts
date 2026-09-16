import { gunzipBounded, readTarEntries } from "./containers.js";
import { detectMimeType, isValidUtf8Text } from "./detect.js";
import { AttachmentError, checkAborted } from "./errors.js";
import type { ExtractionContext, ExtractionInput, NormalizedAttachmentResult } from "./types.js";
import { sha256 } from "./util.js";
import { extractArchiveEntries } from "./extractors/archive.js";
import { extractText, extractUnknownBinary } from "./extractors/basic.js";
import { extractMedia } from "./extractors/media.js";
import { extractPdf } from "./extractors/pdf.js";
import { extractRtf } from "./extractors/word-documents.js";
import { extractZipContainer } from "./extractors/zip-container.js";

const MEDIA_MIMES = new Set([
  "audio/mpeg", "audio/wav", "audio/mp4", "audio/ogg",
  "video/mp4", "video/webm", "video/quicktime",
]);

export async function extractAttachment(
  input: ExtractionInput,
  context: ExtractionContext
): Promise<NormalizedAttachmentResult> {
  checkAborted(input.signal);
  if (input.depth > context.limits.maxArchiveDepth && [
    "application/zip", "application/x-tar", "application/gzip",
  ].includes(input.detectedMimeType)) {
    throw new AttachmentError("Nested archive depth exceeds the safety limit", 400, "attachment_archive_unsafe");
  }
  if (input.detectedMimeType.startsWith("image/")) {
    const notice = "Image content is supplied to Codex as a native image input.";
    return {
      filename: input.filename,
      detectedMimeType: input.detectedMimeType,
      kind: "image",
      extractedText: notice,
      imagePaths: [input.path],
      metadata: { sha256: sha256(input.bytes), declaredMimeType: input.declaredMimeType },
      warnings: [],
      truncated: false,
      byteLength: input.bytes.length,
      extractedByteLength: 0,
    };
  }
  if (input.detectedMimeType === "application/pdf") return extractPdf(input, context.limits);
  if (input.detectedMimeType === "application/rtf") {
    return extractRtf(input.filename, input.bytes, context.limits);
  }
  if (input.detectedMimeType === "application/zip") return extractZipContainer(input, context);
  if (input.detectedMimeType === "application/x-tar") {
    const entries = await readTarEntries(input.bytes, context.limits, input.signal);
    return extractArchiveEntries(input, entries, context, "TAR");
  }
  if (input.detectedMimeType === "application/gzip") {
    const uncompressed = await gunzipBounded(input.bytes, context.limits);
    const nestedName = input.filename.replace(/\.(?:tgz|gz)$/i, input.filename.toLowerCase().endsWith(".tgz") ? ".tar" : "") || "gzip-content";
    const detected = detectMimeType(uncompressed, nestedName);
    const nested = await context.extractNested(nestedName, detected, uncompressed, input.depth + 1, input.signal);
    return {
      ...nested,
      filename: input.filename,
      detectedMimeType: "application/gzip",
      kind: "archive",
      metadata: { format: "GZIP", nestedType: nested.detectedMimeType, recursionDepth: input.depth },
      byteLength: input.bytes.length,
      extractedByteLength: uncompressed.length + nested.extractedByteLength,
    };
  }
  if (MEDIA_MIMES.has(input.detectedMimeType)) return extractMedia(input, context.limits);
  if (isValidUtf8Text(input.bytes)) return extractText(input, context.limits);
  return extractUnknownBinary(input);
}
