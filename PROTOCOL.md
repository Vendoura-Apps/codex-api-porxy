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
