-- `kind` has no CHECK: a later writer adds its own kinds without rebuilding the table.
CREATE TABLE events_new (
  id       INTEGER PRIMARY KEY,
  plan     INTEGER REFERENCES plans(id),
  at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind     TEXT NOT NULL,
  actor    TEXT NOT NULL,
  outcome  TEXT NOT NULL CHECK (outcome IN ('pass', 'refuse', 'needs_ceo')),
  message  TEXT NOT NULL,
  pointer  TEXT,
  run      INTEGER REFERENCES runs(id)
);
INSERT INTO events_new SELECT * FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX events_by_plan ON events (plan, id);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
