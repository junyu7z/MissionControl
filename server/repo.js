// Row <-> API shape mapping and shared queries.
// API objects use the field names the board UI already works with.

export class HttpError extends Error {
  constructor(statusCode, message, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

export const mapUser = (r) => ({
  id: r.id,
  email: r.email,
  name: r.name,
  avatarUrl: r.avatar_url || null,
  active: r.active,
  isAdmin: r.is_admin,
});

export const mapMember = (r) => ({ id: r.id, userId: r.user_id, role: r.role });

export const mapProject = (r, members = []) => ({
  id: r.id,
  title: r.title,
  key: r.jira_key,
  status: r.status,
  tint: r.tint,
  description: r.description,
  startDate: { mode: r.start_mode, date: r.start_date || null },
  endDate: { mode: r.end_mode, date: r.end_date || null },
  sortOrder: r.sort_order,
  version: r.version,
  members,
});

export const mapMilestone = (r) => ({
  id: r.id,
  projectId: r.project_id,
  date: r.date,
  title: r.title,
  desc: r.description,
  type: r.type,
  version: r.version,
});

export const mapWorkItem = (r) => ({
  id: r.id,
  projectId: r.project_id,
  who: r.user_id,
  start: r.start_date,
  end: r.end_date,
  label: r.label,
  notes: r.notes,
  jira: r.jira,
  version: r.version,
});

export const mapTimeOff = (r) => ({
  id: r.id,
  userId: r.user_id,
  date: r.date,
  type: r.day_type,
  category: r.category,
  notes: r.notes,
  version: r.version,
});

export async function loadMembers(q, projectId) {
  const { rows } = await q.query('SELECT * FROM project_members WHERE project_id = $1 ORDER BY sort_order, id', [projectId]);
  return rows.map(mapMember);
}

export async function loadProject(q, id) {
  const { rows } = await q.query('SELECT * FROM projects WHERE id = $1', [id]);
  if (!rows[0]) return null;
  return mapProject(rows[0], await loadMembers(q, id));
}

export async function loadSettings(q) {
  const { rows } = await q.query('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Everything the board needs, in one round trip. */
export async function loadState(db) {
  // Read everything from one snapshot so lastEventId matches the data exactly.
  return db.tx(async (q) => {
    await q.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const [users, projects, members, milestones, workItems, timeOff, last, settings] = await Promise.all([
      q.query('SELECT * FROM users ORDER BY name'),
      q.query('SELECT * FROM projects ORDER BY sort_order, created_at'),
      q.query('SELECT * FROM project_members ORDER BY sort_order, id'),
      q.query('SELECT * FROM milestones ORDER BY date, created_at'),
      q.query('SELECT * FROM work_items ORDER BY start_date, created_at'),
      q.query('SELECT * FROM time_off ORDER BY date'),
      q.query('SELECT coalesce(max(id), 0) AS id, max(at) AS at FROM events'),
      loadSettings(q),
    ]);
    const membersByProject = new Map();
    for (const m of members.rows) {
      if (!membersByProject.has(m.project_id)) membersByProject.set(m.project_id, []);
      membersByProject.get(m.project_id).push(mapMember(m));
    }
    const lastChange = last.rows[0].id
      ? (await q.query('SELECT at, actor_id FROM events WHERE id = $1', [last.rows[0].id])).rows[0]
      : null;
    return {
      users: users.rows.map(mapUser),
      projects: projects.rows.map((p) => mapProject(p, membersByProject.get(p.id) || [])),
      milestones: milestones.rows.map(mapMilestone),
      workItems: workItems.rows.map(mapWorkItem),
      timeOff: timeOff.rows.map(mapTimeOff),
      settings,
      lastEventId: last.rows[0].id,
      lastChange: lastChange ? { at: lastChange.at, actorId: lastChange.actor_id } : null,
    };
  });
}

/**
 * Optimistic-concurrency update of one row.
 *  - 404 if the row is gone, 409 (with the current row) if `version` is stale.
 *  - `sets` maps column -> new value; only real changes are written.
 * Returns { row, changes } where changes = { column: [before, after] }, or
 * { row, changes: null } when nothing actually changed.
 */
export async function updateVersioned(q, { table, id, version, sets, actorId, map }) {
  const cur = (await q.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!cur) throw new HttpError(404, 'This item no longer exists — it may have been deleted by someone else.');
  if (cur.version !== version) {
    throw new HttpError(409, 'Someone else changed this item since you loaded it.', { current: map(cur) });
  }
  const changes = {};
  const cols = [];
  const params = [id];
  for (const [col, value] of Object.entries(sets)) {
    if (value === undefined) continue;
    if (normalize(cur[col]) === normalize(value)) continue;
    changes[col] = [cur[col], value];
    params.push(value);
    cols.push(`${col} = $${params.length}`);
  }
  if (cols.length === 0) return { row: cur, changes: null };
  params.push(actorId);
  const hasUpdatedBy = 'updated_by' in cur;
  const { rows } = await q.query(
    `UPDATE ${table} SET ${cols.join(', ')}, version = version + 1, updated_at = now()${hasUpdatedBy ? `, updated_by = $${params.length}` : ''}
      WHERE id = $1 RETURNING *`,
    hasUpdatedBy ? params : params.slice(0, -1),
  );
  return { row: rows[0], changes };
}

const normalize = (v) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
