CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  name TEXT,
  description TEXT,
  preference_rating INTEGER NOT NULL DEFAULT 0 CHECK (preference_rating BETWEEN -2 AND 2),
  connections TEXT,
  ipo_status TEXT,
  ai_proof_score REAL,
  ai_proof_notes TEXT,
  wlb_score REAL,
  wlb_notes TEXT,
  last_enriched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'todo', 'applied', 'interviewing', 'success', 'denied', 'skip')),
  status_changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reapply_after TEXT,
  salary_min INTEGER,
  salary_max INTEGER,
  equity TEXT,
  remote_eu TEXT CHECK (remote_eu IS NULL OR remote_eu IN ('yes', 'no', 'unknown')),
  priority_score REAL,
  closed_at TEXT,
  last_checked_at TEXT,
  last_enriched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Deliberately not a DB-level UNIQUE(company_id, url): duplicate-role
-- detection is a --force-overridable application-layer policy (normalized
-- URL match), not a hard data-integrity invariant a DB constraint could
-- enforce and still let --force bypass.
-- Covers both (company_id, url) lookups and plain company_id-only lookups
-- (company_id is the leading column), so a separate single-column
-- company_id index would be redundant.
CREATE INDEX idx_roles_company_url ON roles (company_id, url);
CREATE INDEX idx_roles_status ON roles (status);

CREATE TABLE role_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  context TEXT
);

CREATE INDEX idx_role_status_history_role_id ON role_status_history (role_id);

-- Named role_references (not "references") since REFERENCES is a SQL keyword
-- and quoting it everywhere in application code is an easy footgun to forget.
CREATE TABLE role_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('cv', 'application_answers', 'cover_letter', 'other')),
  file_path TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_role_references_role_id ON role_references (role_id);

CREATE TABLE tips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('company', 'role')),
  company_id INTEGER REFERENCES companies (id) ON DELETE CASCADE,
  role_id INTEGER REFERENCES roles (id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (scope = 'company' AND company_id IS NOT NULL AND role_id IS NULL)
    OR (scope = 'role' AND role_id IS NOT NULL)
  )
);

CREATE INDEX idx_tips_company_id ON tips (company_id);
CREATE INDEX idx_tips_role_id ON tips (role_id);

CREATE TABLE recruiter_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  recruiter_name TEXT NOT NULL,
  contacted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  channel TEXT,
  link TEXT,
  notes TEXT,
  responded_at TEXT
);

CREATE INDEX idx_recruiter_contacts_role_id ON recruiter_contacts (role_id);
CREATE INDEX idx_recruiter_contacts_overdue ON recruiter_contacts (responded_at, contacted_at);

CREATE TABLE interview_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  stage TEXT,
  notes TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_interview_notes_role_id ON interview_notes (role_id);

-- Immutable audit trail: every action and periodic-job run gets a timestamp
-- and free-form context here, per IDEA.md's debugging requirement.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  type TEXT NOT NULL,
  context TEXT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_events_entity ON events (entity_type, entity_id);

-- The mutable "inbox" layer on top of the immutable events log.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  channel TEXT,
  message TEXT NOT NULL,
  delivered_at TEXT,
  acknowledged_at TEXT
);

CREATE INDEX idx_notifications_unacknowledged ON notifications (acknowledged_at);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL CHECK (topic IN ('enrichment', 'notification', 'refresh', 'discovery', 'tips')),
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Matches the claim query worker-pool.ts will use: find the oldest
-- available pending job for a topic, highest priority first.
CREATE INDEX idx_jobs_claim ON jobs (topic, status, available_at, priority);
