-- `comms.site_dir` holds a path, or '' for none, so it joins `hq.path` outside the settings value check.
-- legacy_alter_table keeps the rename from re-resolving the views that read `settings`.
PRAGMA legacy_alter_table = ON;

CREATE TABLE settings_next (
  key         TEXT PRIMARY KEY CHECK (key GLOB '[a-z][a-z0-9_.]*'),
  value       TEXT NOT NULL CHECK (key IN ('hq.path', 'comms.site_dir') OR (value <> '' AND value NOT GLOB '*[^-0-9a-z_.]*')),
  who         TEXT NOT NULL CHECK (who IN ('ceo', 'pr')),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('rail', 'ruling', 'incident')),
  origin_ref  TEXT NOT NULL,
  set_at      TEXT NOT NULL CHECK (set_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
INSERT INTO settings_next SELECT key, value, who, origin_kind, origin_ref, set_at FROM settings;
DROP TABLE settings;
ALTER TABLE settings_next RENAME TO settings;

PRAGMA legacy_alter_table = OFF;

INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at) VALUES
  ('comms.site_dir', '', 'ceo', 'ruling', 'ceo-2026-09-27', '2026-09-27');

-- `id` is the plan's id with no foreign key, because dropPlan deletes plans.
CREATE TABLE desk_posts (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  dest         TEXT NOT NULL CHECK (dest IN ('site', 'substack', 'note')),
  status       TEXT NOT NULL CHECK (status IN ('proof', 'approved', 'changes', 'published')),
  title        TEXT NOT NULL,
  dek          TEXT NOT NULL,
  body         TEXT NOT NULL,
  edited_title TEXT,
  edited_dek   TEXT,
  edited_body  TEXT,
  note         TEXT,
  sources      TEXT NOT NULL,
  checks       TEXT NOT NULL,
  work_date    TEXT NOT NULL,
  written_date TEXT NOT NULL,
  "order"      INTEGER
);

CREATE TABLE desk_learnings (
  date    TEXT PRIMARY KEY,
  numbers TEXT,
  items   TEXT,
  sources TEXT
);
