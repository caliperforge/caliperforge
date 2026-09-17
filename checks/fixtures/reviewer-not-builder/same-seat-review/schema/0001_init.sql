CREATE TABLE runs (
  id            INTEGER PRIMARY KEY,
  plan          INTEGER NOT NULL,
  step          INTEGER NOT NULL,
  seat          TEXT NOT NULL,
  rule_hash     TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  effort        TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  cache_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  seconds       REAL NOT NULL,
  exit          INTEGER NOT NULL
);
CREATE TRIGGER runs_reviewer_not_builder BEFORE INSERT ON runs
WHEN NEW.step = 5 AND EXISTS (
  SELECT 1 FROM runs r WHERE r.plan = NEW.plan AND r.seat = NEW.seat AND r.step IN (2, 4)
)
BEGIN SELECT RAISE(ABORT, 'reviewer != builder'); END;
CREATE TRIGGER runs_reviewer_not_builder_update BEFORE UPDATE OF seat, step, plan ON runs
WHEN NEW.step IN (4, 5) AND EXISTS (
  SELECT 1 FROM runs r WHERE r.plan = NEW.plan AND r.seat = NEW.seat AND r.id <> NEW.id
    AND (r.step = 2 OR (NEW.step = 5 AND r.step = 4))
)
BEGIN SELECT RAISE(ABORT, 'reviewer != builder'); END;
