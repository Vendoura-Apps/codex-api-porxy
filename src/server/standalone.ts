#!/usr/bin/env node

import { startServer, stopServer } from "./index.js";
import { verifyAuth, verifyCodex } from "../subprocess/manager.js";
import { shutdownAgentBridges } from "../subprocess/agent-bridge.js";

const DEFAULT_PORT = 3456;

async function main(): Promise<void> {
  const port = Number.parseInt(process.argv[2] || String(DEFAULT_PORT), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${process.argv[2]}`);
    process.exit(1);
  }

  const cli = await verifyCodex();
  if (!cli.ok) {
    console.error(cli.error);
    process.exit(1);
  }
  const auth = await verifyAuth();
  if (!auth.ok) {
    console.error(auth.error);
    process.exit(1);
  }

  console.log(`Codex CLI: ${cli.version || "OK"}`);
  await startServer({ port });
  console.log(`Try POST http://127.0.0.1:${port}/v1/chat/completions with model "codex".`);

  const shutdown = async () => {
    shutdownAgentBridges();
    await stopServer();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
