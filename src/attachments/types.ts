import type { OpenAIImageDetail } from "../types/openai.js";

export type AttachmentKind =
  | "image"
  | "text"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "archive"
  | "media"
  | "binary";

export interface AttachmentMetadata {
  [key: string]: string | number | boolean | null | string[];
}

export interface NormalizedAttachmentResult {
  filename: string;
  detectedMimeType: string;
  kind: AttachmentKind;
  extractedText: string;
  imagePaths: string[];
  metadata: AttachmentMetadata;
  warnings: string[];
  truncated: boolean;
  byteLength: number;
  extractedByteLength: number;
}

export interface ExtractionInput {
  filename: string;
  declaredMimeType: string;
  detectedMimeType: string;
  bytes: Buffer;
  path: string;
  directory: string;
  depth: number;
  signal?: AbortSignal;
}

export interface ExtractionContext {
  limits: import("./config.js").AttachmentLimits;
  extractNested: (
    filename: string,
    declaredMimeType: string,
    bytes: Buffer,
    depth: number,
    signal?: AbortSignal
  ) => Promise<NormalizedAttachmentResult>;
}

export interface StoredImage {
  kind: "image";
  path: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  detail?: OpenAIImageDetail;
}

export interface StoredExtractedFile {
  kind: "extracted";
  path: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  result: NormalizedAttachmentResult;
}
