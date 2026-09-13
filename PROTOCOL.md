# Codex CLI protocol

The proxy starts a new turn with:

```bash
codex exec --json --sandbox read-only -
```

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
