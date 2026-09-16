import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import tar from "tar-stream";
import yazl from "yazl";
import { prepareCodexInput } from "../adapter/openai-to-codex.js";
import { AttachmentError } from "./attachment-store.js";
import { executableAvailable, runExternal } from "./external.js";

const originalEnv = { ...process.env };
const testRoots: string[] = [];

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function dataUrl(mime: string, bytes: Buffer | string): string {
  const value = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  return `data:${mime};base64,${value.toString("base64")}`;
}

function request(filename: string, mime: string, bytes: Buffer | string): any {
  return {
    model: "codex",
    messages: [{ role: "user", content: [{
      type: "input_file", filename, file_data: dataUrl(mime, bytes),
    }] }],
  };
}

async function testRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "universal-attachment-tests-"));
  testRoots.push(root);
  process.env.CODEX_ATTACHMENT_TMPDIR = root;
  return root;
}

async function zip(entries: Array<[string, Buffer | string]>): Promise<Buffer> {
  const archive = new yazl.ZipFile();
  for (const [name, value] of entries) {
    archive.addBuffer(typeof value === "string" ? Buffer.from(value) : value, name);
  }
  archive.end();
  const chunks: Buffer[] = [];
  for await (const chunk of archive.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function patchZipFilename(bytes: Buffer, from: string, to: string): Buffer {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  const result = Buffer.from(bytes);
  let offset = 0;
  while ((offset = result.indexOf(from, offset, "utf8")) >= 0) {
    result.write(to, offset, "utf8");
    offset += to.length;
  }
  return result;
}

function markZipEncrypted(bytes: Buffer): Buffer {
  const result = Buffer.from(bytes);
  let offset = 0;
  while ((offset = result.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), offset)) >= 0) {
    result.writeUInt16LE(result.readUInt16LE(offset + 6) | 1, offset + 6);
    offset += 4;
  }
  offset = 0;
  while ((offset = result.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset)) >= 0) {
    result.writeUInt16LE(result.readUInt16LE(offset + 8) | 1, offset + 8);
    offset += 4;
  }
  return result;
}

function minimalPdf(text: string): Buffer {
  const escaped = text.replace(/([()\\])/g, "\\$1");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function minimalWav(): Buffer {
  const samples = Buffer.alloc(800);
  const wav = Buffer.alloc(44 + samples.length);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples.length, 4); wav.write("WAVE", 8);
  wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8_000, 24); wav.writeUInt32LE(16_000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
  wav.writeUInt32LE(samples.length, 40); samples.copy(wav, 44);
  return wav;
}

async function tarBuffer(entries: Array<[string, string]>): Promise<Buffer> {
  const pack = tar.pack();
  for (const [name, value] of entries) pack.entry({ name }, value);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

async function symlinkTar(): Promise<Buffer> {
  const pack = tar.pack();
  pack.entry({ name: "unsafe-link", type: "symlink", linkname: "target" });
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

async function attachmentError(promise: Promise<unknown>, code: string): Promise<AttachmentError> {
  try {
    await promise;
    assert.fail("Expected attachment error");
  } catch (error) {
    assert.ok(error instanceof AttachmentError);
    assert.equal(error.code, code);
    return error;
  }
}

describe("universal attachment extractors", () => {
  it("extracts PDF text per page when Poppler is available", async (context) => {
    if (!await executableAvailable(process.env.CODEX_ATTACHMENT_PDFTOTEXT_BIN || "pdftotext")) {
      context.skip("pdftotext is not installed");
      return;
    }
    await testRoot();
    const input = await prepareCodexInput(request("report.pdf", "text/plain", minimalPdf("Hello PDF fixture")));
    assert.match(input.prompt, /mime_type="application\/pdf"/);
    assert.match(input.prompt, /Page 1/);
    assert.match(input.prompt, /Hello PDF fixture/);
    input.attachmentStore.cleanup();
  });

  it("detects a DOCX despite a false client MIME and extracts paragraphs and tables", async () => {
    await testRoot();
    const docx = await zip([
      ["[Content_Types].xml", "<Types/>"] ,
      ["word/document.xml", "<w:document><w:body><w:p><w:r><w:t>First paragraph</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"],
    ]);
    const input = await prepareCodexInput(request("notes.bin", "application/octet-stream", docx));
    assert.match(input.prompt, /wordprocessingml\.document/);
    assert.match(input.prompt, /First paragraph/);
    assert.match(input.prompt, /Cell A/);
    input.attachmentStore.cleanup();
  });

  it("extracts multiple XLSX sheets with row and sheet boundaries", async () => {
    await testRoot();
    const xlsx = await zip([
      ["[Content_Types].xml", "<Types/>"] ,
      ["xl/workbook.xml", '<workbook><sheets><sheet name="Alpha" r:id="rId1"/><sheet name="Beta" r:id="rId2"/></sheets></workbook>'],
      ["xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'],
      ["xl/sharedStrings.xml", "<sst><si><t>Name</t></si><si><t>Alice</t></si><si><t>Status</t></si><si><t>Done</t></si></sst>"],
      ["xl/worksheets/sheet1.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>'],
      ["xl/worksheets/sheet2.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c></row></sheetData></worksheet>'],
    ]);
    const input = await prepareCodexInput(request("book.xlsx", "application/zip", xlsx));
    assert.match(input.prompt, /Sheet 1: Alpha/);
    assert.match(input.prompt, /Alice/);
    assert.match(input.prompt, /Sheet 2: Beta/);
    assert.match(input.prompt, /Done/);
    input.attachmentStore.cleanup();
  });

  it("extracts PPTX slides and speaker notes in order", async () => {
    await testRoot();
    const pptx = await zip([
      ["ppt/presentation.xml", "<p:presentation/>"] ,
      ["ppt/slides/slide1.xml", "<p:sld><a:p><a:r><a:t>Launch Plan</a:t></a:r></a:p><a:p><a:r><a:t>Phase one</a:t></a:r></a:p></p:sld>"],
      ["ppt/notesSlides/notesSlide1.xml", "<p:notes><a:p><a:r><a:t>Private speaker note</a:t></a:r></a:p></p:notes>"],
    ]);
    const input = await prepareCodexInput(request("deck.pptx", "application/zip", pptx));
    assert.match(input.prompt, /Slide 1: Launch Plan/);
    assert.match(input.prompt, /Phase one/);
    assert.match(input.prompt, /Speaker notes/);
    assert.match(input.prompt, /Private speaker note/);
    input.attachmentStore.cleanup();
  });

  it("extracts ODT, ODS, ODP, and RTF fixtures", async () => {
    await testRoot();
    const fixtures: Array<[string, string, Buffer | string, RegExp]> = [
      ["doc.odt", "application/zip", await zip([
        ["mimetype", "application/vnd.oasis.opendocument.text"],
        ["content.xml", "<office:text><text:p>ODT paragraph</text:p></office:text>"],
      ]), /ODT paragraph/],
      ["sheet.ods", "application/zip", await zip([
        ["mimetype", "application/vnd.oasis.opendocument.spreadsheet"],
        ["content.xml", '<table:table table:name="Data"><table:table-row><table:table-cell><text:p>ODS cell</text:p></table:table-cell></table:table-row></table:table>'],
      ]), /ODS cell/],
      ["slides.odp", "application/zip", await zip([
        ["mimetype", "application/vnd.oasis.opendocument.presentation"],
        ["content.xml", '<draw:page draw:name="Intro"><text:p>ODP slide</text:p></draw:page>'],
      ]), /ODP slide/],
      ["legacy.rtf", "application/rtf", "{\\rtf1\\ansi RTF paragraph\\par Next line}", /RTF paragraph/],
    ];
    for (const [filename, mime, bytes, expected] of fixtures) {
      const input = await prepareCodexInput(request(filename, mime, bytes));
      assert.match(input.prompt, expected);
      input.attachmentStore.cleanup();
    }
  });

  it("extracts safe ZIP, TAR, and TGZ archives without writing entry paths freely", async () => {
    await testRoot();
    const zipInput = await prepareCodexInput(request("safe.zip", "application/zip", await zip([
      ["folder/readme.txt", "inside zip"],
    ])));
    assert.match(zipInput.prompt, /Archive manifest/);
    assert.match(zipInput.prompt, /inside zip/);
    zipInput.attachmentStore.cleanup();

    const tarBytes = await tarBuffer([["folder/data.csv", "a,b\n1,2"]]);
    const tarInput = await prepareCodexInput(request("safe.tar", "application/x-tar", tarBytes));
    assert.match(tarInput.prompt, /data\.csv/);
    assert.match(tarInput.prompt, /1,2/);
    tarInput.attachmentStore.cleanup();

    const tgzInput = await prepareCodexInput(request("safe.tgz", "application/gzip", gzipSync(tarBytes)));
    assert.match(tgzInput.prompt, /data\.csv/);
    tgzInput.attachmentStore.cleanup();
  });

  it("rejects ZIP traversal, encrypted entries, and entry-count bombs", async () => {
    await attachmentError(prepareCodexInput(request(
      "unsafe.zip", "application/zip", patchZipFilename(await zip([["safe.txt", "secret"]]), "safe.txt", "../a.txt")
    )), "attachment_archive_unsafe");
    await attachmentError(prepareCodexInput(request(
      "links.tar", "application/x-tar", await symlinkTar()
    )), "attachment_archive_unsafe");

    await attachmentError(prepareCodexInput(request(
      "encrypted.zip", "application/zip", markZipEncrypted(await zip([["safe.txt", "secret"]]))
    )), "attachment_encrypted");

    process.env.CODEX_ATTACHMENT_MAX_ARCHIVE_ENTRIES = "1";
    await attachmentError(prepareCodexInput(request(
      "many.zip", "application/zip", await zip([["one.txt", "1"], ["two.txt", "2"]])
    )), "attachment_too_many_entries");

    process.env.CODEX_ATTACHMENT_MAX_ARCHIVE_ENTRIES = "100";
    process.env.CODEX_ATTACHMENT_MAX_ARCHIVE_EXPANDED_BYTES = "32";
    await attachmentError(prepareCodexInput(request(
      "bomb.zip", "application/zip", await zip([["large.txt", "A".repeat(1_024)]])
    )), "attachment_extracted_too_large");
  });

  it("returns bounded metadata for an unknown binary without claiming semantic understanding", async () => {
    await testRoot();
    const input = await prepareCodexInput(request(
      "firmware.bin", "text/plain", Buffer.from([0, 1, 2, 3, ...Buffer.from("PRINTABLE_MARKER"), 0xff])
    ));
    assert.match(input.prompt, /kind="binary"/);
    assert.match(input.prompt, /Semantic content was not extracted/);
    assert.match(input.prompt, /PRINTABLE_MARKER/);
    assert.match(input.prompt, /sha256/);
    input.attachmentStore.cleanup();
  });

  it("returns a structured error when an optional media backend is unavailable", async () => {
    process.env.CODEX_ATTACHMENT_FFPROBE_BIN = "/definitely/missing/ffprobe";
    const wav = Buffer.alloc(44);
    wav.write("RIFF", 0); wav.writeUInt32LE(36, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
    const error = await attachmentError(
      prepareCodexInput(request("audio.wav", "audio/wav", wav)),
      "attachment_media_backend_unavailable"
    );
    assert.doesNotMatch(error.message, /definitely|missing/);
  });

  it("extracts bounded WAV metadata when ffprobe is available", async (context) => {
    if (!await executableAvailable(process.env.CODEX_ATTACHMENT_FFPROBE_BIN || "ffprobe")) {
      context.skip("ffprobe is not installed");
      return;
    }
    await testRoot();
    const input = await prepareCodexInput(request("sample.wav", "application/octet-stream", minimalWav()));
    assert.match(input.prompt, /kind="media"/);
    assert.match(input.prompt, /pcm_s16le/);
    assert.match(input.prompt, /Media extraction is disabled/);
    input.attachmentStore.cleanup();
  });

  it("extracts a bounded native frame from video when ffmpeg is enabled", async (context) => {
    const ffmpeg = process.env.CODEX_ATTACHMENT_FFMPEG_BIN || "ffmpeg";
    const ffprobe = process.env.CODEX_ATTACHMENT_FFPROBE_BIN || "ffprobe";
    if (!await executableAvailable(ffmpeg) || !await executableAvailable(ffprobe)) {
      context.skip("ffmpeg/ffprobe is not installed");
      return;
    }
    const root = await testRoot();
    const videoPath = path.join(root, "fixture.mp4");
    await runExternal(ffmpeg, [
      "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.2",
      "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-y", videoPath,
    ], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    process.env.CODEX_ATTACHMENT_ENABLE_MEDIA_EXTRACTION = "true";
    process.env.CODEX_ATTACHMENT_MAX_VIDEO_FRAMES = "1";
    const input = await prepareCodexInput(request(
      "clip.mp4", "application/octet-stream", await readFile(videoPath)
    ));
    assert.equal(input.imagePaths.length, 1);
    assert.equal(input.appServerInput.some((part) => part.type === "localImage"), true);
    assert.match(input.prompt, /No local transcription backend is configured/);
    input.attachmentStore.cleanup();
  });

  it("times out an external extractor and cleans temporary files", async () => {
    const root = await testRoot();
    const fake = path.join(root, "slow-pdftotext");
    await writeFile(fake, "#!/bin/sh\nsleep 2\n", { mode: 0o700 });
    await chmod(fake, 0o700);
    process.env.CODEX_ATTACHMENT_PDFTOTEXT_BIN = fake;
    process.env.CODEX_ATTACHMENT_PDFINFO_BIN = "/definitely/missing/pdfinfo";
    process.env.CODEX_ATTACHMENT_EXTRACTION_TIMEOUT_MS = "50";
    const error = await attachmentError(
      prepareCodexInput(request("slow.pdf", "application/pdf", minimalPdf("slow"))),
      "attachment_extraction_timeout"
    );
    assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(await readdir(root), ["slow-pdftotext"]);
  });

  it("honors an aborted extraction and cleans request-scoped files", async () => {
    const root = await testRoot();
    const controller = new AbortController();
    controller.abort();
    await attachmentError(prepareCodexInput(
      request("cancelled.txt", "text/plain", "private content"), undefined, controller.signal
    ), "attachment_extraction_aborted");
    assert.deepEqual(await readdir(root), []);
  });
});
