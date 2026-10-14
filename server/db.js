// Database access. Production uses real Postgres (Amazon RDS) through `pg`;
// local development and tests use PGlite, an embedded Postgres build, so no
// database server needs to be installed. Both expose the same small surface:
//
//   db.query(sql, params)      -> { rows }
//   db.tx(async (q) => {...})  -> runs fn inside BEGIN/COMMIT; q has .query/.exec
//   db.listen(channel, cb)     -> LISTEN/NOTIFY subscription
//   db.close()

import { mkdir, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OID_INT8 = 20;
const OID_DATE = 1082;
// Keep calendar dates as 'YYYY-MM-DD' strings. Converting them to JS Dates would
// shift them by the server's timezone; a time-off day must be the same day for
// everyone regardless of where they are.
const parsers = {
  [OID_DATE]: (v) => v,
  [OID_INT8]: (v) => Number(v),
};

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const MIGRATION_LOCK_ID = 727001;

export async function createDb(config, log = console) {
  const db = config.databaseUrl || config.usePgEnv ? await createPgDb(config, log) : await createPgliteDb(config);
  await migrate(db, log);
  return db;
}

async function createPgDb(config, log) {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(OID_DATE, parsers[OID_DATE]);
  pg.types.setTypeParser(OID_INT8, parsers[OID_INT8]);

  let ssl;
  if (config.dbSsl === 'rds') {
    // Amazon RDS enforces TLS; verify the server against the RDS CA bundle
    // that the Docker image downloads to /app/certs.
    const ca = await readFile(process.env.RDS_CA_FILE || '/app/certs/rds-global-bundle.pem', 'utf8');
    ssl = { ca, rejectUnauthorized: true };
  } else if (config.dbSsl === 'require') {
    ssl = { rejectUnauthorized: false };
  }

  const pool = new pg.Pool({
    connectionString: config.databaseUrl || undefined,
    ssl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => log.error({ err }, 'idle postgres client error'));

  const wrap = (client) => ({
    query: (sql, params) => client.query(sql, params),
    exec: (sql) => client.query(sql),
  });

  const listeners = [];
  let listenClient = null;
  let closed = false;

  async function connectListener() {
    if (closed || listeners.length === 0) return;
    try {
      const client = new pg.Client({ connectionString: config.databaseUrl || undefined, ssl });
      client.on('notification', (msg) => {
        for (const l of listeners) if (l.channel === msg.channel) l.cb(msg.payload);
      });
      client.on('error', (err) => {
        log.error({ err }, 'postgres LISTEN connection lost; reconnecting');
        listenClient = null;
        client.end().catch(() => {});
        setTimeout(connectListener, 2000);
      });
      await client.connect();
      for (const ch of new Set(listeners.map((l) => l.channel))) await client.query(`LISTEN ${ch}`);
      listenClient = client;
      for (const l of listeners) l.onReconnect?.();
    } catch (err) {
      log.error({ err }, 'could not open postgres LISTEN connection; retrying');
      setTimeout(connectListener, 2000);
    }
  }

  return {
    kind: 'postgres',
    query: (sql, params) => pool.query(sql, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async listen(channel, cb, onReconnect) {
      if (!/^[a-z_]+$/.test(channel)) throw new Error('bad channel name');
      listeners.push({ channel, cb, onReconnect });
      if (listenClient) await listenClient.query(`LISTEN ${channel}`);
      else await connectListener();
    },
    async close() {
      closed = true;
      if (listenClient) await listenClient.end().catch(() => {});
      await pool.end();
    },
  };
}

async function createPgliteDb(config) {
  const { PGlite } = await import('@electric-sql/pglite');
  if (config.pgliteDir) await mkdir(config.pgliteDir, { recursive: true });
  // One options object: PGlite ignores a second argument when there's no data directory.
  const pglite = new PGlite({ dataDir: config.pgliteDir || undefined, parsers });
  await pglite.waitReady;
  const wrap = (t) => ({
    query: (sql, params) => t.query(sql, params),
    exec: (sql) => t.exec(sql),
  });
  return {
    kind: 'pglite',
    query: (sql, params) => pglite.query(sql, params),
    tx: (fn) => pglite.transaction((t) => fn(wrap(t))),
    async listen(channel, cb) {
      await pglite.listen(channel, cb);
    },
    close: () => pglite.close(),
  };
}

async function migrate(db, log) {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  await db.tx(async (q) => {
    // Serialise concurrent app instances starting at the same time.
    await q.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await q.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await q.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await q.exec(sql);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      log.info?.(`applied migration ${file}`);
    }
  });
}
