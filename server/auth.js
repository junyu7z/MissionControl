// Sign-in with Google Workspace (OpenID Connect, authorization-code flow with
// PKCE) and cookie sessions stored in Postgres.
//
// Only verified accounts whose Workspace domain (`hd` claim) is in
// ALLOWED_DOMAINS can sign in. The `hd` request parameter is just a UI hint to
// Google's account picker; the claim inside the verified ID token is what counts.

import crypto from 'node:crypto';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { recordEvent } from './events.js';
import { mapUser } from './repo.js';
import { loginPage } from './pages.js';

export const SESSION_COOKIE = 'mc_session';
const OAUTH_COOKIE = 'mc_oauth';
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function createAuth({ app, db, config }) {
  const google = config.googleClientId
    ? new OAuth2Client({
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        redirectUri: `${config.publicUrl}/auth/google/callback`,
      })
    : null;

  const cookieBase = { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies };

  async function createSession(reply, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + config.sessionDays * 86400_000);
    await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [hashToken(token), userId, expires]);
    reply.setCookie(SESSION_COOKIE, token, { ...cookieBase, expires });
  }

  /** Resolve the signed-in user from the session cookie, or null. */
  async function userFromRequest(request) {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) return null;
    const tokenHash = hashToken(token);
    const { rows } = await db.query(
      `SELECT u.*, s.last_seen_at AS session_last_seen
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return null;
    // Sliding expiry, written at most once an hour per session.
    if (Date.now() - new Date(row.session_last_seen).getTime() > TOUCH_INTERVAL_MS) {
      await db.query(
        `UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2) WHERE token_hash = $1`,
        [tokenHash, config.sessionDays],
      );
    }
    request.sessionHash = tokenHash;
    return mapUser(row);
  }

  async function isSessionValid(tokenHash) {
    const { rows } = await db.query(
      `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
      [tokenHash],
    );
    return rows.length > 0;
  }

  /** Create or refresh the user record for someone who just proved their identity. */
  async function upsertLoginUser({ email, name, avatarUrl }) {
    email = email.toLowerCase();
    const grantAdmin = config.adminEmails.includes(email);
    return db.tx(async (q) => {
      const existing = (await q.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [email])).rows[0];
      if (existing && !existing.active) return { error: 'deactivated' };
      let row;
      if (existing) {
        // Keep the display name an admin may have set; refresh the avatar.
        row = (
          await q.query(
            `UPDATE users SET avatar_url = coalesce($2, avatar_url), last_login_at = now(), is_admin = is_admin OR $3
              WHERE id = $1 RETURNING *`,
            [existing.id, avatarUrl || null, grantAdmin],
          )
        ).rows[0];
      } else {
        row = (
          await q.query(
            `INSERT INTO users (email, name, avatar_url, is_admin, last_login_at)
             VALUES ($1, $2, $3, $4, now()) RETURNING *`,
            [email, (name || email.split('@')[0]).slice(0, 120), avatarUrl || null, grantAdmin],
          )
        ).rows[0];
      }
      const user = mapUser(row);
      const changed = !existing || existing.avatar_url !== row.avatar_url || existing.is_admin !== row.is_admin;
      if (changed) {
        await recordEvent(q, { actorId: user.id, entity: 'user', entityId: user.id, op: existing ? 'update' : 'create', data: user });
      }
      return { user };
    });
  }

  function safeReturnTo(v) {
    // Only same-site absolute paths; never "//host" or a full URL.
    return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/';
  }

  async function renderLogin(reply, { error } = {}) {
    let devUsers = [];
    if (config.devLogin) {
      devUsers = (await db.query('SELECT email, name FROM users WHERE active ORDER BY name')).rows;
    }
    reply.type('text/html; charset=utf-8').send(loginPage({ google: Boolean(google), devLogin: config.devLogin, devUsers, error, domains: config.allowedDomains }));
  }

  app.get('/login', async (request, reply) => {
    if (await userFromRequest(request)) return reply.redirect('/');
    return renderLogin(reply, { error: request.query?.error });
  });

  app.get('/auth/google', async (request, reply) => {
    if (!google) return reply.code(404).send('Google sign-in is not configured');
    const state = crypto.randomBytes(16).toString('base64url');
    const { codeVerifier, codeChallenge } = await google.generateCodeVerifierAsync();
    const returnTo = safeReturnTo(request.query?.returnTo);
    reply.setCookie(OAUTH_COOKIE, JSON.stringify({ state, codeVerifier, returnTo }), {
      ...cookieBase,
      path: '/auth/google',
      maxAge: 600,
    });
    const url = google.generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: codeChallenge,
      prompt: 'select_account',
      ...(config.allowedDomains.length === 1 ? { hd: config.allowedDomains[0] } : {}),
    });
    return reply.redirect(url);
  });

  app.get('/auth/google/callback', async (request, reply) => {
    if (!google) return reply.code(404).send('Google sign-in is not configured');
    const fail = (code) => reply.redirect(`/login?error=${code}`);
    let saved;
    try {
      saved = JSON.parse(request.cookies?.[OAUTH_COOKIE] || '');
    } catch {
      return fail('expired');
    }
    reply.clearCookie(OAUTH_COOKIE, { ...cookieBase, path: '/auth/google' });
    const { code, state, error } = request.query || {};
    if (error) return fail('cancelled');
    if (!code || !state || !saved?.state || state !== saved.state) return fail('expired');

    let payload;
    try {
      const { tokens } = await google.getToken({ code, codeVerifier: saved.codeVerifier });
      const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: config.googleClientId });
      payload = ticket.getPayload();
    } catch (err) {
      request.log.warn({ err }, 'google token exchange failed');
      return fail('google');
    }
    const email = String(payload?.email || '').toLowerCase();
    const hd = String(payload?.hd || '').toLowerCase();
    const emailDomain = email.split('@')[1] || '';
    if (!payload?.email_verified || !config.allowedDomains.includes(hd) || hd !== emailDomain) {
      request.log.warn({ email, hd }, 'rejected sign-in from outside the allowed Workspace domains');
      return fail('domain');
    }
    const result = await upsertLoginUser({ email, name: payload.name, avatarUrl: payload.picture });
    if (result.error) return fail(result.error);
    await createSession(reply, result.user.id);
    return reply.redirect(safeReturnTo(saved.returnTo));
  });

  if (config.devLogin) {
    // Local development only: sign in as any email without Google.
    app.get('/auth/dev-login', async (request, reply) => {
      const email = String(request.query?.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return renderLogin(reply, { error: 'email' });
      const result = await upsertLoginUser({ email, name: request.query?.name });
      if (result.error) return renderLogin(reply, { error: result.error });
      await createSession(reply, result.user.id);
      return reply.redirect('/');
    });
  }

  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    reply.clearCookie(SESSION_COOKIE, cookieBase);
    return { ok: true };
  });

  // Expired sessions are harmless (they fail the expires_at check) but are swept daily.
  const sweep = setInterval(() => {
    db.query('DELETE FROM sessions WHERE expires_at < now()').catch((err) => app.log.error({ err }, 'session sweep failed'));
  }, 24 * 3600_000);
  sweep.unref?.();
  app.addHook('onClose', async () => clearInterval(sweep));

  return { userFromRequest, isSessionValid, createSession };
}
