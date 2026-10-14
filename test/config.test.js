import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';

test('production refuses to start without required settings', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /GOOGLE_CLIENT_ID.*PUBLIC_URL/);
});

test('dev sign-in can never be switched on in production', () => {
  const c = loadConfig({
    NODE_ENV: 'production',
    DEV_LOGIN: '1',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    DATABASE_URL: 'postgres://x',
    PUBLIC_URL: 'https://mission.example.com',
  });
  assert.equal(c.devLogin, false);
  assert.equal(c.secureCookies, true);
});

test('there must be some way to sign in', () => {
  assert.throws(() => loadConfig({}), /No way to sign in/);
});
