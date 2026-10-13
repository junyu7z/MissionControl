// Builds the HTTP application: static board UI, sign-in, JSON API and the
// realtime event stream. Kept separate from index.js so tests can build an
// app against an in-memory database.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { createAuth } from './auth.js';
import { EventHub } from './events.js';
import { HttpError } from './repo.js';
import apiRoutes from './routes/api.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // The board positions thousands of elements with inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp({ config, db, logger = true }) {
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 1024 * 1024 });
  await app.register(cookie);

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    if (config.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err.validation) {
      return reply.code(400).send({ error: 'Some of the data sent was not valid.', details: err.message });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, ...err.extra });
    }
    // Postgres constraint errors -> friendly client errors.
    switch (err.code) {
      case '23505':
        return reply.code(409).send({ error: err.table === 'time_off' ? 'This person already has time off on that day.' : 'That already exists.' });
      case '23503':
        return reply.code(404).send({ error: 'A related item no longer exists — it may have been deleted by someone else.' });
      case '23514':
      case '22007':
      case '22008':
      case '22P02':
        return reply.code(400).send({ error: 'Some of the data sent was not valid.' });
    }
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'Something went wrong on the server. Please try again.' });
  });

  const auth = createAuth({ app, db, config });
  const hub = new EventHub(db, app.log, { isSessionValid: auth.isSessionValid });
  await hub.start();
  // End live streams first; otherwise shutdown waits for them forever. Browsers reconnect to another instance.
  app.addHook('preClose', async () => hub.stop());
  app.decorate('hub', hub);

  // Load balancer health check (no auth).
  app.get('/healthz', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  await app.register(
    async (api) => {
      api.addHook('onRequest', async (req, reply) => {
        const user = await auth.userFromRequest(req);
        if (!user) return reply.code(401).send({ error: 'Your session has ended. Please sign in again.' });
        req.user = user;
        // CSRF protection: browsers cannot attach a custom header to a cross-site
        // request without a CORS preflight, which this server never grants.
        if (MUTATING.has(req.method) && req.headers['x-requested-with'] !== 'mission-control') {
          return reply.code(403).send({ error: 'Missing request header.' });
        }
      });

      api.get('/events', async (req, reply) => {
        const since = Number(req.headers['last-event-id'] ?? req.query?.since);
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        const upTo = hub.lastDelivered;
        const client = hub.addClient({ res, userId: req.user.id, sessionHash: req.sessionHash });
        if (Number.isFinite(since) && since < upTo) {
          const missed = await hub.replay(since);
          if (missed === null) res.write('event: resync\ndata: {}\n\n');
          else for (const e of missed) if (e.id <= upTo) hub.send(client, e);
        }
      });

      await api.register(apiRoutes, { db, hub, config });
    },
    { prefix: '/api' },
  );

  // The board itself. Signed-out visitors are sent to the sign-in page.
  app.get('/', async (req, reply) => {
    if (!(await auth.userFromRequest(req))) return reply.redirect('/login');
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  });

  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    index: false,
    wildcard: true,
    setHeaders(reply, filePath) {
      // Fonts never change; everything else revalidates so a deploy shows up immediately.
      reply.header('Cache-Control', filePath.includes(`${path.sep}fonts${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  return app;
}
