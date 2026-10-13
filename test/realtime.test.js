import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let ctx;
after(() => ctx?.close());

/** Read SSE "change" events from a streaming fetch response until `count` arrive. */
async function readChanges(res, count) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!block.includes('event: change')) continue;
      const data = block.split('\n').find((l) => l.startsWith('data: '));
      events.push(JSON.parse(data.slice(6)));
    }
  }
  reader.cancel();
  return events;
}

test('a connected browser receives teammates’ changes live, and missed ones on reconnect', async () => {
  ctx = await setup();
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${ctx.app.server.address().port}`;
  const alice = await ctx.login('alice@arcsite.com');
  const bob = await ctx.login('bob@arcsite.com');

  const since = await ctx.app.hub.latestId();
  const stream = await fetch(`${base}/api/events?since=${since}`, { headers: { cookie: alice.headers.cookie } });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);

  const pending = readChanges(stream, 2);
  const { body } = await bob.call('POST', '/api/projects', { title: 'Live', members: [{ userId: bob.me.id }] });
  await bob.call('PATCH', `/api/projects/${body.project.id}`, { version: 1, status: 'Off Track' });
  const events = await pending;
  assert.deepEqual(events.map((e) => [e.entity, e.op]), [['project', 'create'], ['project', 'update']]);
  assert.equal(events[1].actorId, bob.me.id);
  assert.equal(events[1].data.status, 'Off Track');

  // Reconnecting with Last-Event-ID replays only what came after it.
  const again = await fetch(`${base}/api/events`, { headers: { cookie: alice.headers.cookie, 'last-event-id': String(events[0].id) } });
  const replayed = await readChanges(again, 1);
  assert.equal(replayed[0].id, events[1].id);
});

test('the event stream requires a session', async () => {
  const base = `http://127.0.0.1:${ctx.app.server.address().port}`;
  const res = await fetch(`${base}/api/events`);
  assert.equal(res.status, 401);
});
