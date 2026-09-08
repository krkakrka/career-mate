-- migration-lock: foreign-keys-off
-- roles.company_id becomes nullable: `cm roles add <url>` without --company
-- creates the role immediately (non-blocking) with its company unresolved;
-- the structural-fetch enrichment job extracts and attaches the real
-- company once it fetches the role page. SQLite has no ALTER COLUMN, so
-- this recreates the table per SQLite's documented procedure. The leading
-- marker comment above tells migrate.ts to run this with
-- PRAGMA foreign_keys=OFF — role_status_history, role_references, tips,
-- recruiter_contacts, and interview_notes all have ON DELETE CASCADE
-- foreign keys pointing at roles(id), and with foreign_keys=ON, DROP TABLE
-- roles would perform an implicit cascading DELETE across all of them
-- before the drop, wiping unrelated data instead of just restructuring
-- roles.

CREATE TABLE roles_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies (id) ON DELETE CASCADE,
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

INSERT INTO roles_new SELECT * FROM roles;

DROP TABLE roles;

ALTER TABLE roles_new RENAME TO roles;

CREATE INDEX idx_roles_company_url ON roles (company_id, url);
CREATE INDEX idx_roles_status ON roles (status);
