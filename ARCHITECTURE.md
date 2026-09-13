# Architecture

```text
OpenAI client
    |
    | POST /v1/chat/completions
    v
Express routes -> prompt adapter -> CodexSubprocess
    |
    | codex exec --json -
    | codex exec resume <thread_id> --json -
    v
Codex JSONL -> response adapter -> OpenAI JSON or SSE
```

The route layer validates requests and controls HTTP streaming. The input
adapter flattens OpenAI messages into a task prompt. The subprocess manager
owns process lifetime, timeouts, JSONL parsing, and process-tree termination.

When a request supplies `user`, the in-memory session store associates that
key with the Codex `thread_id`. Subsequent turns send messages appended since
the previous request and resume the corresponding thread.

Codex runs in `read-only` sandbox mode by default. Operators can select a
different mode through `CODEX_SANDBOX`.
