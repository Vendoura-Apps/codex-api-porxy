const MIB = 1024 * 1024;

export interface AttachmentLimits {
  maxCount: number;
  maxBytes: number;
  maxTotalBytes: number;
  maxExtractedBytes: number;
  extractionTimeoutMs: number;
  maxPdfPages: number;
  maxArchiveEntries: number;
  maxArchiveDepth: number;
  maxArchiveExpandedBytes: number;
  maxSpreadsheetRows: number;
  maxSpreadsheetColumns: number;
  maxSpreadsheetCellBytes: number;
  maxVideoFrames: number;
  enableMediaExtraction: boolean;
  renderPdfImages: boolean;
}

interface IntegerSetting {
  name: string;
  fallback: number;
  maximum: number;
}

function boundedInteger({ name, fallback, maximum }: IntegerSetting): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function booleanSetting(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (/^(?:1|true|yes|on)$/i.test(raw)) return true;
  if (/^(?:0|false|no|off)$/i.test(raw)) return false;
  return fallback;
}

export function attachmentLimits(): AttachmentLimits {
  return {
    maxCount: boundedInteger({ name: "CODEX_ATTACHMENT_MAX_COUNT", fallback: 10, maximum: 100 }),
    maxBytes: boundedInteger({ name: "CODEX_ATTACHMENT_MAX_BYTES", fallback: 10 * MIB, maximum: 100 * MIB }),
    maxTotalBytes: boundedInteger({ name: "CODEX_ATTACHMENT_MAX_TOTAL_BYTES", fallback: 25 * MIB, maximum: 250 * MIB }),
    maxExtractedBytes: boundedInteger({ name: "CODEX_ATTACHMENT_MAX_EXTRACTED_BYTES", fallback: 2 * MIB, maximum: 20 * MIB }),
    extractionTimeoutMs: boundedInteger({ name: "CODEX_ATTACHMENT_EXTRACTION_TIMEOUT_MS", fallback: 15_000, maximum: 120_000 }),
    maxPdfPages: boundedInteger({ name: "CODEX_ATTACHMENT_MAX_PDF_PAGES", fallback: 50, maximum: 500 }),
    maxArchiveEntries: boundedInteger({ name: "CODEX_ATTACHMENT_MAX_ARCHIVE_ENTRIES", fallback: 100, maximum: 1_000 }),
    maxArchiveDepth: boundedInteger({ name: "CODEX_ATTACHMENT_MAX_ARCHIVE_DEPTH", fallback: 2, maximum: 5 }),
    maxArchiveExpandedBytes: boundedInteger({ name: "CODEX_ATTACHMENT_MAX_ARCHIVE_EXPANDED_BYTES", fallback: 25 * MIB, maximum: 250 * MIB }),
    maxSpreadsheetRows: boundedInteger({ name: "CODEX_ATTACHMENT_MAX_SPREADSHEET_ROWS", fallback: 200, maximum: 10_000 }),
    maxSpreadsheetColumns: boundedInteger({ name: "CODEX_ATTACHMENT_MAX_SPREADSHEET_COLUMNS", fallback: 50, maximum: 500 }),
    maxSpreadsheetCellBytes: boundedInteger({ name: "CODEX_ATTACHMENT_MAX_SPREADSHEET_CELL_BYTES", fallback: 4_096, maximum: 65_536 }),
    maxVideoFrames: boundedInteger({ name: "CODEX_ATTACHMENT_MAX_VIDEO_FRAMES", fallback: 4, maximum: 20 }),
    enableMediaExtraction: booleanSetting("CODEX_ATTACHMENT_ENABLE_MEDIA_EXTRACTION"),
    renderPdfImages: booleanSetting("CODEX_ATTACHMENT_RENDER_PDF_IMAGES"),
  };
}

export function requestBodyMaxBytes(): number {
  return boundedInteger({ name: "CODEX_HTTP_BODY_MAX_BYTES", fallback: 40 * MIB, maximum: 500 * MIB });
}
