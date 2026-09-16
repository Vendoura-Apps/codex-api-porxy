import type { AttachmentLimits } from "../config.js";
import type { ContainerEntry } from "../containers.js";
import type { NormalizedAttachmentResult } from "../types.js";
import { stripXml, truncateUtf8, xmlAttribute } from "../util.js";

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0].toUpperCase() || "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, index - 1);
}

function markdownTable(rows: string[][]): string {
  if (!rows.length) return "(empty sheet)";
  const width = Math.max(...rows.map((row) => row.length), 1);
  const clean = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const padded = rows.map((row) => Array.from({ length: width }, (_, index) => clean(row[index] || "")));
  return [
    `| ${padded[0].join(" | ")} |`,
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...padded.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function cellText(cellXml: string, shared: string[], limits: AttachmentLimits): string {
  const tag = cellXml.match(/^<c\b([^>]*)>/i)?.[1] || "";
  const type = xmlAttribute(tag, "t");
  const value = cellXml.match(/<v[^>]*>([\s\S]*?)<\/v>/i)?.[1] || "";
  const inline = cellXml.match(/<is[^>]*>([\s\S]*?)<\/is>/i)?.[1];
  let result = type === "s" ? shared[Number(value)] || "" : inline ? stripXml(inline) : value;
  return truncateUtf8(result, limits.maxSpreadsheetCellBytes).text;
}

function xlsxSheet(xml: string, shared: string[], limits: AttachmentLimits): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let truncated = false;
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    if (rows.length >= limits.maxSpreadsheetRows) { truncated = true; break; }
    const row: string[] = [];
    for (const cell of rowMatch[1].matchAll(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/gi)) {
      const reference = cell[0].match(/\br=["']([^"']+)/i)?.[1] || "A1";
      const index = columnIndex(reference);
      if (index >= limits.maxSpreadsheetColumns) { truncated = true; continue; }
      row[index] = cellText(cell[0], shared, limits);
    }
    rows.push(row.slice(0, limits.maxSpreadsheetColumns));
  }
  return { rows, truncated };
}

export function extractXlsx(
  filename: string,
  bytes: Buffer,
  entries: ContainerEntry[],
  limits: AttachmentLimits
): NormalizedAttachmentResult {
  const files = new Map(entries.map((entry) => [entry.name, entry.bytes]));
  const sharedXml = files.get("xl/sharedStrings.xml")?.toString("utf8") || "";
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) => stripXml(match[1]));
  const workbook = files.get("xl/workbook.xml")?.toString("utf8") || "";
  const relationships = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") || "";
  const targets = new Map([...relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)].map((match) => [
    xmlAttribute(match[1], "Id") || "",
    xmlAttribute(match[1], "Target") || "",
  ]));
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)];
  const output: string[] = [];
  let truncated = false;
  for (let index = 0; index < sheets.length; index += 1) {
    const attrs = sheets[index][1];
    const name = xmlAttribute(attrs, "name") || `Sheet ${index + 1}`;
    const relationshipId = xmlAttribute(attrs, "r:id") || "";
    const target = targets.get(relationshipId) || `worksheets/sheet${index + 1}.xml`;
    const normalizedTarget = target.replace(/^\/?xl\//, "").replace(/^\//, "");
    const xml = files.get(`xl/${normalizedTarget}`)?.toString("utf8") || "";
    const parsed = xlsxSheet(xml, shared, limits);
    truncated ||= parsed.truncated;
    output.push(`## Sheet ${index + 1}: ${name}\n${markdownTable(parsed.rows)}`);
  }
  const bounded = truncateUtf8(output.join("\n\n"), limits.maxExtractedBytes);
  truncated ||= bounded.truncated;
  return {
    filename,
    detectedMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "spreadsheet",
    extractedText: bounded.text,
    imagePaths: [],
    metadata: { format: "XLSX", sheets: sheets.length },
    warnings: truncated ? ["Spreadsheet output was truncated by row, column, cell, or byte limits."] : [],
    truncated,
    byteLength: bytes.length,
    extractedByteLength: Buffer.byteLength(bounded.text),
  };
}

function odsCellText(xml: string, limits: AttachmentLimits): string {
  return truncateUtf8(stripXml(xml), limits.maxSpreadsheetCellBytes).text;
}

export function extractOds(
  filename: string,
  bytes: Buffer,
  entries: ContainerEntry[],
  limits: AttachmentLimits
): NormalizedAttachmentResult {
  const content = entries.find((entry) => entry.name === "content.xml")?.bytes.toString("utf8") || "";
  const output: string[] = [];
  let truncated = false;
  let sheetCount = 0;
  for (const table of content.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/gi)) {
    sheetCount += 1;
    const name = xmlAttribute(table[1], "table:name") || `Sheet ${sheetCount}`;
    const rows: string[][] = [];
    for (const rowMatch of table[2].matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/gi)) {
      if (rows.length >= limits.maxSpreadsheetRows) { truncated = true; break; }
      const row: string[] = [];
      for (const cell of rowMatch[1].matchAll(/<table:table-cell\b([^>]*)>([\s\S]*?)<\/table:table-cell>/gi)) {
        const repeats = Math.min(Number(xmlAttribute(cell[1], "table:number-columns-repeated") || 1), limits.maxSpreadsheetColumns);
        for (let index = 0; index < repeats && row.length < limits.maxSpreadsheetColumns; index += 1) {
          row.push(odsCellText(cell[2], limits));
        }
        if (row.length >= limits.maxSpreadsheetColumns) truncated = true;
      }
      rows.push(row);
    }
    output.push(`## Sheet ${sheetCount}: ${name}\n${markdownTable(rows)}`);
  }
  const bounded = truncateUtf8(output.join("\n\n"), limits.maxExtractedBytes);
  truncated ||= bounded.truncated;
  return {
    filename,
    detectedMimeType: "application/vnd.oasis.opendocument.spreadsheet",
    kind: "spreadsheet",
    extractedText: bounded.text,
    imagePaths: [],
    metadata: { format: "ODS", sheets: sheetCount },
    warnings: truncated ? ["Spreadsheet output was truncated by row, column, cell, or byte limits."] : [],
    truncated,
    byteLength: bytes.length,
    extractedByteLength: Buffer.byteLength(bounded.text),
  };
}
