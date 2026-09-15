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

The proxy decodes validated base64 data URLs into a unique temporary directory.
For `codex exec`, image paths are passed as repeated `--image` arguments. For
App Server, the generated protocol's native `localImage` input is used:

```json
{ "type": "localImage", "path": "/tmp/.../image-1.png", "detail": "auto" }
```

Allowlisted UTF-8 files have no native App Server general-file input, so their
decoded text is inserted at the corresponding content-block position in the
prompt. PDF is rejected. The attachment store belongs to the request or active
agent turn and is cleaned on every terminal lifecycle path. See
[`docs/attachments.md`](docs/attachments.md) for the client contract.
