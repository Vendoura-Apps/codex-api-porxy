# Codex CLI API Proxy

Expose an authenticated local Codex CLI through an OpenAI-compatible HTTP API.
Plain chat requests run through `codex exec`. Requests containing OpenAI
function tools use Codex App Server as an agent bridge, so a compatible client
can execute file and terminal tools on its own device and return the results to
Codex.

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
  -d '{"model":"codex","reasoning_effort":"high","messages":[{"role":"user","content":"Hello"}]}'
```

For SSE, add `"stream":true` to the JSON body and use `curl -N`.

Images and UTF-8 text files can be sent as base64 data URLs in content blocks:

```bash
curl http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"codex",
    "messages":[{"role":"user","content":[
      {"type":"text","text":"Describe this image"},
      {"type":"image_url","image_url":{"url":"data:image/png;base64,<BASE64_PNG>"}}
    ]}]
  }'
```

See [Attachment contract for VTI clients](docs/attachments.md) for file blocks,
supported MIME types, limits, lifecycle, and structured errors.

The `codex` model alias uses the model selected by Codex CLI configuration.
You may also pass an explicit model ID; the proxy forwards it through
`codex exec --model`. `GET /v1/models` advertises the explicit model choices
configured for the server so clients can populate their model picker. Each
entry also includes `resolved_model`, `context_window`, `max_output_tokens`,
and `auto_compact_threshold` when known. The `codex` aliases resolve against
the model in the server's Codex config.

Set `reasoning_effort` per request to `none`, `minimal`, `low`, `medium`,
`high`, `xhigh`, or `max`. The aliases `light` and `extra-high` map to `low`
and `xhigh`. Availability depends on the selected model; omitting the field
uses the Codex CLI configuration. `ultra` is not a reasoning-effort value.

Enable the optional Ponytail-inspired coding profile per request with
`"ponytail":"lite"`, `"full"`, or `"ultra"`; use `"off"` to disable it.
Clients that cannot add custom body fields can select
`codex@ponytail-off`, `codex@ponytail-lite`, `codex@ponytail-full`, or
`codex@ponytail-ultra` as the model ID. The proxy strips the suffix before
selecting the underlying Codex model. See
[Optional Ponytail mode](docs/ponytail.md) for client examples and precedence
rules.

## Conversation sessions

Set a stable OpenAI `user` value to retain conversation context. The first
turn stores the `thread_id` emitted by Codex. Later requests with the same
`user` use `codex exec resume <thread_id>`. Mappings are held in memory for
six hours and reset when the server restarts.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `CODEX_BIN` | `codex` | Codex executable path |
| `CODEX_DEFAULT_MODEL` | model from Codex `config.toml` | Override the resolved model metadata advertised for the `codex` alias |
| `CODEX_WORKING_DIR` | server working directory | Repository Codex operates in |
| `CODEX_SANDBOX` | `read-only` | `read-only`, `workspace-write`, or `danger-full-access` |
| `CODEX_AGENT_BRIDGE_CWD` | isolated directory under the OS temp folder | Safe server-side directory used by agent bridge sessions |
| `CODEX_AGENT_BRIDGE_MAX_ACTIVE` | `16` | Maximum number of agent turns waiting for client tool results |
| `CODEX_PONYTAIL_DEFAULT` | `off` | Default optional coding profile: `off`, `lite`, `full`, or `ultra` |
| `CODEX_ATTACHMENT_MAX_COUNT` | `10` | Maximum attachments per request |
| `CODEX_ATTACHMENT_MAX_BYTES` | `10485760` | Maximum decoded bytes per attachment |
| `CODEX_ATTACHMENT_MAX_TOTAL_BYTES` | `26214400` | Maximum decoded attachment bytes per request |
| `CODEX_HTTP_BODY_MAX_BYTES` | `41943040` | Maximum encoded JSON request body |
| `CODEX_PROXY_API_KEY` | unset | Require this value as a Bearer token on all `/v1` routes |
| `DEBUG` | unset | Log HTTP request metadata |
| `DEBUG_SUBPROCESS` | unset | Log Codex stderr |

The server binds to loopback by default. API-key authentication is disabled
until `CODEX_PROXY_API_KEY` is configured, so do not expose the default setup to an
untrusted network.

When `CODEX_PROXY_API_KEY` is set, requests to `/v1/*` must include
`Authorization: Bearer <key>`. The `/health` endpoint remains unauthenticated.

## Private access with Tailscale

Keep the proxy bound to `127.0.0.1` and publish it privately with Tailscale
Serve:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3456
```

Other devices in the same tailnet can then use:

```text
https://<device-name>.<tailnet-name>.ts.net:8443/v1/chat/completions
```

For the team endpoint, client setup, model choices, VS Code configuration, and
troubleshooting, see [Panduan Endpoint Codex melalui Tailscale](docs/panduan-endpoint-codex-tailscale.md).
For a shorter guide that can be sent directly to client-device users, see
[Panduan Client Codex Agent](docs/panduan-client-agent.md).

Configure the client API key with the same value as `CODEX_PROXY_API_KEY`. Use
`tailscale serve status` to inspect the mapping and
`tailscale serve --https=8443 off` to disable it.

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

- Text messages, base64 PNG/JPEG/WebP images, and allowlisted UTF-8 text files
  are supported. Remote attachment URLs and `file_id` are rejected.
- Images use native Codex image input. Text files are decoded into bounded,
  clearly labeled prompt sections. PDF is not currently supported.
- SSE text is delivered when a Codex agent-message item completes, rather than
  token by token.
- OpenAI function `tools`, assistant `tool_calls`, and `tool` result messages are
  supported through the agent bridge. Tool execution and user approval belong
  to the client device.
- The agent bridge keeps pending calls in memory for up to 15 minutes. A proxy
  restart invalidates pending `tool_call_id` values.
- Codex App Server dynamic tools are currently an experimental Codex API.
- Sampling fields such as `temperature` and `top_p` are not forwarded.
- `reasoning_effort` is forwarded to Codex CLI as `model_reasoning_effort`.
- `ponytail` is a proxy instruction profile and is independent from reasoning effort.

## License

MIT

The optional Ponytail-compatible profile is inspired by
[Ponytail](https://github.com/dietrichgebert/ponytail), licensed under MIT.
