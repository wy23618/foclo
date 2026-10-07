import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { registerAuth } from "./auth.js";
import type { ServerConfig } from "./config.js";
import { registerRoutes } from "./routes.js";

export function buildApp(config: ServerConfig, pool: Pool): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "production" ? "info" : "debug",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.body.code",
          "req.body.refreshToken",
          "req.body.accessToken",
          "res.headers.set-cookie",
        ],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: 256 * 1024,
    trustProxy: false,
    requestTimeout: 15_000,
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      const result = await pool.query(
        "SELECT max(version) AS version FROM schema_migrations",
      );
      if (result.rows[0].version < 5)
        throw new Error("Schema upgrade required");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  registerAuth(app, pool, config);
  registerRoutes(app, pool, config);
  return app;
}
