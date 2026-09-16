import { readZipEntries } from "../containers.js";
import type { ExtractionContext, ExtractionInput, NormalizedAttachmentResult } from "../types.js";
import { extractArchiveEntries } from "./archive.js";
import { extractOdp, extractPptx } from "./presentations.js";
import { extractOds, extractXlsx } from "./spreadsheets.js";
import { extractDocx, extractOdt } from "./word-documents.js";

export async function extractZipContainer(
  input: ExtractionInput,
  context: ExtractionContext
): Promise<NormalizedAttachmentResult> {
  const entries = await readZipEntries(input.bytes, context.limits, input.signal);
  const names = new Set(entries.map((entry) => entry.name));
  if (names.has("word/document.xml")) {
    return extractDocx(input.filename, input.bytes, entries, context.limits);
  }
  if (names.has("xl/workbook.xml")) {
    return extractXlsx(input.filename, input.bytes, entries, context.limits);
  }
  if (names.has("ppt/presentation.xml") || [...names].some((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))) {
    return extractPptx(input.filename, input.bytes, entries, context.limits);
  }
  const mimetype = entries.find((entry) => entry.name === "mimetype")?.bytes.toString("utf8").trim();
  if (mimetype === "application/vnd.oasis.opendocument.text") {
    return extractOdt(input.filename, input.bytes, entries, context.limits);
  }
  if (mimetype === "application/vnd.oasis.opendocument.spreadsheet") {
    return extractOds(input.filename, input.bytes, entries, context.limits);
  }
  if (mimetype === "application/vnd.oasis.opendocument.presentation") {
    return extractOdp(input.filename, input.bytes, entries, context.limits);
  }
  return extractArchiveEntries(input, entries, context, "ZIP");
}
