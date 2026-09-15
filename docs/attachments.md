# Attachment contract for VTI clients

The proxy accepts images and UTF-8 text files in OpenAI-style content blocks
on `POST /v1/chat/completions`. Attachments are accepted only in `user`
messages. Plain string content remains supported.

## Request format

```json
{
  "model": "codex",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Analyze the image and requirements file in order."
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,<BASE64_PNG>",
            "detail": "auto"
          }
        },
        {
          "type": "input_file",
          "filename": "requirements.md",
          "file_data": "data:text/markdown;base64,<BASE64_MARKDOWN>"
        }
      ]
    }
  ]
}
```

Supported block shapes:

| Block | Required fields | Notes |
| --- | --- | --- |
| `text` | `text` | OpenAI Chat Completions text block |
| `input_text` | `text` | Compatible text alias |
| `image_url` | `image_url.url` or string `image_url` | Base64 data URL only |
| `input_image` | string/object `image_url`, or `url` | Compatible image alias |
| `input_file` | `filename`, `file_data` | UTF-8 text file as a base64 data URL |

Image `detail` may be `auto`, `low`, `high`, or `original`. The proxy passes it
to Codex App Server when Agent mode is active. `file_id` is not supported and
attachments are never persisted as reusable objects.

## Supported MIME types

Images are passed natively to Codex:

- `image/png`
- `image/jpeg`
- `image/webp`

The proxy validates the declared image MIME type and its magic bytes.

UTF-8 text files are decoded and inserted at their content-block position in
the prompt with a filename, MIME type, byte length, and explicit attachment
boundary. Allowed MIME types are:

- `text/plain`, `text/markdown`, `text/csv`, `text/tab-separated-values`
- `text/html`, `text/css`, `text/xml`, `text/yaml`
- `text/javascript`, `text/typescript`, `text/x-python`
- `text/x-c`, `text/x-c++src`, `text/x-java-source`, `text/x-rust`, `text/x-go`
- `text/x-shellscript`, `text/x-ruby`, `text/x-php`, `text/x-sql`
- `application/json`, `application/ld+json`, `application/xml`
- `application/yaml`, `application/x-yaml`
- `application/javascript`, `application/typescript`, `application/sql`

PDF is currently rejected with `pdf_attachment_unsupported`. The installed
Codex protocol has native local-image input but no native PDF or general-file
input, and this project does not include a safe PDF text extractor.

## Transport and security rules

- Send attachment bytes as a `data:<mime>;base64,...` URL.
- `http://` and `https://` attachment URLs are disabled to prevent SSRF.
- Filenames must be simple basenames. Absolute paths, `../`, `/`, `\\`, null
  bytes, drive prefixes, and empty filenames are rejected.
- The proxy sanitizes accepted filenames and stores each attachment in a
  request-specific temporary directory with directory mode `0700` and file
  mode `0600`.
- Attachment contents are never executed and are never written into the proxy
  repository or client workspace.
- Base64 bodies and complete attachment contents are not written to proxy logs
  or error messages.

## Size limits

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| `CODEX_ATTACHMENT_MAX_COUNT` | `10` | Attachments per request |
| `CODEX_ATTACHMENT_MAX_BYTES` | `10485760` | Decoded bytes per attachment (10 MiB) |
| `CODEX_ATTACHMENT_MAX_TOTAL_BYTES` | `26214400` | Total decoded bytes per request (25 MiB) |
| `CODEX_HTTP_BODY_MAX_BYTES` | `41943040` | Complete JSON request body (40 MiB) |

Base64 increases encoded size by roughly one third. JSON syntax adds more
bytes, so the HTTP body limit must be larger than the decoded attachment limit.
Invalid or non-positive environment values fall back to the defaults.

## Error responses

Errors use the standard proxy envelope:

```json
{
  "error": {
    "message": "Remote attachment URLs are disabled; send a base64 data URL",
    "type": "invalid_request_error",
    "code": "remote_attachment_url_disabled"
  }
}
```

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 400 | `invalid_attachment_data_url` | Missing or malformed base64 data URL |
| 400 | `remote_attachment_url_disabled` | Remote URL was supplied |
| 400 | `invalid_attachment_base64` | Base64 payload is malformed |
| 400 | `unsupported_attachment_mime` | MIME type is outside the allowlist |
| 400 | `pdf_attachment_unsupported` | PDF is not supported |
| 400 | `invalid_image_signature` | Magic bytes do not match the image MIME |
| 400 | `invalid_attachment_utf8` | Text file is not valid UTF-8 |
| 400 | `invalid_attachment_filename` | Filename is missing or unsafe |
| 400 | `file_id_unsupported` | Client supplied `file_id` |
| 413 | `attachment_too_large` | One decoded attachment exceeds its limit |
| 413 | `attachments_total_too_large` | Total decoded bytes exceed the request limit |
| 413 | `too_many_attachments` | Attachment count exceeds the limit |
| 413 | `request_body_too_large` | Encoded JSON body exceeds its limit |

## Processing behavior

For plain completion requests, images are written temporarily and passed to
`codex exec --image`. For Agent mode requests with function tools, images are
sent as native App Server `{ "type": "localImage", "path": "..." }` inputs.
Multiple images and mixed text/file/image content preserve their content-block
order.

Temporary files remain available while an Agent turn is waiting for client
tool results. They are removed after success, error, timeout, client
disconnect, cancellation, or graceful proxy shutdown. A tool continuation
should send the prior messages and matching `tool_call_id`; repeated attachment
blocks in that history are not decoded a second time.

Both `stream: false` and `stream: true` use the same attachment validation and
Codex input. SSE output remains standard Chat Completions chunks ending with
`data: [DONE]`.
