import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { prepareCodexInput } from "../adapter/openai-to-codex.js";
import { AttachmentError, requestBodyMaxBytes } from "./attachment-store.js";

const PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82,
]);

const originalEnv = { ...process.env };
const testRoots: string[] = [];

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function dataUrl(mime: string, bytes: Buffer | string): string {
  const data = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return `data:${mime};base64,${data.toString("base64")}`;
}

async function useTestRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "attachment-tests-"));
  testRoots.push(root);
  process.env.CODEX_ATTACHMENT_TMPDIR = root;
  return root;
}

function requestWith(content: any[]): any {
  return { model: "codex", messages: [{ role: "user", content }] };
}

async function expectAttachmentError(promise: Promise<unknown>, code: string, status: number): Promise<AttachmentError> {
  try {
    await promise;
    assert.fail("Expected attachment parsing to fail");
  } catch (error) {
    assert.ok(error instanceof AttachmentError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return error;
  }
}

describe("attachment preparation", () => {
  it("keeps legacy text-only requests unchanged", async () => {
    const input = await prepareCodexInput({
      model: "codex",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(input.prompt, "hello");
    assert.deepEqual(input.imagePaths, []);
    assert.deepEqual(input.appServerInput, [{ type: "text", text: "hello", text_elements: [] }]);
    assert.equal(input.attachmentStore.directory, undefined);
    input.attachmentStore.cleanup();
  });

  it("uses a configurable HTTP body limit", () => {
    assert.equal(requestBodyMaxBytes(), 40 * 1024 * 1024);
    process.env.CODEX_HTTP_BODY_MAX_BYTES = "12345";
    assert.equal(requestBodyMaxBytes(), 12345);
  });

  it("stores a valid PNG with restrictive permissions", async () => {
    await useTestRoot();
    const input = await prepareCodexInput(requestWith([{
      type: "image_url",
      image_url: { url: dataUrl("image/png", PNG), detail: "auto" },
    }]));
    assert.equal(input.imagePaths.length, 1);
    assert.equal(input.appServerInput.some((part) => part.type === "localImage"), true);
    assert.equal((await stat(input.imagePaths[0])).mode & 0o777, 0o600);
    assert.equal((await stat(input.attachmentStore.directory!)).mode & 0o777, 0o700);
    input.attachmentStore.cleanup();
  });

  it("supports multiple images and the input_image alias", async () => {
    await useTestRoot();
    const image = dataUrl("image/png", PNG);
    const input = await prepareCodexInput(requestWith([
      { type: "image_url", image_url: { url: image } },
      { type: "input_image", image_url: image, detail: "high" },
    ]));
    assert.equal(input.imagePaths.length, 2);
    assert.equal(input.appServerInput.filter((part) => part.type === "localImage").length, 2);
    input.attachmentStore.cleanup();
  });

  it("accepts JPEG and WebP signatures", async () => {
    await useTestRoot();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const webp = Buffer.from("RIFF0000WEBP", "ascii");
    const input = await prepareCodexInput(requestWith([
      { type: "image_url", image_url: dataUrl("image/jpeg", jpeg) },
      { type: "image_url", image_url: dataUrl("image/webp", webp) },
    ]));
    assert.match(input.imagePaths[0], /\.jpg$/);
    assert.match(input.imagePaths[1], /\.webp$/);
    input.attachmentStore.cleanup();
  });

  it("embeds a UTF-8 Markdown file with a clear boundary", async () => {
    await useTestRoot();
    const input = await prepareCodexInput(requestWith([{
      type: "input_file",
      filename: "requirements.md",
      file_data: dataUrl("text/markdown", "# Requirements\n\nUse TypeScript."),
    }]));
    assert.match(input.prompt, /<attachment filename="requirements\.md" mime_type="text\/markdown"/);
    assert.match(input.prompt, /Use TypeScript\./);
    assert.match(input.prompt, /<\/attachment>/);
    input.attachmentStore.cleanup();
  });

  it("preserves mixed text, image, and file order for App Server", async () => {
    await useTestRoot();
    const input = await prepareCodexInput(requestWith([
      { type: "text", text: "before" },
      { type: "image_url", image_url: { url: dataUrl("image/png", PNG) } },
      { type: "input_file", filename: "notes.txt", file_data: dataUrl("text/plain", "file-body") },
      { type: "input_text", text: "after" },
    ]));
    assert.deepEqual(input.appServerInput.map((part) => part.type), ["text", "localImage", "text"]);
    const combinedText = input.appServerInput.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    assert.ok(combinedText.indexOf("before") < combinedText.indexOf("file-body"));
    assert.ok(combinedText.indexOf("file-body") < combinedText.indexOf("after"));
    input.attachmentStore.cleanup();
  });

  it("rejects malformed base64 without echoing it", async () => {
    const secretPayload = "PRIVATE_BASE64_MARKER!";
    const error = await expectAttachmentError(prepareCodexInput(requestWith([{
      type: "image_url",
      image_url: { url: `data:image/png;base64,${secretPayload}` },
    }])), "invalid_attachment_base64", 400);
    assert.doesNotMatch(error.message, /PRIVATE_BASE64_MARKER/);
  });

  it("rejects unsupported MIME types and PDFs", async () => {
    await expectAttachmentError(prepareCodexInput(requestWith([{
      type: "image_url",
      image_url: { url: dataUrl("image/gif", Buffer.from("GIF89a")) },
    }])), "unsupported_attachment_mime", 400);
    await expectAttachmentError(prepareCodexInput(requestWith([{
      type: "input_file",
      filename: "document.pdf",
      file_data: dataUrl("application/pdf", "%PDF-1.7"),
    }])), "pdf_attachment_unsupported", 400);
  });

  it("rejects mismatched image signatures and invalid UTF-8", async () => {
    await expectAttachmentError(prepareCodexInput(requestWith([{
      type: "image_url",
      image_url: { url: dataUrl("image/png", Buffer.from("not-a-png")) },
    }])), "invalid_image_signature", 400);
    await expectAttachmentError(prepareCodexInput(requestWith([{
      type: "input_file",
      filename: "broken.txt",
      file_data: dataUrl("text/plain", Buffer.from([0xc3, 0x28])),
    }])), "invalid_attachment_utf8", 400);
  });

  it("enforces per-attachment, total-size, and count limits", async () => {
    process.env.CODEX_ATTACHMENT_MAX_BYTES = "3";
    await expectAttachmentError(prepareCodexInput(requestWith([{
      type: "input_file", filename: "large.txt", file_data: dataUrl("text/plain", "four"),
    }])), "attachment_too_large", 413);

    process.env.CODEX_ATTACHMENT_MAX_BYTES = "100";
    process.env.CODEX_ATTACHMENT_MAX_TOTAL_BYTES = "5";
    await expectAttachmentError(prepareCodexInput(requestWith([
      { type: "input_file", filename: "a.txt", file_data: dataUrl("text/plain", "abc") },
      { type: "input_file", filename: "b.txt", file_data: dataUrl("text/plain", "def") },
    ])), "attachments_total_too_large", 413);

    process.env.CODEX_ATTACHMENT_MAX_TOTAL_BYTES = "100";
    process.env.CODEX_ATTACHMENT_MAX_COUNT = "1";
    await expectAttachmentError(prepareCodexInput(requestWith([
      { type: "input_file", filename: "a.txt", file_data: dataUrl("text/plain", "a") },
      { type: "input_file", filename: "b.txt", file_data: dataUrl("text/plain", "b") },
    ])), "too_many_attachments", 413);
  });

  it("rejects traversal filenames, file_id, and remote URLs", async () => {
    await expectAttachmentError(prepareCodexInput(requestWith([{
      type: "input_file", filename: "../secret.txt", file_data: dataUrl("text/plain", "x"),
    }])), "invalid_attachment_filename", 400);
    await expectAttachmentError(prepareCodexInput(requestWith([{
      type: "input_file", filename: "safe.txt", file_id: "file-123",
    }])), "file_id_unsupported", 400);
    await expectAttachmentError(prepareCodexInput(requestWith([{
      type: "image_url", image_url: { url: "https://example.com/image.png" },
    }])), "remote_attachment_url_disabled", 400);
  });

  it("cleans temporary files after success", async () => {
    await useTestRoot();
    const input = await prepareCodexInput(requestWith([{
      type: "image_url", image_url: { url: dataUrl("image/png", PNG) },
    }]));
    const directory = input.attachmentStore.directory!;
    assert.equal(existsSync(directory), true);
    input.attachmentStore.cleanup();
    assert.equal(existsSync(directory), false);
  });

  it("cleans temporary files when a later attachment fails", async () => {
    const root = await useTestRoot();
    await expectAttachmentError(prepareCodexInput(requestWith([
      { type: "image_url", image_url: { url: dataUrl("image/png", PNG) } },
      { type: "image_url", image_url: { url: "https://example.com/blocked.png" } },
    ])), "remote_attachment_url_disabled", 400);
    assert.deepEqual(await readdir(root), []);
  });
});
