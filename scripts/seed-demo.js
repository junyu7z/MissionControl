// Loads the original prototype's demo board into the database.
// For local development and staging only — refuses to run in production.
//
//   PGLITE_DIR=.data/dev-db npm run seed:demo
//
// People get placeholder @example.com addresses; with DEV_LOGIN=1 you can sign
// in as any of them from the login page.

import { loadConfig } from '../server/config.js';
import { createDb } from '../server/db.js';

const env = { ...process.env, DEV_LOGIN: process.env.DEV_LOGIN || '1' };
if (env.NODE_ENV === 'production') {
  console.error('Refusing to load demo data into a production database.');
  process.exit(1);
}
const config = loadConfig(env);
const db = await createDb(config);

const PEOPLE = ['Tim Rice', 'Junyu Zhang', 'Xiangtao Zhao', 'Haowei Wang', 'Tony Duan', 'Zeyi Jiang', 'Muyun Xiao', 'Boyuan Shi', 'Pei'];
const email = (name) => name.toLowerCase().replace(/\s+/g, '.') + '@example.com';
const d = (month, day) => `2026-${String(['APR', 'MAY'].indexOf(month) + 4).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const LEAVES = {
  'Tim Rice': [[d('MAY', 15), 'full']],
  'Junyu Zhang': [[d('MAY', 7), 'pm']],
  'Xiangtao Zhao': [[d('MAY', 8), 'full']],
  'Zeyi Jiang': [[d('MAY', 12), 'full'], [d('MAY', 13), 'full']],
  'Boyuan Shi': [[d('MAY', 6), 'am']],
};
const OTHERS = {
  'Tim Rice': [d('MAY', 6), d('MAY', 8), '1:1s & hiring loop'],
  'Junyu Zhang': [d('MAY', 14), d('MAY', 16), 'Design review rotation'],
  'Xiangtao Zhao': [d('MAY', 19), d('MAY', 22), 'Infra on-call'],
  'Tony Duan': [d('MAY', 7), d('MAY', 9), 'Recruiting interviews'],
  'Zeyi Jiang': [d('MAY', 15), d('MAY', 18), 'Brand guideline refresh'],
  'Muyun Xiao': [d('MAY', 7), d('MAY', 10), 'Roadmap planning'],
  'Boyuan Shi': [d('MAY', 7), d('MAY', 12), 'Internal tools cleanup'],
  Pei: [d('MAY', 13), d('MAY', 15), 'Customer support escalations'],
  'Haowei Wang': [d('MAY', 5), d('MAY', 9), 'Engineering platform support'],
};
const PROJECTS = [
  {
    title: 'Proposal V3', key: 'ARC-2837', status: 'On Track', tint: 'indigo',
    members: [['Tim Rice', 'Owner / PM'], ['Junyu Zhang', 'Designer'], ['Xiangtao Zhao', 'Front End']],
    milestones: [
      [d('MAY', 4), 'MVP1 (Beta) Release', 'Closed beta to 5 design partners', 'Beta'],
      [d('MAY', 15), 'General Access', 'Open to all paying customers', 'Launch'],
    ],
    items: [
      ['Tim Rice', d('MAY', 4), d('MAY', 12), 'Beta partner interviews', '5 calls scheduled, focus on pricing flow'],
      ['Junyu Zhang', d('APR', 29), d('MAY', 4), 'Editor v3 wireframes', 'Iterate on side-panel layout'],
      ['Junyu Zhang', d('MAY', 4), d('MAY', 7), 'Beta release polish', ''],
      ['Xiangtao Zhao', d('APR', 28), d('MAY', 4), 'Canvas refactor', 'Switch off legacy DOM renderer'],
      ['Xiangtao Zhao', d('MAY', 7), d('MAY', 14), 'Autosave + version history', 'Hook into ARC-2901 backend'],
    ],
  },
  {
    title: 'Proposal Template Paragraph Block', key: 'ARC-3085', status: 'At Risk', tint: 'rose',
    members: [['Tim Rice', 'Owner / PM'], ['Tony Duan', 'Designer'], ['Zeyi Jiang', 'Designer'], ['Xiangtao Zhao', 'Front End']],
    milestones: [
      [d('APR', 30), 'Spec freeze', 'Block taxonomy + props locked', 'Review'],
      [d('MAY', 8), 'Internal demo', 'Sign-off from leadership', 'Release'],
    ],
    items: [
      ['Tim Rice', d('APR', 30), d('MAY', 4), 'Stakeholder review', 'Walk through scope w/ Sales'],
      ['Tony Duan', d('APR', 24), d('APR', 30), 'Block UX explorations', '3 directions for layout grid'],
      ['Tony Duan', d('MAY', 4), d('MAY', 7), 'Iterate on feedback', ''],
      ['Zeyi Jiang', d('MAY', 1), d('MAY', 14), 'Tokens + spacing system', 'Align with design-system v1.4'],
      ['Xiangtao Zhao', d('APR', 30), d('MAY', 7), 'Block API scaffolding', ''],
      ['Xiangtao Zhao', d('MAY', 8), d('MAY', 14), 'Editor toolbar wiring', ''],
    ],
  },
  {
    title: 'Fence AI BIM', key: 'ARC-2675', status: 'Off Track', tint: 'yellow',
    members: [['Muyun Xiao', 'Owner / PM'], ['Junyu Zhang', 'Designer']],
    milestones: [
      [d('MAY', 4), 'Kick Off', 'Project charter + scope review', 'Kickoff'],
      [d('MAY', 11), 'Architecture review', 'Pipeline + data flow walkthrough', 'Review'],
    ],
    items: [
      ['Muyun Xiao', d('APR', 23), d('APR', 30), 'Vendor evaluation', 'Compare 3 ML providers'],
      ['Muyun Xiao', d('APR', 30), d('MAY', 4), 'Kickoff prep + scoping doc', ''],
      ['Junyu Zhang', d('MAY', 5), d('MAY', 11), 'Concept sketches', ''],
      ['Junyu Zhang', d('MAY', 11), d('MAY', 13), 'Ideation session', 'Whiteboard w/ engineering'],
      ['Junyu Zhang', d('MAY', 13), d('MAY', 25), 'Detail design', ''],
    ],
  },
  {
    title: 'Parametric Room', key: 'ARC-2940', status: 'On Track', tint: 'teal',
    members: [['Boyuan Shi', 'Owner / PM']],
    milestones: [
      [d('APR', 30), 'Research wrap-up', 'Pick parametric approach', 'Review'],
      [d('MAY', 18), 'Engineering kickoff', 'Hand-off to dev', 'Kickoff'],
    ],
    items: [
      ['Boyuan Shi', d('APR', 27), d('APR', 30), 'Comparative research', 'Survey existing room editors'],
      ['Boyuan Shi', d('MAY', 18), d('MAY', 22), 'Kickoff prep + tech spec', ''],
    ],
  },
  {
    title: 'Commercial Fence AI', key: 'ARC-1380', status: 'On Track', tint: 'blue',
    members: [['Pei', 'Owner / PM']],
    milestones: [[d('MAY', 11), 'Kick Off', 'Scope, partners, success metrics', 'Kickoff']],
    items: [
      ['Pei', d('MAY', 5), d('MAY', 8), 'Kickoff agenda + invites', ''],
      ['Pei', d('MAY', 11), d('MAY', 12), 'Kickoff session', ''],
    ],
  },
];

await db.tx(async (q) => {
  const { rows: existing } = await q.query('SELECT count(*)::int AS n FROM projects');
  if (existing[0].n > 0) {
    console.log('Projects already exist — skipping demo seed.');
    return;
  }
  const ids = {};
  for (const [i, name] of PEOPLE.entries()) {
    const { rows } = await q.query(
      `INSERT INTO users (email, name, is_admin) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [email(name), name, i < 2],
    );
    ids[name] = rows[0].id;
  }
  for (const [name, leaves] of Object.entries(LEAVES)) {
    for (const [date, type] of leaves) {
      await q.query('INSERT INTO time_off (user_id, date, day_type) VALUES ($1, $2, $3)', [ids[name], date, type]);
    }
  }
  for (const [name, [start, end, label]] of Object.entries(OTHERS)) {
    await q.query('INSERT INTO work_items (user_id, start_date, end_date, label) VALUES ($1, $2, $3, $4)', [ids[name], start, end, label]);
  }
  for (const [order, p] of PROJECTS.entries()) {
    const { rows } = await q.query(
      `INSERT INTO projects (title, jira_key, status, tint, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [p.title, p.key, p.status, p.tint, order],
    );
    const pid = rows[0].id;
    for (const [i, [name, role]] of p.members.entries()) {
      await q.query('INSERT INTO project_members (project_id, user_id, role, sort_order) VALUES ($1, $2, $3, $4)', [pid, ids[name], role, i]);
    }
    for (const [date, title, desc, type] of p.milestones) {
      await q.query('INSERT INTO milestones (project_id, date, title, description, type) VALUES ($1, $2, $3, $4, $5)', [pid, date, title, desc, type]);
    }
    for (const [name, start, end, label, notes] of p.items) {
      await q.query(
        'INSERT INTO work_items (project_id, user_id, start_date, end_date, label, notes) VALUES ($1, $2, $3, $4, $5, $6)',
        [pid, ids[name], start, end, label, notes],
      );
    }
  }
  console.log(`Seeded ${PEOPLE.length} people and ${PROJECTS.length} projects.`);
});
await db.close();
