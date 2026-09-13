# Repository guidance

This project exposes Codex CLI as an OpenAI-compatible local HTTP API.

- Build with `npm run build`.
- Run offline tests with `npm test`.
- Live tests use `npm run test:e2e` and consume Codex usage.
- Keep the default Codex sandbox at `read-only`.
- Pass prompts through stdin and subprocess arguments as an array.
