-- `kind` has no CHECK: a later writer adds its own kinds without rebuilding the table.
CREATE TABLE events (
  id       INTEGER PRIMARY KEY,
  plan     INTEGER NOT NULL REFERENCES plans(id),
  at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind     TEXT NOT NULL,
  actor    TEXT NOT NULL,
  outcome  TEXT NOT NULL CHECK (outcome IN ('pass', 'refuse', 'needs_ceo')),
  message  TEXT NOT NULL,
  pointer  TEXT,
  run      INTEGER REFERENCES runs(id)
);

CREATE INDEX events_by_plan ON events (plan, id);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
