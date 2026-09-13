# Design decisions

## Codex CLI backend

The proxy uses the supported non-interactive `codex exec` interface. JSONL
output includes a durable thread identifier, response items, and usage totals.

## Model selection

`model: "codex"` leaves model selection to the user's Codex configuration.
Any other model string is forwarded to `--model`, avoiding a short-lived
hard-coded model catalog.

## Session isolation

Resume is enabled only when the caller provides a stable `user` value.
Requests without it create independent threads.

## Permissions

Read-only is the default sandbox. File changes require
`CODEX_SANDBOX=workspace-write`. Full access is never selected automatically.

## Streaming

`codex exec --json` reports agent-message items rather than OpenAI token
deltas. The proxy sends each completed agent message as an SSE content chunk,
then a usage-bearing final chunk and `[DONE]`.
