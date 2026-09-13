/** Codex CLI provider and standalone server exports. */

import { getServer, startServer, stopServer } from "./server/index.js";
import { verifyAuth, verifyCodex } from "./subprocess/manager.js";

const PROVIDER_ID = "codex-cli";
const DEFAULT_PORT = 3456;
const DEFAULT_MODEL = "codex-cli/codex";

const codexCliPlugin = {
  id: "codex-cli-provider",
  name: "Codex CLI Provider",
  description: "Expose an authenticated local Codex CLI through an OpenAI-compatible endpoint",
  configSchema: { type: "object" as const, properties: {}, additionalProperties: false },

  register(api: any) {
    let serverPort = DEFAULT_PORT;
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Codex CLI",
      docsPath: "/providers/codex-cli",
      aliases: ["codex"],
      envVars: ["CODEX_BIN", "CODEX_WORKING_DIR", "CODEX_SANDBOX"],
      auth: [{
        id: "local",
        label: "Local Codex CLI",
        hint: "Uses the authentication already configured in Codex CLI",
        kind: "custom",
        run: async (ctx: any) => {
          const spin = ctx.prompter.progress("Checking Codex CLI...");
          try {
            const cli = await verifyCodex();
            if (!cli.ok) throw new Error(cli.error);
            const auth = await verifyAuth();
            if (!auth.ok) throw new Error(auth.error);

            const portInput = await ctx.prompter.text({
              message: "Local server port",
              initialValue: String(DEFAULT_PORT),
              validate: (value: string) => {
                const port = Number.parseInt(value, 10);
                return Number.isInteger(port) && port >= 1 && port <= 65535
                  ? undefined
                  : "Enter a valid port (1-65535)";
              },
            });
            serverPort = Number.parseInt(portInput, 10);
            await startServer({ port: serverPort });
            spin.stop("Codex CLI provider ready");
            return {
              profiles: [{
                profileId: `${PROVIDER_ID}:local`,
                credential: { type: "token", provider: PROVIDER_ID, token: "local" },
              }],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl: `http://127.0.0.1:${serverPort}/v1`,
                      apiKey: "local",
                      api: "openai-completions",
                      authHeader: false,
                      models: [{
                        id: "codex",
                        name: "Codex CLI default",
                        api: "openai-completions",
                        reasoning: true,
                        input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 200000,
                        maxTokens: 8192,
                      }],
                    },
                  },
                },
              },
              defaultModel: DEFAULT_MODEL,
              notes: [`Local Codex proxy running at http://127.0.0.1:${serverPort}`],
            };
          } catch (error) {
            spin.stop("Setup failed");
            throw error;
          }
        },
      }],
    });

    api.on("plugin:unload", async () => {
      if (getServer()) await stopServer();
    });
    api.registerCli?.((cli: any) => {
      cli.command("codex-cli:start [port]").action(async (port: string) => {
        serverPort = Number.parseInt(port || String(DEFAULT_PORT), 10);
        await startServer({ port: serverPort });
      });
      cli.command("codex-cli:stop").action(stopServer);
      cli.command("codex-cli:status").action(() => {
        console.log(getServer() ? `Server is running on port ${serverPort}` : "Server is not running");
      });
    });
  },
};

export default codexCliPlugin;
export { getServer, startServer, stopServer } from "./server/index.js";
export { CodexSubprocess, verifyAuth, verifyCodex } from "./subprocess/manager.js";
