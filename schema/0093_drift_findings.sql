CREATE TABLE drift_findings (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  state     TEXT NOT NULL CHECK (state IN ('off', 'silent', 'stale', 'seen')),
  detail    TEXT NOT NULL,
  found_at  TEXT NOT NULL,
  outcome   TEXT CHECK (outcome IN ('fixed', 'covered', 'retire', 'defect')),
  why       TEXT,
  ref       TEXT,
  closed_at TEXT,
  CHECK ((outcome IS NULL) = (closed_at IS NULL)),
  CHECK ((why IS NULL) = (closed_at IS NULL))
);

CREATE UNIQUE INDEX drift_findings_open ON drift_findings (name) WHERE closed_at IS NULL;
