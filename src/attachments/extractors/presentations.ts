import type { AttachmentLimits } from "../config.js";
import type { ContainerEntry } from "../containers.js";
import type { NormalizedAttachmentResult } from "../types.js";
import { stripXml, truncateUtf8, xmlAttribute } from "../util.js";

function numberedEntries(entries: ContainerEntry[], pattern: RegExp): ContainerEntry[] {
  return entries.filter((entry) => pattern.test(entry.name)).sort((a, b) => {
    const aNumber = Number(a.name.match(/(\d+)\.xml$/)?.[1] || 0);
    const bNumber = Number(b.name.match(/(\d+)\.xml$/)?.[1] || 0);
    return aNumber - bNumber;
  });
}

export function extractPptx(
  filename: string,
  bytes: Buffer,
  entries: ContainerEntry[],
  limits: AttachmentLimits
): NormalizedAttachmentResult {
  const slides = numberedEntries(entries, /^ppt\/slides\/slide\d+\.xml$/);
  const notes = new Map(numberedEntries(entries, /^ppt\/notesSlides\/notesSlide\d+\.xml$/)
    .map((entry) => [Number(entry.name.match(/(\d+)\.xml$/)?.[1] || 0), stripXml(entry.bytes.toString("utf8"))]));
  const output = slides.map((slide, index) => {
    const number = Number(slide.name.match(/(\d+)\.xml$/)?.[1] || index + 1);
    const text = stripXml(slide.bytes.toString("utf8"));
    const lines = text.split("\n").filter(Boolean);
    const title = lines[0] || `(Slide ${number})`;
    const note = notes.get(number);
    return `## Slide ${number}: ${title}\n${lines.join("\n")}${note ? `\n\nSpeaker notes:\n${note}` : ""}`;
  }).join("\n\n");
  const bounded = truncateUtf8(output, limits.maxExtractedBytes);
  return {
    filename,
    detectedMimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    kind: "presentation",
    extractedText: bounded.text,
    imagePaths: [],
    metadata: { format: "PPTX", slides: slides.length, notes: notes.size },
    warnings: bounded.truncated ? ["Presentation text was truncated at the configured extraction limit."] : [],
    truncated: bounded.truncated,
    byteLength: bytes.length,
    extractedByteLength: Buffer.byteLength(bounded.text),
  };
}

export function extractOdp(
  filename: string,
  bytes: Buffer,
  entries: ContainerEntry[],
  limits: AttachmentLimits
): NormalizedAttachmentResult {
  const content = entries.find((entry) => entry.name === "content.xml")?.bytes.toString("utf8") || "";
  const slides = [...content.matchAll(/<draw:page\b([^>]*)>([\s\S]*?)<\/draw:page>/gi)];
  const output = slides.map((slide, index) => {
    const name = xmlAttribute(slide[1], "draw:name") || `Slide ${index + 1}`;
    return `## Slide ${index + 1}: ${name}\n${stripXml(slide[2])}`;
  }).join("\n\n");
  const bounded = truncateUtf8(output, limits.maxExtractedBytes);
  return {
    filename,
    detectedMimeType: "application/vnd.oasis.opendocument.presentation",
    kind: "presentation",
    extractedText: bounded.text,
    imagePaths: [],
    metadata: { format: "ODP", slides: slides.length },
    warnings: bounded.truncated ? ["Presentation text was truncated at the configured extraction limit."] : [],
    truncated: bounded.truncated,
    byteLength: bytes.length,
    extractedByteLength: Buffer.byteLength(bounded.text),
  };
}
