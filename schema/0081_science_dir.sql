-- `science.dir` holds a path, so it joins `hq.path`, `comms.site_dir` and `comms.story_dir` outside the settings value check.
-- legacy_alter_table keeps the rename from re-resolving the views that read `settings`.
PRAGMA legacy_alter_table = ON;

CREATE TABLE settings_next (
  key         TEXT PRIMARY KEY CHECK (key GLOB '[a-z][a-z0-9_.]*'),
  value       TEXT NOT NULL CHECK (key IN ('hq.path', 'comms.site_dir', 'comms.story_dir', 'science.dir') OR (value <> '' AND value NOT GLOB '*[^-0-9a-z_.]*')),
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
  ('science.dir', '~/Documents/Claude/Projects/HQ/science', 'ceo', 'ruling', 'ceo-2026-10-03', '2026-10-03');
