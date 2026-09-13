# Contributing

Install dependencies and run the local checks:

```bash
npm install
npm run build
npm test
```

Use `npm run test:e2e` only when Codex CLI is
installed and authenticated. Live tests consume Codex usage.

Keep OpenAI-facing types separate from Codex JSONL types. Use
`child_process.spawn` with an argument array and pass prompts through stdin.
