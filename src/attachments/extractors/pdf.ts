import { chmod, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AttachmentLimits } from "../config.js";
import { validateNativeImage } from "../detect.js";
import { AttachmentError } from "../errors.js";
import { executableAvailable, runExternal } from "../external.js";
import type { ExtractionInput, NormalizedAttachmentResult } from "../types.js";
import { truncateUtf8 } from "../util.js";

async function pdfPageCount(input: ExtractionInput, limits: AttachmentLimits): Promise<number | undefined> {
  const binary = process.env.CODEX_ATTACHMENT_PDFINFO_BIN || "pdfinfo";
  if (!await executableAvailable(binary)) return undefined;
  const result = await runExternal(binary, [input.path], {
    timeoutMs: limits.extractionTimeoutMs,
    maxOutputBytes: 64 * 1024,
    signal: input.signal,
  });
  const pages = Number(result.stdout.toString("utf8").match(/^Pages:\s+(\d+)/mi)?.[1]);
  return Number.isSafeInteger(pages) && pages > 0 ? pages : undefined;
}

async function renderTextlessPages(
  input: ExtractionInput,
  limits: AttachmentLimits,
  textPages: string[],
  pageCount: number
): Promise<string[]> {
  if (!limits.renderPdfImages) return [];
  const binary = process.env.CODEX_ATTACHMENT_PDFTOPPM_BIN || "pdftoppm";
  if (!await executableAvailable(binary)) {
    throw new AttachmentError(
      "PDF image rendering requires pdftoppm", 422, "attachment_extractor_unavailable"
    );
  }
  const imagePaths: string[] = [];
  let totalBytes = 0;
  for (let page = 1; page <= Math.min(pageCount, limits.maxPdfPages); page += 1) {
    if ((textPages[page - 1] || "").trim()) continue;
    const prefix = path.join(input.directory, `pdf-${path.basename(input.path)}-page-${page}`);
    await runExternal(binary, ["-f", String(page), "-l", String(page), "-r", "120", "-png", "-singlefile", input.path, prefix], {
      timeoutMs: limits.extractionTimeoutMs,
      maxOutputBytes: 64 * 1024,
      signal: input.signal,
    });
    const imagePath = `${prefix}.png`;
    await chmod(imagePath, 0o600);
    const rendered = await readFile(imagePath);
    if (!validateNativeImage("image/png", rendered)) {
      throw new AttachmentError("PDF renderer produced an invalid image", 422, "attachment_extraction_failed");
    }
    totalBytes += rendered.length;
    if (totalBytes > limits.maxArchiveExpandedBytes) {
      throw new AttachmentError("Rendered PDF pages exceed the size limit", 413, "attachment_extracted_too_large");
    }
    imagePaths.push(imagePath);
  }
  return imagePaths;
}

export async function extractPdf(input: ExtractionInput, limits: AttachmentLimits): Promise<NormalizedAttachmentResult> {
  const binary = process.env.CODEX_ATTACHMENT_PDFTOTEXT_BIN || "pdftotext";
  if (!await executableAvailable(binary)) {
    throw new AttachmentError(
      "PDF extraction requires pdftotext (Poppler)", 422, "attachment_extractor_unavailable"
    );
  }
  const knownPages = await pdfPageCount(input, limits);
  const result = await runExternal(binary, [
    "-layout", "-f", "1", "-l", String(limits.maxPdfPages), input.path, "-",
  ], {
    timeoutMs: limits.extractionTimeoutMs,
    maxOutputBytes: limits.maxExtractedBytes * 2,
    signal: input.signal,
  });
  const rawPages = result.stdout.toString("utf8").split("\f");
  if (rawPages.at(-1)?.trim() === "") rawPages.pop();
  const pageCount = knownPages || Math.max(rawPages.length, 1);
  const includedPages = Math.min(pageCount, limits.maxPdfPages);
  const output = Array.from({ length: includedPages }, (_, index) =>
    `--- Page ${index + 1} ---\n${(rawPages[index] || "").trim() || "[No extractable text on this page]"}`
  ).join("\n\n");
  const bounded = truncateUtf8(output, limits.maxExtractedBytes);
  const imagePaths = await renderTextlessPages(input, limits, rawPages, includedPages);
  const truncated = bounded.truncated || pageCount > limits.maxPdfPages;
  const warnings: string[] = [];
  if (truncated) warnings.push("PDF output was truncated by page or byte limits.");
  if (rawPages.some((page) => !page.trim())) {
    warnings.push(imagePaths.length
      ? "Pages without extractable text were rendered as bounded image inputs."
      : "Some pages had no extractable text; enable CODEX_ATTACHMENT_RENDER_PDF_IMAGES to render them.");
  }
  return {
    filename: input.filename,
    detectedMimeType: "application/pdf",
    kind: "document",
    extractedText: bounded.text,
    imagePaths,
    metadata: { format: "PDF", pages: pageCount, pagesIncluded: includedPages },
    warnings,
    truncated,
    byteLength: input.bytes.length,
    extractedByteLength: Buffer.byteLength(bounded.text) + await totalImageBytes(imagePaths),
  };
}

async function totalImageBytes(paths: string[]): Promise<number> {
  let total = 0;
  for (const filePath of paths) total += (await stat(filePath)).size;
  return total;
}
