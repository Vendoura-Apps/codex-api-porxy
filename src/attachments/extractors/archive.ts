import type { ContainerEntry } from "../containers.js";
import { detectMimeType } from "../detect.js";
import { AttachmentError, checkAborted } from "../errors.js";
import type { ExtractionContext, ExtractionInput, NormalizedAttachmentResult } from "../types.js";
import { safeNestedFilename, truncateUtf8 } from "../util.js";

const ARCHIVE_MIMES = new Set(["application/zip", "application/x-tar", "application/gzip"]);

export async function extractArchiveEntries(
  input: ExtractionInput,
  entries: ContainerEntry[],
  context: ExtractionContext,
  format: string
): Promise<NormalizedAttachmentResult> {
  const manifest = entries.map((entry, index) =>
    `${index + 1}. ${entry.name} (${entry.bytes.length} bytes; ${detectMimeType(entry.bytes, entry.name)})`
  );
  const sections: string[] = [`Archive manifest (${entries.length} entries):\n${manifest.join("\n")}`];
  const imagePaths: string[] = [];
  const warnings: string[] = [];
  let truncated = false;

  for (const entry of entries) {
    checkAborted(input.signal);
    const detected = detectMimeType(entry.bytes, entry.name);
    if (ARCHIVE_MIMES.has(detected) && input.depth >= context.limits.maxArchiveDepth) {
      warnings.push(`Nested archive ${entry.name} was not expanded because the recursion limit was reached.`);
      continue;
    }
    try {
      const nested = await context.extractNested(
        safeNestedFilename(entry.name), detected, entry.bytes, input.depth + 1, input.signal
      );
      imagePaths.push(...nested.imagePaths);
      truncated ||= nested.truncated;
      warnings.push(...nested.warnings.map((warning) => `${entry.name}: ${warning}`));
      sections.push([
        `--- Archive entry: ${entry.name} ---`,
        `Detected MIME: ${nested.detectedMimeType}; kind: ${nested.kind}; bytes: ${nested.byteLength}`,
        nested.extractedText,
        `--- End archive entry: ${entry.name} ---`,
      ].join("\n"));
    } catch (error) {
      if (error instanceof AttachmentError && [
        "attachment_extractor_unavailable", "attachment_media_backend_unavailable",
      ].includes(error.code)) {
        warnings.push(`${entry.name}: ${error.message}`);
        continue;
      }
      throw error;
    }
  }

  const bounded = truncateUtf8(sections.join("\n\n"), context.limits.maxExtractedBytes);
  truncated ||= bounded.truncated;
  if (bounded.truncated) warnings.push("Archive text output was truncated at the configured extraction limit.");
  return {
    filename: input.filename,
    detectedMimeType: input.detectedMimeType,
    kind: "archive",
    extractedText: bounded.text,
    imagePaths,
    metadata: { format, entries: entries.length, recursionDepth: input.depth },
    warnings,
    truncated,
    byteLength: input.bytes.length,
    extractedByteLength: Buffer.byteLength(bounded.text) + entries.reduce((total, entry) => total + entry.bytes.length, 0),
  };
}
