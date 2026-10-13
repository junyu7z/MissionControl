# Mission Control

ArcSite's project timeline board: projects, milestones, who is working on what, and time off — shared live by the whole team.

- **Sign-in** with Google Workspace (only `@arcsite.com` accounts).
- **Multi-user editing**: every change saves instantly and appears on everyone else's screen within a second. Edits to different fields of the same item merge automatically; if two people change the same field at the same moment, the later save is told and nothing is overwritten silently.
- **Change history** under ⋯ → Recent changes.

## Layout

```
public/            the board UI (plain HTML/CSS/JS, no build step)
  app.js           rendering + interactions; the "Server sync" section at the end talks to the API
server/            Node.js (Fastify) backend
  app.js           HTTP app: static files, security headers, /api, live event stream
  auth.js          Google OpenID Connect sign-in, cookie sessions
  routes/api.js    JSON API (projects, milestones, work items, time off, people, settings)
  events.js        change log + realtime fan-out (Postgres LISTEN/NOTIFY → Server-Sent Events)
  db.js            Postgres (production) or embedded PGlite (local dev/tests); runs migrations
  migrations/      SQL schema
scripts/seed-demo.js   loads the prototype's demo data (dev only)
test/              API and realtime tests (node:test)
deploy/            AWS CloudFormation template
docs/DEPLOY.md     step-by-step AWS deployment guide (Chinese)
```

## Local development

Requires Node.js 22+. No database to install — local runs use an embedded Postgres stored in `.data/`.

```bash
npm install
cp .env.example .env     # DEV_LOGIN=1: sign in as anyone without Google
npm run seed:demo        # optional demo data
npm run dev              # http://localhost:8765
npm test
```

To try real Google sign-in locally, set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env` and add `http://localhost:8765/auth/google/callback` as a redirect URI on the OAuth client.

## How saving works

Each item carries a `version`. The browser sends the version it last saw with every update; the server rejects stale updates with `409` and the current data. The browser then keeps the teammate's changes, re-sends its own changes to other fields, and shows a notice only when both people edited the same field. Every committed change is appended to the `events` table and pushed to connected browsers; a browser that reconnects resumes from the last event it received.

## Deploying

See [docs/DEPLOY.md](docs/DEPLOY.md). After the one-time setup, merging to `main` deploys automatically via GitHub Actions.
