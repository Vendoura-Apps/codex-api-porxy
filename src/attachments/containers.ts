import { promisify } from "node:util";
import { gunzip as gunzipCallback } from "node:zlib";
import tar from "tar-stream";
import yauzl, { type Entry } from "yauzl";
import type { AttachmentLimits } from "./config.js";
import { AttachmentError, checkAborted } from "./errors.js";
import { validateArchiveEntryName } from "./util.js";

const gunzipAsync = promisify(gunzipCallback);

export interface ContainerEntry {
  name: string;
  bytes: Buffer;
  compressedBytes?: number;
}

function rejectUnsafeZipEntry(entry: Entry): void {
  validateArchiveEntryName(entry.fileName);
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new AttachmentError("Encrypted archive entries are not supported", 422, "attachment_encrypted");
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = unixMode & 0xf000;
  if (unixType === 0xa000 || (unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000)) {
    throw new AttachmentError("Archive contains a link or special entry", 400, "attachment_archive_unsafe");
  }
}

export async function readZipEntries(
  bytes: Buffer,
  limits: AttachmentLimits,
  signal?: AbortSignal
): Promise<ContainerEntry[]> {
  checkAborted(signal);
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, decodeStrings: true, strictFileNames: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(new AttachmentError("ZIP attachment could not be opened", 422, "attachment_extraction_failed"));
        return;
      }
      const entries: ContainerEntry[] = [];
      const names = new Set<string>();
      let count = 0;
      let expanded = 0;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        if (error instanceof AttachmentError) reject(error);
        else if (error instanceof Error && /file name|absolute path|relative path|backslash/i.test(error.message)) {
          reject(new AttachmentError("Archive contains an unsafe entry name", 400, "attachment_archive_unsafe"));
        } else reject(new AttachmentError("ZIP attachment extraction failed", 422, "attachment_extraction_failed"));
      };
      const abort = () => fail(new AttachmentError(
        "Attachment extraction was cancelled", 499, "attachment_extraction_aborted"
      ));
      signal?.addEventListener("abort", abort, { once: true });
      zip.once("error", fail);
      zip.once("end", () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolve(entries);
      });
      zip.on("entry", (entry: Entry) => {
        try {
          checkAborted(signal);
          rejectUnsafeZipEntry(entry);
          if (entry.fileName.endsWith("/")) {
            zip.readEntry();
            return;
          }
          if (names.has(entry.fileName)) {
            throw new AttachmentError("Archive contains duplicate entry names", 400, "attachment_archive_unsafe");
          }
          names.add(entry.fileName);
          count += 1;
          if (count > limits.maxArchiveEntries) {
            throw new AttachmentError("Archive contains too many entries", 413, "attachment_too_many_entries");
          }
          if (entry.uncompressedSize > limits.maxBytes) {
            throw new AttachmentError("Archive entry exceeds the size limit", 413, "attachment_extracted_too_large");
          }
          expanded += entry.uncompressedSize;
          if (expanded > limits.maxArchiveExpandedBytes ||
              (entry.uncompressedSize > 1024 * 1024 && entry.uncompressedSize > entry.compressedSize * 1000)) {
            throw new AttachmentError("Archive expanded size exceeds the safety limit", 413, "attachment_extracted_too_large");
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return fail(streamError);
            const chunks: Buffer[] = [];
            let actual = 0;
            stream.on("data", (chunk: Buffer) => {
              actual += chunk.length;
              if (actual > limits.maxBytes || actual + expanded - entry.uncompressedSize > limits.maxArchiveExpandedBytes) {
                stream.destroy(new AttachmentError(
                  "Archive entry exceeds the extraction limit", 413, "attachment_extracted_too_large"
                ));
              } else chunks.push(chunk);
            });
            stream.once("error", fail);
            stream.once("end", () => {
              entries.push({ name: entry.fileName, bytes: Buffer.concat(chunks), compressedBytes: entry.compressedSize });
              zip.readEntry();
            });
          });
        } catch (error) {
          fail(error);
        }
      });
      zip.readEntry();
    });
  });
}

export async function readTarEntries(
  bytes: Buffer,
  limits: AttachmentLimits,
  signal?: AbortSignal
): Promise<ContainerEntry[]> {
  checkAborted(signal);
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    const entries: ContainerEntry[] = [];
    const names = new Set<string>();
    let count = 0;
    let expanded = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      extract.destroy();
      reject(error instanceof AttachmentError ? error : new AttachmentError(
        "TAR attachment extraction failed", 422, "attachment_extraction_failed"
      ));
    };
    const abort = () => fail(new AttachmentError(
      "Attachment extraction was cancelled", 499, "attachment_extraction_aborted"
    ));
    signal?.addEventListener("abort", abort, { once: true });
    extract.on("entry", (header, stream, next) => {
      try {
        checkAborted(signal);
        const name = validateArchiveEntryName(header.name);
        if (header.type === "directory") {
          stream.resume();
          stream.once("end", next);
          return;
        }
        if (header.type !== "file") {
          throw new AttachmentError("Archive contains a link or special entry", 400, "attachment_archive_unsafe");
        }
        if (names.has(name)) {
          throw new AttachmentError("Archive contains duplicate entry names", 400, "attachment_archive_unsafe");
        }
        names.add(name);
        count += 1;
        if (count > limits.maxArchiveEntries) {
          throw new AttachmentError("Archive contains too many entries", 413, "attachment_too_many_entries");
        }
        if ((header.size || 0) > limits.maxBytes) {
          throw new AttachmentError("Archive entry exceeds the size limit", 413, "attachment_extracted_too_large");
        }
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (value: unknown) => {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
          size += chunk.length;
          if (size > limits.maxBytes || expanded + size > limits.maxArchiveExpandedBytes) {
            stream.destroy(new AttachmentError(
              "Archive expanded size exceeds the safety limit", 413, "attachment_extracted_too_large"
            ));
          } else chunks.push(chunk);
        });
        stream.once("error", fail);
        stream.once("end", () => {
          expanded += size;
          entries.push({ name, bytes: Buffer.concat(chunks) });
          next();
        });
      } catch (error) {
        stream.resume();
        fail(error);
      }
    });
    extract.once("error", fail);
    extract.once("finish", () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(entries);
    });
    extract.end(bytes);
  });
}

export async function gunzipBounded(bytes: Buffer, limits: AttachmentLimits): Promise<Buffer> {
  try {
    return await gunzipAsync(bytes, { maxOutputLength: limits.maxArchiveExpandedBytes });
  } catch (error) {
    if (error instanceof Error && /larger than|output length/i.test(error.message)) {
      throw new AttachmentError("Gzip expanded size exceeds the safety limit", 413, "attachment_extracted_too_large");
    }
    throw new AttachmentError("Gzip attachment extraction failed", 422, "attachment_extraction_failed");
  }
}
