// Realtime change feed.
//
// Every write transaction calls `recordEvent()`, which appends a row to the
// `events` table and issues NOTIFY with the row id. NOTIFY is only delivered
// once the transaction commits, so browsers never hear about changes that were
// rolled back. Each app instance LISTENs, loads the event row and pushes it to
// the browsers connected to it over Server-Sent Events. This keeps several app
// instances (e.g. two Fargate tasks behind a load balancer) in sync.

const CHANNEL = 'mc_events';
const EVENT_ORDER_LOCK = 727002;
const HEARTBEAT_MS = 20_000;
// Safety net: also look for new events on a timer, so a lost NOTIFY (e.g. a
// dropped LISTEN connection) delays an update by a few seconds instead of
// losing it. The query is a cheap primary-key range scan.
const CATCH_UP_MS = 3_000;
const SESSION_RECHECK_MS = 5 * 60_000;
export const REPLAY_LIMIT = 1000;

export function serializeEvent(row) {
  return {
    id: row.id,
    at: row.at instanceof Date ? row.at.toISOString() : row.at,
    actorId: row.actor_id,
    clientId: row.client_id,
    entity: row.entity,
    entityId: row.entity_id,
    op: row.op,
    data: row.data,
    changes: row.changes || null,
  };
}

/** Append a change to the feed. Must be called inside the write transaction. */
export async function recordEvent(q, { actorId, clientId, entity, entityId, op, data, changes }) {
  // Taking this lock right before the insert makes event ids increase in commit
  // order, so a client that resumes "after id N" can never skip a slower commit.
  await q.query('SELECT pg_advisory_xact_lock($1)', [EVENT_ORDER_LOCK]);
  const { rows } = await q.query(
    `INSERT INTO events (actor_id, client_id, entity, entity_id, op, data, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [actorId || null, clientId || null, entity, entityId || null, op, JSON.stringify(data ?? {}), changes ? JSON.stringify(changes) : null],
  );
  await q.query('SELECT pg_notify($1, $2)', [CHANNEL, String(rows[0].id)]);
  return serializeEvent(rows[0]);
}

export class EventHub {
  constructor(db, log, { isSessionValid } = {}) {
    this.db = db;
    this.log = log;
    this.isSessionValid = isSessionValid;
    this.clients = new Set();
    this.queue = Promise.resolve();
    this.lastDelivered = 0;
    this.timer = null;
    this.catchUpTimer = null;
  }

  async start() {
    const { rows } = await this.db.query('SELECT coalesce(max(id), 0) AS id FROM events');
    this.lastDelivered = rows[0].id;
    await this.db.listen(
      CHANNEL,
      (payload) => this.#enqueue(Number(payload)),
      // After a dropped LISTEN connection, catch up on anything we missed.
      () => this.#enqueue(Infinity),
    );
    this.timer = setInterval(() => this.#heartbeat(), HEARTBEAT_MS);
    this.timer.unref?.();
    this.catchUpTimer = setInterval(() => {
      if (this.clients.size > 0) this.#enqueue(Infinity);
    }, CATCH_UP_MS);
    this.catchUpTimer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.catchUpTimer);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }

  async latestId() {
    const { rows } = await this.db.query('SELECT coalesce(max(id), 0) AS id FROM events');
    return rows[0].id;
  }

  /** Events after `sinceId`, oldest first. `null` means too many: client must reload. */
  async replay(sinceId) {
    const { rows } = await this.db.query('SELECT * FROM events WHERE id > $1 ORDER BY id LIMIT $2', [sinceId, REPLAY_LIMIT + 1]);
    if (rows.length > REPLAY_LIMIT) return null;
    return rows.map(serializeEvent);
  }

  /** Attach an SSE response. `res` is the raw Node response. */
  addClient({ res, userId, sessionHash }) {
    const client = { res, userId, sessionHash, checkedAt: Date.now() };
    this.clients.add(client);
    res.on('close', () => this.clients.delete(client));
    return client;
  }

  send(client, event) {
    client.res.write(`id: ${event.id}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`);
  }

  // Deliveries are chained so events reach browsers in id order even though
  // loading each row is asynchronous.
  #enqueue(id) {
    this.queue = this.queue
      .then(() => this.#deliverUpTo(id))
      .catch((err) => this.log.error({ err }, 'failed to deliver realtime event'));
  }

  async #deliverUpTo(id) {
    if (id <= this.lastDelivered) return;
    const { rows } = await this.db.query(
      'SELECT * FROM events WHERE id > $1 AND id <= $2 ORDER BY id',
      [this.lastDelivered, Number.isFinite(id) ? id : Number.MAX_SAFE_INTEGER],
    );
    for (const row of rows) {
      const event = serializeEvent(row);
      for (const c of this.clients) this.send(c, event);
      this.lastDelivered = row.id;
    }
  }

  async #heartbeat() {
    const now = Date.now();
    for (const c of [...this.clients]) {
      c.res.write(': ping\n\n');
      if (this.isSessionValid && now - c.checkedAt > SESSION_RECHECK_MS) {
        c.checkedAt = now;
        try {
          if (!(await this.isSessionValid(c.sessionHash))) {
            c.res.write('event: signed-out\ndata: {}\n\n');
            c.res.end();
          }
        } catch (err) {
          this.log.error({ err }, 'session recheck failed');
        }
      }
    }
  }
}
