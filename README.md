# Codex CLI API Proxy

Expose an authenticated local Codex CLI through an OpenAI-compatible HTTP API.
The proxy accepts Chat Completions requests, runs `codex exec --json`,
translates Codex JSONL events into OpenAI responses, and can resume Codex
threads.

## Requirements

- Node.js 20 or newer
- Codex CLI installed and available as `codex`
- An authenticated Codex CLI session (`codex login status`)

Install Codex on macOS or Linux:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
```

Choose a sign-in method on the first run.

## Install and run

```bash
npm install
npm run build
npm start
```

The server listens on `127.0.0.1:3456`. To choose another port:

```bash
node dist/server/standalone.js 8080
```

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/health` | Server health |
| GET | `/v1/models` | Available proxy model aliases |
| POST | `/v1/chat/completions` | Streaming or non-streaming completion |

```bash
curl http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"codex","messages":[{"role":"user","content":"Hello"}]}'
```

For SSE, add `"stream":true` to the JSON body and use `curl -N`.

The `codex` model alias uses the model selected by Codex CLI configuration.
You may also pass an explicit model ID; the proxy forwards it through
`codex exec --model`.

## Conversation sessions

Set a stable OpenAI `user` value to retain conversation context. The first
turn stores the `thread_id` emitted by Codex. Later requests with the same
`user` use `codex exec resume <thread_id>`. Mappings are held in memory for
six hours and reset when the server restarts.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `CODEX_BIN` | `codex` | Codex executable path |
| `CODEX_WORKING_DIR` | server working directory | Repository Codex operates in |
| `CODEX_SANDBOX` | `read-only` | `read-only`, `workspace-write`, or `danger-full-access` |
| `DEBUG` | unset | Log HTTP request metadata |
| `DEBUG_SUBPROCESS` | unset | Log Codex stderr |

The server binds to loopback by default. It has no API-key authentication, so
do not expose it to an untrusted network.

## Tests

```bash
npm run build
npm test
```

Live completion tests are opt-in because they consume Codex usage:

```bash
npm run test:e2e
```

## Compatibility notes

- Text messages and text content blocks are supported.
- SSE text is delivered when a Codex agent-message item completes, rather than
  token by token.
- Codex handles its tools internally. Tool calls are not forwarded to clients.
- Sampling fields such as `temperature` and `top_p` are not forwarded.

## License

MIT
