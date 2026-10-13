// Runtime configuration, read once from environment variables.
// See .env.example for the full list and what each one does.

function bool(v, fallback = false) {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function list(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const port = Number(env.PORT || 8080);
  const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');

  const config = {
    isProd,
    port,
    host: env.HOST || '0.0.0.0',
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),

    // Database: DATABASE_URL or the standard PG* variables select real Postgres.
    // With neither set (local dev / tests) an embedded Postgres (PGlite) is used.
    databaseUrl: env.DATABASE_URL || '',
    usePgEnv: Boolean(env.PGHOST),
    dbSsl: env.DB_SSL || '', // '' | 'require' | 'rds'
    pgliteDir: env.PGLITE_DIR || '', // empty = in-memory

    // Google Workspace SSO
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    allowedDomains: list(env.ALLOWED_DOMAINS || 'arcsite.com'),
    adminEmails: list(env.ADMIN_EMAILS),

    // Local-only shortcut that skips Google. Never allowed in production.
    devLogin: !isProd && bool(env.DEV_LOGIN),

    sessionDays: Number(env.SESSION_DAYS || 30),

    // Optional Jira Cloud integration (server-side only; the token never reaches the browser).
    jira: {
      baseUrl: (env.JIRA_BASE_URL || '').replace(/\/+$/, ''),
      email: env.JIRA_EMAIL || '',
      apiToken: env.JIRA_API_TOKEN || '',
      startDateField: env.JIRA_START_DATE_FIELD || '',
    },
  };

  if (isProd) {
    const missing = [];
    if (!config.googleClientId) missing.push('GOOGLE_CLIENT_ID');
    if (!config.googleClientSecret) missing.push('GOOGLE_CLIENT_SECRET');
    if (!config.databaseUrl && !config.usePgEnv) missing.push('DATABASE_URL or PGHOST');
    if (!env.PUBLIC_URL) missing.push('PUBLIC_URL');
    if (missing.length) throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
  if (!config.googleClientId && !config.devLogin) {
    throw new Error('No way to sign in: set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET, or DEV_LOGIN=1 for local development.');
  }
  return config;
}
