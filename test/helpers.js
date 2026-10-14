import { loadConfig } from '../server/config.js';
import { createDb } from '../server/db.js';
import { buildApp } from '../server/app.js';

const quiet = { info() {}, error() {}, warn() {} };

/** A fresh app on an in-memory database, with dev sign-in enabled. */
export async function setup(env = {}) {
  const config = loadConfig({ DEV_LOGIN: '1', ALLOWED_DOMAINS: 'arcsite.com', ...env });
  const db = await createDb(config, quiet);
  const app = await buildApp({ config, db, logger: false });
  await app.ready();

  async function login(email) {
    const res = await app.inject({ method: 'GET', url: `/auth/dev-login?email=${encodeURIComponent(email)}` });
    const cookie = res.cookies.find((c) => c.name === 'mc_session');
    if (!cookie) throw new Error('login failed');
    const headers = { cookie: `mc_session=${cookie.value}`, 'x-requested-with': 'mission-control' };
    const call = async (method, url, payload) => {
      const r = await app.inject({ method, url, headers, payload });
      return { status: r.statusCode, body: r.body ? safeJson(r.body) : null };
    };
    const state = (await call('GET', '/api/state')).body;
    return { headers, call, me: state.me };
  }

  async function close() {
    await app.close();
    await db.close();
  }
  return { app, db, config, login, close };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
