import path from "node:path";

const TEXT_EXTENSIONS: Readonly<Record<string, string>> = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".tsv": "text/tab-separated-values", ".html": "text/html", ".htm": "text/html",
  ".css": "text/css", ".xml": "application/xml", ".yaml": "application/yaml",
  ".yml": "application/yaml", ".json": "application/json", ".js": "text/javascript",
  ".mjs": "text/javascript", ".cjs": "text/javascript", ".ts": "text/typescript",
  ".tsx": "text/typescript", ".jsx": "text/javascript", ".py": "text/x-python",
  ".c": "text/x-c", ".h": "text/x-c", ".cc": "text/x-c++src", ".cpp": "text/x-c++src",
  ".java": "text/x-java-source", ".rs": "text/x-rust", ".go": "text/x-go",
  ".sh": "text/x-shellscript", ".rb": "text/x-ruby", ".php": "text/x-php",
  ".sql": "text/x-sql", ".log": "text/plain", ".ini": "text/plain",
  ".toml": "text/plain", ".env": "text/plain",
};

function starts(bytes: Buffer, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

export function isValidUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function detectMimeType(bytes: Buffer, filename: string): string {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06]) || starts(bytes, [0x50, 0x4b, 0x07, 0x08])) return "application/zip";
  if (starts(bytes, [0x1f, 0x8b])) return "application/gzip";
  if (bytes.length > 262 && bytes.subarray(257, 262).toString("ascii") === "ustar") return "application/x-tar";
  if (bytes.subarray(0, 5).toString("ascii") === "{\\rtf") return "application/rtf";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";
  if (bytes.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  if (bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes.length > 1 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii");
    if (/^(?:M4A|M4B|f4a)/i.test(brand)) return "audio/mp4";
    if (/^(?:qt  )$/i.test(brand)) return "video/quicktime";
    return "video/mp4";
  }
  if (isValidUtf8Text(bytes)) return TEXT_EXTENSIONS[path.extname(filename).toLowerCase()] || "text/plain";
  return "application/octet-stream";
}

export function validateNativeImage(mimeType: string, bytes: Buffer): boolean {
  return detectMimeType(bytes, "image") === mimeType && ["image/png", "image/jpeg", "image/webp"].includes(mimeType);
}
