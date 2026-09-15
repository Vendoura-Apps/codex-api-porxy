/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints backed by Codex CLI
 */

import express, { Express, Request, Response, NextFunction } from "express";
import { createServer, Server } from "http";
import { timingSafeEqual } from "crypto";
import { handleChatCompletions, handleModels, handleHealth } from "./routes.js";
import { requestBodyMaxBytes } from "../attachments/attachment-store.js";

export interface ServerConfig {
  port: number;
  host?: string;
}

let serverInstance: Server | null = null;

/**
 * Create and configure the Express app
 */
export function isValidBearerToken(authorization: string | undefined, expected: string): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

export function createApp(): Express {
  const app = express();

  // Middleware: use raw body parser + manual JSON parse for better error diagnostics
  app.use(express.raw({ type: "application/json", limit: requestBodyMaxBytes() }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
      const raw = req.body.toString("utf8");
      try {
        req.body = JSON.parse(raw);
      } catch {
        console.error("[Body parse error]: invalid JSON");
        console.error("[Body metadata]:", {
          length: raw.length,
          method: req.method,
          url: req.originalUrl,
        });
        const parseError = new Error("Request body contains invalid JSON") as Error & {
          status?: number;
          code?: string;
        };
        parseError.status = 400;
        parseError.code = "invalid_json";
        return next(parseError);
      }
    }
    next();
  });

  // Request logging (debug mode)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });

  // CORS headers for local development
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
  });

  // Handle OPTIONS preflight
  app.options("*", (_req: Request, res: Response) => {
    res.sendStatus(200);
  });

  // Require a bearer token for API routes when CODEX_PROXY_API_KEY is configured.
  app.use("/v1", (req: Request, res: Response, next: NextFunction) => {
    const apiKey = process.env.CODEX_PROXY_API_KEY;
    if (!apiKey || isValidBearerToken(req.get("authorization"), apiKey)) {
      next();
      return;
    }
    res.status(401).json({
      error: {
        message: "Invalid or missing API key",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    });
  });

  // Routes
  app.get("/health", handleHealth);
  app.get("/v1/models", handleModels);
  app.post("/v1/chat/completions", handleChatCompletions);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: "Not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  // Error handler
  app.use((err: Error & { status?: number; type?: string; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const bodyTooLarge = err.type === "entity.too.large" || err.status === 413;
    const status = bodyTooLarge ? 413 : err.status === 400 ? 400 : 500;
    const code = bodyTooLarge ? "request_body_too_large" : err.code || null;
    console.error("[Server Error]:", bodyTooLarge ? "Request body exceeds configured limit" : err.message);
    res.status(status).json({
      error: {
        message: bodyTooLarge ? "Request body exceeds the configured size limit" : err.message,
        type: status < 500 ? "invalid_request_error" : "server_error",
        code,
      },
    });
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startServer(config: ServerConfig): Promise<Server> {
  const { port, host = "127.0.0.1" } = config;

  if (serverInstance) {
    console.log("[Server] Already running, returning existing instance");
    return serverInstance;
  }

  const app = createApp();

  return new Promise((resolve, reject) => {
    serverInstance = createServer(app);

    serverInstance.on("error", (err: NodeJS.ErrnoException) => {
      serverInstance = null;
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    serverInstance.listen(port, host, () => {
      const address = serverInstance!.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      console.log(`[Server] Codex CLI provider running at http://${host}:${actualPort}`);
      console.log(`[Server] OpenAI-compatible endpoint: http://${host}:${actualPort}/v1/chat/completions`);
      resolve(serverInstance!);
    });
  });
}

/**
 * Stop the HTTP server
 */
export async function stopServer(): Promise<void> {
  if (!serverInstance) {
    return;
  }

  return new Promise((resolve, reject) => {
    serverInstance!.close((err) => {
      if (err) {
        reject(err);
      } else {
        console.log("[Server] Stopped");
        serverInstance = null;
        resolve();
      }
    });
  });
}

/**
 * Get the current server instance
 */
export function getServer(): Server | null {
  return serverInstance;
}
