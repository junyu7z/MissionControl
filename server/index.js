import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { buildApp } from './app.js';

const config = loadConfig();
const logger = { level: process.env.LOG_LEVEL || 'info' };

const db = await createDb(config, { info: (m) => console.log(m), error: (o, m) => console.error(m, o) });
const app = await buildApp({ config, db, logger });

if (db.kind === 'pglite') {
  app.log.warn(
    config.pgliteDir
      ? `Using embedded development database at ${config.pgliteDir}`
      : 'Using an in-memory development database — data is lost on restart. Set PGLITE_DIR to keep it.',
  );
}
if (config.devLogin) app.log.warn('DEV_LOGIN is on: anyone can sign in as anyone. Never enable this in production.');

await app.listen({ port: config.port, host: config.host });

// ECS sends SIGTERM before stopping a task; finish in-flight requests first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    try {
      await app.close();
      await db.close();
    } finally {
      process.exit(0);
    }
  });
}
