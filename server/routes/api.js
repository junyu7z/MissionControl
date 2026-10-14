// JSON API used by the board. Every route requires a signed-in user (see the
// preHandler registered in app.js). Writes are small, per-item operations so
// two people editing different things never overwrite each other; each write
// carries the item's `version` so stale edits are rejected instead of
// clobbering newer data.

import { recordEvent } from '../events.js';
import {
  HttpError,
  loadMembers,
  loadSettings,
  loadState,
  mapMilestone,
  mapProject,
  mapTimeOff,
  mapUser,
  mapWorkItem,
  updateVersioned,
} from '../repo.js';
import { fetchJiraIssue } from '../jira.js';

const UUID = { type: 'string', format: 'uuid' };
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const VERSION = { type: 'integer', minimum: 1 };
const STATUS = { type: 'string', enum: ['On Track', 'At Risk', 'Off Track', 'Archived'] };
const TINT = { type: 'string', enum: ['indigo', 'blue', 'cyan', 'teal', 'green', 'yellow', 'orange', 'rose', 'pink', 'purple'] };
const MS_TYPE = { type: 'string', enum: ['Milestone', 'Kickoff', 'Release', 'Review', 'Beta', 'Launch'] };
const DAY_TYPE = { type: 'string', enum: ['full', 'am', 'pm'] };
const CATEGORY = { type: 'string', enum: ['vacation', 'sick', 'holiday', 'personal', 'bereavement', 'jury', 'other'] };
const DURATION = {
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: { mode: { type: 'string', enum: ['undefined', 'milestone', 'date'] }, date: { anyOf: [DATE, { type: 'null' }] } },
};
const str = (max) => ({ type: 'string', maxLength: max });
const idParams = { type: 'object', required: ['id'], properties: { id: UUID } };
const MEMBERS = {
  type: 'array',
  minItems: 1,
  maxItems: 100,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['userId'],
    properties: { userId: UUID, role: str(60) },
  },
};

const durationCols = (prefix, d) =>
  d === undefined ? {} : { [`${prefix}_mode`]: d.mode, [`${prefix}_date`]: d.mode === 'date' ? d.date || null : null };

export default async function apiRoutes(app, { db, hub, config }) {
  const actor = (req) => req.user.id;
  const clientId = (req) => String(req.headers['x-client-id'] || '').slice(0, 64) || null;
  const event = (q, req, rest) => recordEvent(q, { actorId: actor(req), clientId: clientId(req), ...rest });

  function requireAdmin(req) {
    if (!req.user.isAdmin) throw new HttpError(403, 'Only admins can do this.');
  }

  // ----------------------------------------------------------------- state
  app.get('/state', async (req) => ({ me: req.user, ...(await loadState(db)) }));

  // -------------------------------------------------------------- projects
  app.post(
    '/projects',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'members'],
          properties: {
            id: UUID,
            title: { type: 'string', minLength: 1, maxLength: 200 },
            key: str(500),
            status: STATUS,
            tint: TINT,
            description: str(5000),
            startDate: DURATION,
            endDate: DURATION,
            members: MEMBERS,
            milestones: {
              type: 'array',
              maxItems: 200,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['date'],
                properties: { id: UUID, date: DATE, title: str(200), desc: str(2000), type: MS_TYPE },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const b = req.body;
      return db.tx(async (q) => {
        const { rows: ord } = await q.query('SELECT coalesce(max(sort_order), -1) + 1 AS next FROM projects');
        const start = durationCols('start', b.startDate || { mode: 'undefined' });
        const end = durationCols('end', b.endDate || { mode: 'undefined' });
        const { rows } = await q.query(
          `INSERT INTO projects (id, title, jira_key, status, tint, description, start_mode, start_date, end_mode, end_date,
                                 sort_order, created_by, updated_by)
           VALUES (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING *`,
          [
            b.id || null,
            b.title.trim(),
            (b.key || '').trim(),
            b.status || 'On Track',
            b.tint || 'indigo',
            b.description || '',
            start.start_mode,
            start.start_date,
            end.end_mode,
            end.end_date,
            ord[0].next,
            actor(req),
          ],
        );
        const p = rows[0];
        await insertMembers(q, p.id, b.members);
        const milestones = [];
        for (const ms of b.milestones || []) {
          const { rows: mr } = await q.query(
            `INSERT INTO milestones (id, project_id, date, title, description, type, updated_by)
             VALUES (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7) RETURNING *`,
            [ms.id || null, p.id, ms.date, ms.title || '', ms.desc || '', ms.type || 'Milestone', actor(req)],
          );
          milestones.push(mapMilestone(mr[0]));
        }
        const project = mapProject(p, await loadMembers(q, p.id));
        await event(q, req, { entity: 'project', entityId: p.id, op: 'create', data: { ...project, milestones } });
        return { project, milestones };
      });
    },
  );

  app.patch(
    '/projects/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['version'],
          properties: {
            version: VERSION,
            title: { type: 'string', maxLength: 200 },
            key: str(500),
            status: STATUS,
            tint: TINT,
            description: str(5000),
            startDate: DURATION,
            endDate: DURATION,
          },
        },
      },
    },
    async (req) => {
      const b = req.body;
      return db.tx(async (q) => {
        const { row, changes } = await updateVersioned(q, {
          table: 'projects',
          id: req.params.id,
          version: b.version,
          actorId: actor(req),
          map: (r) => mapProject(r),
          sets: {
            title: b.title,
            jira_key: b.key,
            status: b.status,
            tint: b.tint,
            description: b.description,
            ...durationCols('start', b.startDate),
            ...durationCols('end', b.endDate),
          },
        });
        const project = mapProject(row, await loadMembers(q, row.id));
        if (changes) await event(q, req, { entity: 'project', entityId: row.id, op: 'update', data: project, changes });
        return project;
      });
    },
  );

  async function insertMembers(q, projectId, members) {
    const seen = new Set();
    let i = 0;
    for (const m of members) {
      if (seen.has(m.userId)) continue;
      seen.add(m.userId);
      await q.query('INSERT INTO project_members (project_id, user_id, role, sort_order) VALUES ($1, $2, $3, $4)', [
        projectId,
        m.userId,
        m.role || (i === 0 ? 'Owner / PM' : 'Member'),
        i++,
      ]);
    }
  }

  // The member list is replaced as a whole (ordered; first = Owner / PM).
  app.put(
    '/projects/:id/members',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['members'], properties: { members: MEMBERS } } } },
    async (req) => {
      return db.tx(async (q) => {
        const cur = (await q.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
        if (!cur) throw new HttpError(404, 'This project no longer exists.');
        const before = await loadMembers(q, cur.id);
        await q.query('DELETE FROM project_members WHERE project_id = $1', [cur.id]);
        await insertMembers(q, cur.id, req.body.members);
        const after = await loadMembers(q, cur.id);
        const sig = (ms) => ms.map((m) => `${m.userId}:${m.role}`).join(',');
        if (sig(before) === sig(after)) return mapProject(cur, after);
        const { rows } = await q.query(
          'UPDATE projects SET version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *',
          [cur.id, actor(req)],
        );
        const project = mapProject(rows[0], after);
        await event(q, req, { entity: 'project', entityId: cur.id, op: 'update', data: project, changes: { members: [before, after] } });
        return project;
      });
    },
  );

  app.put(
    '/projects/order',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['ids'],
          properties: { ids: { type: 'array', items: UUID, maxItems: 1000 } },
        },
      },
    },
    async (req) => {
      return db.tx(async (q) => {
        const ids = req.body.ids;
        // Projects not in the list (e.g. archived, or added meanwhile) keep their relative order after these.
        const { rows } = await q.query('SELECT id FROM projects ORDER BY sort_order, created_at');
        const rest = rows.map((r) => r.id).filter((id) => !ids.includes(id));
        const all = [...ids.filter((id) => rows.some((r) => r.id === id)), ...rest];
        for (let i = 0; i < all.length; i++) await q.query('UPDATE projects SET sort_order = $2 WHERE id = $1', [all[i], i]);
        await event(q, req, { entity: 'projectOrder', op: 'update', data: { ids: all } });
        return { ids: all };
      });
    },
  );

  app.delete('/projects/:id', { schema: { params: idParams } }, async (req) => {
    return db.tx(async (q) => {
      const { rows } = await q.query('DELETE FROM projects WHERE id = $1 RETURNING *', [req.params.id]);
      if (!rows[0]) return { ok: true };
      await event(q, req, { entity: 'project', entityId: rows[0].id, op: 'delete', data: { id: rows[0].id, title: rows[0].title } });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ milestones
  app.post(
    '/milestones',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['projectId', 'date'],
          properties: { id: UUID, projectId: UUID, date: DATE, title: str(200), desc: str(2000), type: MS_TYPE },
        },
      },
    },
    async (req) => {
      const b = req.body;
      return db.tx(async (q) => {
        const { rows } = await q.query(
          `INSERT INTO milestones (id, project_id, date, title, description, type, updated_by)
           VALUES (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7) RETURNING *`,
          [b.id || null, b.projectId, b.date, b.title || '', b.desc || '', b.type || 'Milestone', actor(req)],
        );
        const ms = mapMilestone(rows[0]);
        await event(q, req, { entity: 'milestone', entityId: ms.id, op: 'create', data: ms });
        return ms;
      });
    },
  );

  app.patch(
    '/milestones/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['version'],
          properties: { version: VERSION, date: DATE, title: str(200), desc: str(2000), type: MS_TYPE },
        },
      },
    },
    async (req) => {
      const b = req.body;
      return db.tx(async (q) => {
        const { row, changes } = await updateVersioned(q, {
          table: 'milestones',
          id: req.params.id,
          version: b.version,
          actorId: actor(req),
          map: mapMilestone,
          sets: { date: b.date, title: b.title, description: b.desc, type: b.type },
        });
        const ms = mapMilestone(row);
        if (changes) await event(q, req, { entity: 'milestone', entityId: ms.id, op: 'update', data: ms, changes });
        return ms;
      });
    },
  );

  app.delete('/milestones/:id', { schema: { params: idParams } }, async (req) => {
    return db.tx(async (q) => {
      const { rows } = await q.query('DELETE FROM milestones WHERE id = $1 RETURNING *', [req.params.id]);
      if (rows[0]) await event(q, req, { entity: 'milestone', entityId: rows[0].id, op: 'delete', data: mapMilestone(rows[0]) });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ work items
  app.post(
    '/work-items',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['who', 'start', 'end'],
          properties: {
            id: UUID,
            projectId: { anyOf: [UUID, { type: 'null' }] },
            who: UUID,
            start: DATE,
            end: DATE,
            label: str(300),
            notes: str(5000),
            jira: str(500),
          },
        },
      },
    },
    async (req) => {
      const b = req.body;
      return db.tx(async (q) => {
        const { rows } = await q.query(
          `INSERT INTO work_items (id, project_id, user_id, start_date, end_date, label, notes, jira, updated_by)
           VALUES (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [b.id || null, b.projectId || null, b.who, b.start, b.end, b.label || '', b.notes || '', b.jira || '', actor(req)],
        );
        const item = mapWorkItem(rows[0]);
        await event(q, req, { entity: 'workItem', entityId: item.id, op: 'create', data: item });
        return item;
      });
    },
  );

  app.patch(
    '/work-items/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['version'],
          properties: { version: VERSION, who: UUID, start: DATE, end: DATE, label: str(300), notes: str(5000), jira: str(500) },
        },
      },
    },
    async (req) => {
      const b = req.body;
      return db.tx(async (q) => {
        const { row, changes } = await updateVersioned(q, {
          table: 'work_items',
          id: req.params.id,
          version: b.version,
          actorId: actor(req),
          map: mapWorkItem,
          sets: { user_id: b.who, start_date: b.start, end_date: b.end, label: b.label, notes: b.notes, jira: b.jira },
        });
        const item = mapWorkItem(row);
        if (changes) await event(q, req, { entity: 'workItem', entityId: item.id, op: 'update', data: item, changes });
        return item;
      });
    },
  );

  app.delete('/work-items/:id', { schema: { params: idParams } }, async (req) => {
    return db.tx(async (q) => {
      const { rows } = await q.query('DELETE FROM work_items WHERE id = $1 RETURNING *', [req.params.id]);
      if (rows[0]) await event(q, req, { entity: 'workItem', entityId: rows[0].id, op: 'delete', data: mapWorkItem(rows[0]) });
      return { ok: true };
    });
  });

  // -------------------------------------------------------------- time off
  app.post(
    '/time-off',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['userId', 'date'],
          properties: { id: UUID, userId: UUID, date: DATE, type: DAY_TYPE, category: CATEGORY, notes: str(2000) },
        },
      },
    },
    async (req) => {
      const b = req.body;
      return db.tx(async (q) => {
        const { rows } = await q.query(
          `INSERT INTO time_off (id, user_id, date, day_type, category, notes, updated_by)
           VALUES (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7) RETURNING *`,
          [b.id || null, b.userId, b.date, b.type || 'full', b.category || 'vacation', b.notes || '', actor(req)],
        );
        const t = mapTimeOff(rows[0]);
        await event(q, req, { entity: 'timeOff', entityId: t.id, op: 'create', data: t });
        return t;
      });
    },
  );

  app.patch(
    '/time-off/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['version'],
          properties: { version: VERSION, date: DATE, type: DAY_TYPE, category: CATEGORY, notes: str(2000) },
        },
      },
    },
    async (req) => {
      const b = req.body;
      return db.tx(async (q) => {
        const { row, changes } = await updateVersioned(q, {
          table: 'time_off',
          id: req.params.id,
          version: b.version,
          actorId: actor(req),
          map: mapTimeOff,
          sets: { date: b.date, day_type: b.type, category: b.category, notes: b.notes },
        });
        const t = mapTimeOff(row);
        if (changes) await event(q, req, { entity: 'timeOff', entityId: t.id, op: 'update', data: t, changes });
        return t;
      });
    },
  );

  app.delete('/time-off/:id', { schema: { params: idParams } }, async (req) => {
    return db.tx(async (q) => {
      const { rows } = await q.query('DELETE FROM time_off WHERE id = $1 RETURNING *', [req.params.id]);
      if (rows[0]) await event(q, req, { entity: 'timeOff', entityId: rows[0].id, op: 'delete', data: mapTimeOff(rows[0]) });
      return { ok: true };
    });
  });

  // ----------------------------------------------------------------- people
  // Admins can add teammates ahead of their first sign-in so work can be
  // assigned to them; everyone else is added automatically when they sign in.
  app.post(
    '/users',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'name'],
          properties: { email: { type: 'string', maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+$' }, name: { type: 'string', minLength: 1, maxLength: 120 } },
        },
      },
    },
    async (req) => {
      requireAdmin(req);
      const email = req.body.email.trim().toLowerCase();
      const domain = email.split('@')[1];
      if (config.allowedDomains.length && !config.allowedDomains.includes(domain)) {
        throw new HttpError(400, `Only ${config.allowedDomains.map((d) => '@' + d).join(', ')} addresses can be added.`);
      }
      return db.tx(async (q) => {
        const { rows } = await q.query('INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *', [email, req.body.name.trim()]);
        const user = mapUser(rows[0]);
        await event(q, req, { entity: 'user', entityId: user.id, op: 'create', data: user });
        return user;
      });
    },
  );

  app.patch(
    '/users/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, active: { type: 'boolean' }, isAdmin: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const self = req.params.id === req.user.id;
      const b = req.body;
      if (!req.user.isAdmin && !(self && b.active === undefined && b.isAdmin === undefined)) {
        throw new HttpError(403, 'Only admins can change other people.');
      }
      if (self && (b.active === false || b.isAdmin === false)) {
        throw new HttpError(400, 'You cannot deactivate yourself or remove your own admin access.');
      }
      return db.tx(async (q) => {
        const cur = (await q.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
        if (!cur) throw new HttpError(404, 'User not found.');
        const { rows } = await q.query(
          `UPDATE users SET name = coalesce($2, name), active = coalesce($3, active), is_admin = coalesce($4, is_admin)
            WHERE id = $1 RETURNING *`,
          [cur.id, b.name?.trim() ?? null, b.active ?? null, b.isAdmin ?? null],
        );
        if (b.active === false) await q.query('DELETE FROM sessions WHERE user_id = $1', [cur.id]);
        const user = mapUser(rows[0]);
        await event(q, req, { entity: 'user', entityId: user.id, op: 'update', data: user });
        return user;
      });
    },
  );

  // --------------------------------------------------------------- settings
  app.put(
    '/settings/sprint',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['anchorDate', 'anchorNumber'],
          properties: { anchorDate: DATE, anchorNumber: { type: 'integer', minimum: 0, maximum: 100000 } },
        },
      },
    },
    async (req) => {
      requireAdmin(req);
      const d = new Date(req.body.anchorDate + 'T00:00:00Z');
      if (Number.isNaN(d.getTime()) || d.getUTCDay() !== 1) throw new HttpError(400, 'The sprint start must be a Monday.');
      return db.tx(async (q) => {
        await q.query(`INSERT INTO settings (key, value) VALUES ('sprint', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [
          JSON.stringify(req.body),
        ]);
        const settings = await loadSettings(q);
        await event(q, req, { entity: 'settings', entityId: 'sprint', op: 'update', data: settings });
        return settings;
      });
    },
  );

  // --------------------------------------------------------------- activity
  app.get(
    '/activity',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        },
      },
    },
    async (req) => {
      const { before, limit } = req.query;
      const { rows } = await db.query(
        `SELECT id, at, actor_id, entity, entity_id, op, data, changes FROM events
          WHERE entity <> 'projectOrder' AND ($1::bigint IS NULL OR id < $1)
          ORDER BY id DESC LIMIT $2`,
        [before ?? null, limit],
      );
      return rows.map((r) => ({
        id: r.id,
        at: r.at,
        actorId: r.actor_id,
        entity: r.entity,
        entityId: r.entity_id,
        op: r.op,
        data: r.data,
        changes: r.changes,
      }));
    },
  );

  // ------------------------------------------------------------------- jira
  app.get(
    '/jira/issue/:key',
    { schema: { params: { type: 'object', required: ['key'], properties: { key: { type: 'string', pattern: '^[A-Z][A-Z0-9]+-\\d+$' } } } } },
    async (req) => {
      const issue = await fetchJiraIssue(config.jira, req.params.key);
      // Map the assignee to a board member by email when we can.
      let ownerId = null;
      if (issue.assigneeEmail) {
        const { rows } = await db.query('SELECT id FROM users WHERE email = $1 AND active', [issue.assigneeEmail.toLowerCase()]);
        ownerId = rows[0]?.id || null;
      }
      return { ...issue, ownerId };
    },
  );

}
