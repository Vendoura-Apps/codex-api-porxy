import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import type { AttachmentLimits } from "../config.js";
import { validateNativeImage } from "../detect.js";
import { AttachmentError } from "../errors.js";
import { executableAvailable, runExternal } from "../external.js";
import type { AttachmentMetadata, ExtractionInput, NormalizedAttachmentResult } from "../types.js";
import { truncateUtf8 } from "../util.js";

interface ProbeOutput {
  format?: { duration?: string; size?: string; bit_rate?: string; format_name?: string };
  streams?: Array<{
    codec_type?: string; codec_name?: string; width?: number; height?: number;
    sample_rate?: string; channels?: number; duration?: string;
  }>;
}

async function probeMedia(input: ExtractionInput, limits: AttachmentLimits): Promise<ProbeOutput> {
  const binary = process.env.CODEX_ATTACHMENT_FFPROBE_BIN || "ffprobe";
  if (!await executableAvailable(binary)) {
    throw new AttachmentError(
      "Media metadata extraction requires ffprobe", 422, "attachment_media_backend_unavailable"
    );
  }
  const result = await runExternal(binary, [
    "-v", "error", "-show_format", "-show_streams", "-of", "json", input.path,
  ], { timeoutMs: limits.extractionTimeoutMs, maxOutputBytes: 256 * 1024, signal: input.signal });
  try {
    return JSON.parse(result.stdout.toString("utf8")) as ProbeOutput;
  } catch {
    throw new AttachmentError("Media metadata extraction failed", 422, "attachment_extraction_failed");
  }
}

async function transcribe(input: ExtractionInput, limits: AttachmentLimits): Promise<string | undefined> {
  const binary = process.env.CODEX_ATTACHMENT_TRANSCRIBE_BIN;
  if (!binary) return undefined;
  if (!await executableAvailable(binary)) {
    throw new AttachmentError(
      "Configured local transcription backend is unavailable", 422, "attachment_media_backend_unavailable"
    );
  }
  const result = await runExternal(binary, [input.path], {
    timeoutMs: limits.extractionTimeoutMs,
    maxOutputBytes: limits.maxExtractedBytes,
    signal: input.signal,
  });
  return result.stdout.toString("utf8").trim();
}

async function videoFrames(
  input: ExtractionInput,
  limits: AttachmentLimits,
  duration: number
): Promise<string[]> {
  if (!limits.enableMediaExtraction || !input.detectedMimeType.startsWith("video/")) return [];
  const binary = process.env.CODEX_ATTACHMENT_FFMPEG_BIN || "ffmpeg";
  if (!await executableAvailable(binary)) {
    throw new AttachmentError(
      "Video frame extraction requires ffmpeg", 422, "attachment_media_backend_unavailable"
    );
  }
  const count = Math.max(1, Math.min(limits.maxVideoFrames, duration > 0 ? Math.ceil(duration / 10) : 1));
  const paths: string[] = [];
  let totalBytes = 0;
  for (let index = 0; index < count; index += 1) {
    const timestamp = duration > 0 ? Math.min(duration, ((index + 1) * duration) / (count + 1)) : 0;
    const output = path.join(input.directory, `video-${path.basename(input.path)}-frame-${index + 1}.jpg`);
    await runExternal(binary, [
      "-v", "error", "-ss", timestamp.toFixed(3), "-i", input.path,
      "-frames:v", "1", "-vf", "scale=1280:-2:force_original_aspect_ratio=decrease", "-q:v", "3", "-y", output,
    ], { timeoutMs: limits.extractionTimeoutMs, maxOutputBytes: 64 * 1024, signal: input.signal });
    await chmod(output, 0o600);
    const frame = await readFile(output);
    if (!validateNativeImage("image/jpeg", frame)) {
      throw new AttachmentError("Video extractor produced an invalid image", 422, "attachment_extraction_failed");
    }
    totalBytes += frame.length;
    if (totalBytes > limits.maxArchiveExpandedBytes) {
      throw new AttachmentError("Extracted video frames exceed the size limit", 413, "attachment_extracted_too_large");
    }
    paths.push(output);
  }
  return paths;
}

export async function extractMedia(input: ExtractionInput, limits: AttachmentLimits): Promise<NormalizedAttachmentResult> {
  const probe = await probeMedia(input, limits);
  const duration = Number(probe.format?.duration || probe.streams?.[0]?.duration || 0);
  const streams = (probe.streams || []).map((stream) => [
    stream.codec_type || "unknown", stream.codec_name || "unknown",
    stream.width && stream.height ? `${stream.width}x${stream.height}` : undefined,
    stream.sample_rate ? `${stream.sample_rate}Hz` : undefined,
    stream.channels ? `${stream.channels}ch` : undefined,
  ].filter(Boolean).join("/"));
  const metadata: AttachmentMetadata = {
    format: probe.format?.format_name || input.detectedMimeType,
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    streamSummary: streams,
  };
  const transcript = limits.enableMediaExtraction ? await transcribe(input, limits) : undefined;
  const imagePaths = await videoFrames(input, limits, duration);
  const summary = [
    `Media metadata: ${JSON.stringify(metadata)}`,
    transcript ? `Transcript from configured local backend:\n${transcript}` : "No transcript was produced.",
  ].join("\n\n");
  const bounded = truncateUtf8(summary, limits.maxExtractedBytes);
  const warnings: string[] = [];
  if (!limits.enableMediaExtraction) warnings.push("Media extraction is disabled; only ffprobe metadata is included.");
  else if (!transcript) warnings.push("No local transcription backend is configured; audio was not transcribed.");
  if (bounded.truncated) warnings.push("Media transcript or metadata was truncated.");
  return {
    filename: input.filename,
    detectedMimeType: input.detectedMimeType,
    kind: "media",
    extractedText: bounded.text,
    imagePaths,
    metadata,
    warnings,
    truncated: bounded.truncated,
    byteLength: input.bytes.length,
    extractedByteLength: Buffer.byteLength(bounded.text),
  };
}
