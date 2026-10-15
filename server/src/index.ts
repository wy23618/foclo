import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";

const config = loadConfig();
const pool = createPool(config);
const app = buildApp(config, pool);
const apps = [app];
// Local hotspot tests keep both the phone's LAN endpoint and DevTools loopback.
// Never enable the additional listener on a production server.
if (config.nodeEnv === "development" && process.env.LOCAL_DEV_LOOPBACK === "true" && config.host !== "127.0.0.1") {
  apps.push(buildApp(config, pool));
}

try {
  await app.listen({ host: config.host, port: config.port });
  const loopbackApp = apps[1];
  if (loopbackApp) await loopbackApp.listen({ host: "127.0.0.1", port: config.port });
} catch (error) {
  app.log.error({ err: error }, "Server startup failed");
  await Promise.all(apps.map(instance => instance.close()));
  await pool.end();
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void Promise.all(apps.map(instance => instance.close())).finally(() => pool.end());
  });
}
