# Codex CLI protocol

The proxy starts a new turn with:

```bash
codex exec --json --sandbox read-only -
```

When a request contains `"reasoning_effort":"high"`, the proxy adds a
per-turn Codex configuration override:

```bash
codex exec --json --config 'model_reasoning_effort="high"' --sandbox read-only -
```

Accepted canonical values are `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, and `max`. The API also maps `light` to `low`, and `extra-high`,
`extra_high`, or `extra high` to `xhigh`. Unsupported values receive HTTP 400.
The selected Codex model determines which canonical values it supports.

## Optional Ponytail profile

The request extension `ponytail` accepts `off`, `lite`, `full`, `ultra`, or a
boolean (`true` maps to `full`). The per-request value takes precedence over a
model suffix such as `codex@ponytail-full`, which takes precedence over
`CODEX_PONYTAIL_DEFAULT`. The fallback is `off`.

For `codex exec`, the proxy prepends a bounded developer-instruction section
to the generated stdin prompt. For App Server agent-bridge turns, the same
profile is added to `developerInstructions`; it is not duplicated in the user
input. Model suffixes are removed before the model is passed to Codex.

It sends the generated prompt through stdin. A continued turn uses:

```bash
codex exec --sandbox read-only resume --json <THREAD_ID> -
```

Codex writes one JSON object per stdout line. The proxy consumes:

- `thread.started.thread_id` for session persistence
- `item.completed` with an `agent_message` item for response text
- `turn.completed.usage` for token counts and successful completion
- `turn.failed` and `error` for failures

Other event types are ignored by the HTTP adapter. Diagnostics from stderr are
returned when the process exits without a completed turn.

## Agent bridge protocol

When a Chat Completions request contains OpenAI function `tools`, the proxy
starts an ephemeral `codex app-server` process and enables its experimental
API. The thread uses the requested model, `read-only` sandboxing, and a safe
server-side working directory. OpenAI function definitions are passed as App
Server `dynamicTools`.

When Codex sends an `item/tool/call` server request, the proxy returns it to the
HTTP client as an assistant `tool_calls` response with
`finish_reason: "tool_calls"`. The App Server process stays alive. The client
executes the tool locally, applies its own folder restrictions and approval
flow, then sends a `role: "tool"` message with the matching `tool_call_id`.
The proxy forwards the result to App Server and waits for the next tool call or
the final agent message.

Built-in App Server command and file-change approval requests are declined.
This prevents agent bridge turns from operating on the proxy repository. A
pending bridge turn expires after 15 minutes and is also discarded when the
service restarts. If Codex requests several tools together, the client must
return all of those tool outputs in the same follow-up HTTP request.

## Attachments

The proxy decodes validated base64 data URLs into request-scoped storage,
detects content independently from the declared MIME, and dispatches to a
bounded extractor registry. Native images and generated PDF/video images are
passed to `codex exec` as repeated `--image` arguments. App Server uses the
generated protocol's native `localImage` input:

```json
{ "type": "localImage", "path": "/tmp/.../image-1.png", "detail": "auto" }
```

Extracted text and safe metadata are inserted at the corresponding content
block position inside an explicit `trust="untrusted-data"` attachment boundary.
Built-in extractors cover UTF-8 text, OOXML/OpenDocument, RTF, ZIP, TAR, and
Gzip. PDF and media invoke feature-detected local binaries without a shell.
Unknown binary files produce SHA-256 metadata and a bounded printable preview.

The attachment store belongs to the request or active agent turn and is cleaned
on success, error, abort, timeout, disconnect, expired tool call, and shutdown.
See [`docs/attachments.md`](docs/attachments.md) for exact limits, error codes,
dependency requirements, and format classifications.
