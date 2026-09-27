CREATE TABLE size_limits (
  repo        TEXT PRIMARY KEY CHECK (repo GLOB '*/*'),
  lines       INTEGER NOT NULL CHECK (typeof(lines) = 'integer' AND lines > 0),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('rail', 'ruling', 'incident')),
  origin_ref  TEXT NOT NULL,
  set_at      TEXT NOT NULL CHECK (set_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);

INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at) VALUES
  ('card.size_limit', '400', 'pr', 'ruling', 'kernel-issue-392', '2026-09-26');
