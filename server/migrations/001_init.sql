-- Initial schema for Mission Control.
--
-- Concurrency model: every editable row carries a `version` that is bumped on
-- each update. Clients send the version they last saw; an UPDATE that does not
-- match is rejected (HTTP 409), so nobody silently overwrites a change they
-- have not seen yet.
--
-- Calendar dates are stored as `date` (no time, no timezone) so a time-off day
-- or milestone is the same day for teammates in every timezone.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL CHECK (email = lower(email)),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  avatar_url    text,
  active        boolean NOT NULL DEFAULT true,
  is_admin      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,           -- sha256 of the cookie value; the raw token is never stored
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
-- Sprint numbering: the anchor Monday is day 0 of sprint N; sprints are two work weeks.
INSERT INTO settings (key, value) VALUES
  ('sprint', '{"anchorDate": "2026-04-27", "anchorNumber": 29}');

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL CHECK (length(title) <= 200),
  jira_key    text NOT NULL DEFAULT '' CHECK (length(jira_key) <= 500),
  status      text NOT NULL DEFAULT 'On Track'
              CHECK (status IN ('On Track', 'At Risk', 'Off Track', 'Archived')),
  tint        text NOT NULL DEFAULT 'indigo'
              CHECK (tint IN ('indigo','blue','cyan','teal','green','yellow','orange','rose','pink','purple')),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  start_mode  text NOT NULL DEFAULT 'undefined' CHECK (start_mode IN ('undefined', 'milestone', 'date')),
  start_date  date,
  end_mode    text NOT NULL DEFAULT 'undefined' CHECK (end_mode IN ('undefined', 'milestone', 'date')),
  end_date    date,
  sort_order  double precision NOT NULL DEFAULT 0,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users (id) ON DELETE SET NULL
);

-- Ordered project membership. The first row (lowest sort_order) is the Owner / PM.
CREATE TABLE project_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id),
  role       text NOT NULL DEFAULT 'Member' CHECK (length(role) <= 60),
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (project_id, user_id)
);

CREATE TABLE milestones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  date        date NOT NULL,
  title       text NOT NULL DEFAULT '' CHECK (length(title) <= 200),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  type        text NOT NULL DEFAULT 'Milestone'
              CHECK (type IN ('Milestone', 'Kickoff', 'Release', 'Review', 'Beta', 'Launch')),
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX milestones_project_idx ON milestones (project_id);

-- Work items. project_id NULL = the person's "Others" row (work not tracked by a board project).
CREATE TABLE work_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id),
  start_date date NOT NULL,
  end_date   date NOT NULL,
  label      text NOT NULL DEFAULT '' CHECK (length(label) <= 300),
  notes      text NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
  jira       text NOT NULL DEFAULT '' CHECK (length(jira) <= 500),
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  CHECK (end_date >= start_date)
);
CREATE INDEX work_items_project_idx ON work_items (project_id);
CREATE INDEX work_items_user_idx ON work_items (user_id);

-- One time-off entry per person per day.
CREATE TABLE time_off (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id),
  date       date NOT NULL,
  day_type   text NOT NULL DEFAULT 'full' CHECK (day_type IN ('full', 'am', 'pm')),
  category   text NOT NULL DEFAULT 'vacation'
             CHECK (category IN ('vacation','sick','holiday','personal','bereavement','jury','other')),
  notes      text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  UNIQUE (user_id, date)
);

-- Append-only change log. Doubles as the realtime feed: each committed change
-- writes one row, then NOTIFYs its id so every app instance can push it to the
-- browsers connected to it. Clients that reconnect replay rows after the last
-- id they saw. Ids are assigned under an advisory lock so they are in commit order.
CREATE TABLE events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  client_id  text,
  entity     text NOT NULL,
  entity_id  text,
  op         text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  changes    jsonb
);
CREATE INDEX events_at_idx ON events (at);
