import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let ctx, alice, bob;

before(async () => {
  ctx = await setup({ ADMIN_EMAILS: 'alice@arcsite.com' });
  alice = await ctx.login('alice@arcsite.com');
  bob = await ctx.login('bob@arcsite.com');
});
after(() => ctx.close());

async function newProject(user = alice, extra = {}) {
  const r = await user.call('POST', '/api/projects', {
    title: 'Board',
    members: [{ userId: user.me.id }],
    milestones: [{ date: '2026-05-04', title: 'Kick Off', type: 'Kickoff' }],
    ...extra,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

test('signed-out visitors are sent to sign in', async () => {
  const page = await ctx.app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 302);
  assert.equal(page.headers.location, '/login');
  const api = await ctx.app.inject({ method: 'GET', url: '/api/state' });
  assert.equal(api.statusCode, 401);
});

test('admin flag comes from ADMIN_EMAILS', () => {
  assert.equal(alice.me.isAdmin, true);
  assert.equal(bob.me.isAdmin, false);
});

test('writes without the CSRF header are refused', async () => {
  const r = await ctx.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie: alice.headers.cookie },
    payload: { title: 'x', members: [{ userId: alice.me.id }] },
  });
  assert.equal(r.statusCode, 403);
});

test('create a project with members and milestones; everyone sees it', async () => {
  const { project, milestones } = await newProject(alice, {
    members: [{ userId: alice.me.id }, { userId: bob.me.id, role: 'Designer' }],
  });
  assert.equal(project.members[0].role, 'Owner / PM');
  assert.equal(project.members[1].role, 'Designer');
  assert.equal(milestones[0].date, '2026-05-04');
  const state = (await bob.call('GET', '/api/state')).body;
  assert.ok(state.projects.some((p) => p.id === project.id));
  assert.ok(state.milestones.some((m) => m.projectId === project.id && m.title === 'Kick Off'));
});

test('stale updates get 409 with the current version; fresh ones succeed', async () => {
  const { project } = await newProject();
  const a = await alice.call('PATCH', `/api/projects/${project.id}`, { version: project.version, status: 'At Risk' });
  assert.equal(a.status, 200);
  assert.equal(a.body.version, project.version + 1);
  // Bob still has the old version.
  const b = await bob.call('PATCH', `/api/projects/${project.id}`, { version: project.version, title: 'Bob title' });
  assert.equal(b.status, 409);
  assert.equal(b.body.current.status, 'At Risk');
  const b2 = await bob.call('PATCH', `/api/projects/${project.id}`, { version: b.body.current.version, title: 'Bob title' });
  assert.equal(b2.status, 200);
  assert.equal(b2.body.title, 'Bob title');
  assert.equal(b2.body.status, 'At Risk');
});

test('an update that changes nothing does not bump the version', async () => {
  const { project } = await newProject();
  const r = await alice.call('PATCH', `/api/projects/${project.id}`, { version: project.version, title: project.title });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, project.version);
});

test('member list is replaced in order and bumps the project version', async () => {
  const { project } = await newProject();
  const r = await alice.call('PUT', `/api/projects/${project.id}/members`, {
    members: [{ userId: bob.me.id, role: 'Owner / PM' }, { userId: alice.me.id, role: 'Member' }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.members.map((m) => m.userId), [bob.me.id, alice.me.id]);
  assert.equal(r.body.version, project.version + 1);
});

test('work items: create, move, conflict, delete; end before start is rejected', async () => {
  const { project } = await newProject();
  const id = crypto.randomUUID();
  const c = await alice.call('POST', '/api/work-items', { id, projectId: project.id, who: bob.me.id, start: '2026-05-04', end: '2026-05-08', label: 'Build' });
  assert.equal(c.status, 200);
  assert.equal(c.body.id, id, 'client-chosen id is kept');
  const bad = await alice.call('PATCH', `/api/work-items/${id}`, { version: 1, end: '2026-05-01' });
  assert.equal(bad.status, 400);
  const moved = await alice.call('PATCH', `/api/work-items/${id}`, { version: 1, start: '2026-05-05', end: '2026-05-09' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.version, 2);
  const stale = await bob.call('PATCH', `/api/work-items/${id}`, { version: 1, label: 'x' });
  assert.equal(stale.status, 409);
  assert.equal((await bob.call('DELETE', `/api/work-items/${id}`)).status, 200);
  const gone = await alice.call('PATCH', `/api/work-items/${id}`, { version: 2, label: 'y' });
  assert.equal(gone.status, 404);
});

test('"Others" work items have no project', async () => {
  const r = await bob.call('POST', '/api/work-items', { projectId: null, who: bob.me.id, start: '2026-06-01', end: '2026-06-02', label: 'On-call' });
  assert.equal(r.status, 200);
  assert.equal(r.body.projectId, null);
});

test('time off: one entry per person per day; invalid dates rejected', async () => {
  const first = await bob.call('POST', '/api/time-off', { userId: bob.me.id, date: '2026-07-01', type: 'am', category: 'sick' });
  assert.equal(first.status, 200);
  const dup = await alice.call('POST', '/api/time-off', { userId: bob.me.id, date: '2026-07-01' });
  assert.equal(dup.status, 409);
  const bad = await bob.call('POST', '/api/time-off', { userId: bob.me.id, date: '2026-02-30' });
  assert.equal(bad.status, 400);
  const badEnum = await bob.call('PATCH', `/api/time-off/${first.body.id}`, { version: 1, category: 'party' });
  assert.equal(badEnum.status, 400);
});

test('deleting a project removes its milestones and work items', async () => {
  const { project } = await newProject();
  await alice.call('POST', '/api/work-items', { projectId: project.id, who: alice.me.id, start: '2026-05-04', end: '2026-05-05' });
  assert.equal((await alice.call('DELETE', `/api/projects/${project.id}`)).status, 200);
  const state = (await alice.call('GET', '/api/state')).body;
  assert.ok(!state.milestones.some((m) => m.projectId === project.id));
  assert.ok(!state.workItems.some((w) => w.projectId === project.id));
});

test('creating inside a deleted project returns 404', async () => {
  const { project } = await newProject();
  await alice.call('DELETE', `/api/projects/${project.id}`);
  const r = await bob.call('POST', '/api/milestones', { projectId: project.id, date: '2026-05-04' });
  assert.equal(r.status, 404);
});

test('every change is logged with who made it, in order', async () => {
  const { project } = await newProject(bob);
  await bob.call('PATCH', `/api/projects/${project.id}`, { version: project.version, tint: 'teal' });
  const log = (await alice.call('GET', '/api/activity?limit=2')).body;
  assert.equal(log[0].entity, 'project');
  assert.equal(log[0].op, 'update');
  assert.equal(log[0].actorId, bob.me.id);
  assert.deepEqual(log[0].changes.tint, ['indigo', 'teal']);
  assert.ok(log[0].id > log[1].id);
});

test('change feed can be replayed after a given event id', async () => {
  const since = await ctx.app.hub.latestId();
  const { project } = await newProject();
  await alice.call('PATCH', `/api/projects/${project.id}`, { version: project.version, title: 'Replayed' });
  const missed = await ctx.app.hub.replay(since);
  assert.deepEqual(missed.map((e) => e.op), ['create', 'update']);
  assert.equal(missed[1].data.title, 'Replayed');
});

test('only admins manage people; nobody can lock themselves out', async () => {
  const denied = await bob.call('POST', '/api/users', { email: 'carol@arcsite.com', name: 'Carol' });
  assert.equal(denied.status, 403);
  const outside = await alice.call('POST', '/api/users', { email: 'mallory@gmail.com', name: 'M' });
  assert.equal(outside.status, 400);
  const carol = await alice.call('POST', '/api/users', { email: 'Carol@arcsite.com', name: 'Carol' });
  assert.equal(carol.status, 200);
  assert.equal(carol.body.email, 'carol@arcsite.com');
  const self = await alice.call('PATCH', `/api/users/${alice.me.id}`, { active: false });
  assert.equal(self.status, 400);
  // Bob may rename himself but not change flags.
  assert.equal((await bob.call('PATCH', `/api/users/${bob.me.id}`, { name: 'Robert' })).status, 200);
  assert.equal((await bob.call('PATCH', `/api/users/${bob.me.id}`, { isAdmin: true })).status, 403);
});

test('deactivated people are signed out and cannot sign back in', async () => {
  const dave = await ctx.login('dave@arcsite.com');
  assert.equal((await alice.call('PATCH', `/api/users/${dave.me.id}`, { active: false })).status, 200);
  assert.equal((await dave.call('GET', '/api/state')).status, 401);
  await assert.rejects(() => ctx.login('dave@arcsite.com'));
});

test('sprint anchor must be a Monday', async () => {
  assert.equal((await alice.call('PUT', '/api/settings/sprint', { anchorDate: '2026-04-28', anchorNumber: 29 })).status, 400);
  const ok = await alice.call('PUT', '/api/settings/sprint', { anchorDate: '2026-04-27', anchorNumber: 30 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sprint.anchorNumber, 30);
});

test('Jira import explains when it is not configured', async () => {
  const r = await alice.call('GET', '/api/jira/issue/ARC-1');
  assert.equal(r.status, 501);
});

test('responses carry security headers', async () => {
  const r = await ctx.app.inject({ method: 'GET', url: '/login' });
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(r.headers['x-frame-options'], 'DENY');
});
