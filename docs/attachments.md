# Universal attachment contract for VTI clients

The proxy accepts images, documents, spreadsheets, presentations, archives,
media, text, and unknown binary files in OpenAI-style content blocks on
`POST /v1/chat/completions`. Attachments are accepted only in `user` messages.
Plain string messages and the previous PNG/JPEG/WebP/UTF-8 request shapes
remain compatible.

## Request format

Every file is transported as a base64 data URL. The client-provided MIME type
is recorded but never trusted for format selection.

```json
{
  "model": "codex",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Analyze these attachments."},
        {
          "type": "image_url",
          "image_url": {"url": "data:image/png;base64,<BASE64_PNG>", "detail": "auto"}
        },
        {
          "type": "input_file",
          "filename": "report.pdf",
          "file_data": "data:application/pdf;base64,<BASE64_PDF>"
        }
      ]
    }
  ]
}
```

| Block | Required fields | Behavior |
| --- | --- | --- |
| `text` | `text` | OpenAI Chat Completions text block |
| `input_text` | `text` | Compatible text alias |
| `image_url` | string `image_url` or `image_url.url` | Native PNG/JPEG/WebP image; declared MIME and signature must agree |
| `input_image` | string/object `image_url`, or `url` | Compatible native-image alias |
| `input_file` | `filename`, `file_data` | Universal file pipeline with content-based detection |

Remote URLs and `file_id` remain disabled. Attachments are request-scoped and
are never persisted as reusable file objects.

## Processing pipeline

```text
AttachmentStore
  -> strict data URL and size validation
  -> content/signature detection
  -> extractor registry
  -> document, archive, media, text, or binary extractor
  -> normalized result
  -> untrusted-data prompt boundary plus native image inputs
```

Each normalized result contains a detected MIME type, kind, extracted text,
native image paths, safe metadata, warnings, truncation state, source size, and
extracted size. Extracted text is explicitly marked as untrusted attachment
data. It is never converted into a system or developer instruction.

## Support matrix

### Native image input

| Format | Detection | Result |
| --- | --- | --- |
| PNG | Magic bytes | Native Codex image |
| JPEG/JPG | Magic bytes | Native Codex image |
| WebP | RIFF/WEBP signature | Native Codex image |

For `image_url` and `input_image`, a declared MIME/signature mismatch is
rejected. Images found in `input_file`, an archive, a rendered PDF, or an
extracted video frame are detected from their bytes and passed as native image
inputs.

### Built-in text and document extraction

| Format | Dependency | Extracted content |
| --- | --- | --- |
| UTF-8 text and source files | Built in | Full bounded text |
| Markdown, JSON, YAML, XML, CSV, TSV, HTML, CSS, SQL, logs | Built in | Full bounded text |
| DOCX | Built-in safe ZIP/XML reader | Paragraphs, tables, headers, footers in document order |
| XLSX | Built-in safe ZIP/XML reader | Sheet names and bounded Markdown tables |
| PPTX | Built-in safe ZIP/XML reader | Ordered slides, titles/text, and speaker notes when present |
| ODT | Built-in safe ZIP/XML reader | Paragraphs and tables |
| ODS | Built-in safe ZIP/XML reader | Sheet names and bounded Markdown tables |
| ODP | Built-in safe ZIP/XML reader | Ordered slide names and text |
| RTF | Built-in bounded parser | Text, paragraph, tab, hex, and Unicode escapes |

Office files are read as data. Macros, embedded scripts, links, and programs
are never executed. The extractors do not invoke Microsoft Office or
LibreOffice.

### PDF

PDF text extraction requires Poppler `pdftotext`. Text is separated with an
explicit page boundary. `pdfinfo` is used when available to obtain the total
page count.

If `CODEX_ATTACHMENT_RENDER_PDF_IMAGES=true`, pages without extractable text
are rendered with `pdftoppm` and sent as bounded native image inputs. Rendering
is off by default. Encrypted/password-protected PDFs return
`attachment_encrypted`.

### Archives

| Format | Dependency | Behavior |
| --- | --- | --- |
| ZIP | Built-in `yauzl` reader | Manifest plus supported entries |
| TAR | Built-in `tar-stream` reader | Manifest plus supported entries |
| TAR.GZ/TGZ | Built-in TAR and gzip reader | Bounded recursive extraction |
| GZ | Built-in gzip reader | Processes one bounded uncompressed payload |

Archive entries are processed in memory unless a detected PDF, media file, or
native image needs a permission-restricted temporary file. Entry paths are
never used as extraction destinations. Absolute names, traversal, backslashes,
symlinks, hardlinks, device entries, encrypted ZIP entries, excessive
compression ratios, excessive output, too many entries, and excessive
recursion are rejected.

### Audio and video

| Format | Metadata | Optional semantic extraction |
| --- | --- | --- |
| MP3, WAV, M4A, OGG | `ffprobe` | Local transcript command when configured |
| MP4, WebM, MOV | `ffprobe` | Local transcript plus bounded frames using `ffmpeg` |

Media bytes are never silently uploaded to an external service.
`CODEX_ATTACHMENT_ENABLE_MEDIA_EXTRACTION` defaults to `false`, which returns
only safe `ffprobe` metadata. When enabled:

- `CODEX_ATTACHMENT_TRANSCRIBE_BIN` may point to a local executable that
  accepts the attachment path as its only argument and emits UTF-8 transcript
  text on stdout.
- Video frames are generated locally by `ffmpeg`, limited by
  `CODEX_ATTACHMENT_MAX_VIDEO_FRAMES`, and passed as native images.
- A configured or required backend that is missing returns
  `attachment_media_backend_unavailable`.

### Unknown binary fallback

An unrecognized binary is accepted as metadata-only input. The proxy provides:

- sanitized filename and source byte length;
- detected MIME (`application/octet-stream` when unknown);
- SHA-256 hash;
- a very small printable-string preview when one is safely available;
- an explicit notice that semantic content was not extracted.

Raw binary bytes are never inserted into the prompt, and the model is told not
to infer contents from the filename or extension.

## Examples

Only the filename, declared data-URL MIME, and payload change:

```json
{"type":"input_file","filename":"contract.docx","file_data":"data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,<BASE64_DOCX>"}
```

```json
{"type":"input_file","filename":"budget.xlsx","file_data":"data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,<BASE64_XLSX>"}
```

```json
{"type":"input_file","filename":"sources.zip","file_data":"data:application/zip;base64,<BASE64_ZIP>"}
```

```json
{"type":"input_file","filename":"meeting.m4a","file_data":"data:audio/mp4;base64,<BASE64_M4A>"}
```

## Optional system dependencies

The proxy starts normally when optional programs are absent. Formats backed by
an absent program return a structured error; built-in text, Office/OpenDocument,
archive, image, RTF, and binary fallback support continue working.

| Program | Used for |
| --- | --- |
| `pdftotext` | Required PDF text extraction |
| `pdfinfo` | Optional accurate PDF page count |
| `pdftoppm` | Optional image rendering for textless PDF pages |
| `ffprobe` | Required audio/video metadata |
| `ffmpeg` | Optional video-frame extraction |
| custom transcript executable | Optional local-only audio/video transcription |

Example installation:

```bash
# Debian/Ubuntu
sudo apt install poppler-utils ffmpeg

# macOS with Homebrew
brew install poppler ffmpeg
```

Binary paths can be overridden with
`CODEX_ATTACHMENT_PDFTOTEXT_BIN`, `CODEX_ATTACHMENT_PDFINFO_BIN`,
`CODEX_ATTACHMENT_PDFTOPPM_BIN`, `CODEX_ATTACHMENT_FFPROBE_BIN`, and
`CODEX_ATTACHMENT_FFMPEG_BIN`.

## Limits and environment

Every numeric value is validated as a positive integer with a hard maximum.
Invalid, non-positive, or excessive values fall back to the safe default.

| Environment variable | Default | Hard maximum | Meaning |
| --- | ---: | ---: | --- |
| `CODEX_ATTACHMENT_MAX_COUNT` | `10` | `100` | Top-level attachments per request |
| `CODEX_ATTACHMENT_MAX_BYTES` | `10485760` | `104857600` | Decoded bytes per top-level attachment/archive entry |
| `CODEX_ATTACHMENT_MAX_TOTAL_BYTES` | `26214400` | `262144000` | Total decoded top-level bytes |
| `CODEX_ATTACHMENT_MAX_EXTRACTED_BYTES` | `2097152` | `20971520` | Text sent to the prompt per extractor |
| `CODEX_ATTACHMENT_EXTRACTION_TIMEOUT_MS` | `15000` | `120000` | Timeout per external converter invocation |
| `CODEX_ATTACHMENT_MAX_PDF_PAGES` | `50` | `500` | PDF pages extracted or rendered |
| `CODEX_ATTACHMENT_MAX_ARCHIVE_ENTRIES` | `100` | `1000` | Entries per ZIP/TAR container |
| `CODEX_ATTACHMENT_MAX_ARCHIVE_DEPTH` | `2` | `5` | Nested archive recursion depth |
| `CODEX_ATTACHMENT_MAX_ARCHIVE_EXPANDED_BYTES` | `26214400` | `262144000` | Expanded bytes per archive container |
| `CODEX_ATTACHMENT_MAX_SPREADSHEET_ROWS` | `200` | `10000` | Rows per sheet |
| `CODEX_ATTACHMENT_MAX_SPREADSHEET_COLUMNS` | `50` | `500` | Columns per row |
| `CODEX_ATTACHMENT_MAX_SPREADSHEET_CELL_BYTES` | `4096` | `65536` | UTF-8 bytes per cell |
| `CODEX_ATTACHMENT_MAX_VIDEO_FRAMES` | `4` | `20` | Locally extracted frames per video |
| `CODEX_ATTACHMENT_ENABLE_MEDIA_EXTRACTION` | `false` | boolean | Enable local transcript/frame processing |
| `CODEX_ATTACHMENT_RENDER_PDF_IMAGES` | `false` | boolean | Render textless PDF pages locally |
| `CODEX_HTTP_BODY_MAX_BYTES` | `41943040` | `524288000` | Complete encoded JSON request body |

Base64 increases encoded size by roughly one third, so the HTTP limit must be
larger than the decoded attachment limits.

## Security and lifecycle

- MIME and filename extensions never override detected signatures/content.
- Temporary directories use mode `0700`; materialized files use `0600`.
- Converter commands are invoked without a shell and with an argument array.
- Converter timeout or request abort terminates the isolated process group.
- No attachment, macro, embedded script, archive entry, or printable preview is
  executed.
- Base64, full extracted text, and secret attachment content are not logged or
  copied into errors.
- Temporary data is removed after success, error, timeout, client disconnect,
  agent completion, expired tool call, cancellation, or proxy shutdown.
- The proxy Codex sandbox remains `read-only`.

## Stable error codes

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 400 | `invalid_attachment_data_url` | Missing/malformed base64 data URL or MIME |
| 400 | `remote_attachment_url_disabled` | Remote URL was supplied |
| 400 | `invalid_attachment_base64` | Base64 payload is malformed |
| 400 | `unsupported_attachment_mime` | Unsupported native `image_url` MIME |
| 400 | `unsupported_attachment_format` | Known format has no accepted processing path |
| 400 | `invalid_image_signature` | Native image MIME and magic bytes disagree |
| 400 | `invalid_attachment_filename` | Filename is missing or unsafe |
| 400 | `file_id_unsupported` | Client supplied `file_id` |
| 400 | `attachment_archive_unsafe` | Traversal, link, special entry, or unsafe depth |
| 408 | `attachment_extraction_timeout` | External extractor exceeded its timeout |
| 413 | `attachment_too_large` | One decoded attachment exceeds its limit |
| 413 | `attachments_total_too_large` | Request decoded bytes exceed their total limit |
| 413 | `too_many_attachments` | Too many top-level attachments |
| 413 | `attachment_extracted_too_large` | Archive/converter expanded output exceeds its limit |
| 413 | `attachment_too_many_entries` | Archive contains too many entries |
| 413 | `request_body_too_large` | Complete encoded JSON body exceeds its limit |
| 422 | `attachment_extractor_unavailable` | Required PDF/general converter is absent |
| 422 | `attachment_media_backend_unavailable` | Required/configured media backend is absent |
| 422 | `attachment_extraction_failed` | A detected format could not be parsed safely |
| 422 | `attachment_encrypted` | Password/encryption prevents extraction |
| 499 | `attachment_extraction_aborted` | Client disconnected or cancelled during extraction |

## Known limits

- Scanned PDF pages need optional rendering; OCR is not bundled.
- DOCX/PPTX relationship layouts and advanced drawing objects are represented
  best-effort. Embedded files are not executed.
- Spreadsheet formulas are reported as stored values; formulas are not
  recalculated.
- RTF extraction is intentionally bounded and does not reproduce visual layout.
- Media transcription only exists when the administrator explicitly configures
  a local transcript executable.
- Unknown binaries provide metadata and a bounded preview, not semantic
  understanding.

Streaming/non-streaming requests, sessions, Agent Bridge tool calls, Ponytail,
reasoning effort, model aliases, and authentication all use the same attachment
pipeline.
