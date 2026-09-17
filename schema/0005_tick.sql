PRAGMA foreign_keys = OFF;

ALTER TABLE plans ADD COLUMN step INTEGER NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 9);
ALTER TABLE plans ADD COLUMN retries INTEGER NOT NULL DEFAULT 0 CHECK (retries BETWEEN 0 AND 1);

CREATE TABLE runs_new (
  id            INTEGER PRIMARY KEY,
  plan          INTEGER NOT NULL REFERENCES plans(id),
  step          INTEGER NOT NULL CHECK (step BETWEEN 0 AND 9),
  seat          TEXT NOT NULL REFERENCES rules(id),
  rule_hash     TEXT NOT NULL CHECK (length(rule_hash) = 64 AND rule_hash NOT GLOB '*[^0-9a-f]*'),
  provider      TEXT NOT NULL CHECK (provider IN ('claude-agent-sdk', 'anthropic-api', 'deepseek')),
  model         TEXT NOT NULL,
  effort        TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  input_tokens  INTEGER NOT NULL CHECK (input_tokens >= 0),
  cache_tokens  INTEGER NOT NULL CHECK (cache_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  seconds       REAL NOT NULL CHECK (seconds >= 0),
  exit          INTEGER NOT NULL CHECK (exit BETWEEN 0 AND 255),
  at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
INSERT INTO runs_new (id, plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit)
  SELECT id, plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;

CREATE TRIGGER runs_reviewer_not_builder BEFORE INSERT ON runs
WHEN NEW.step IN (4, 5) AND EXISTS (
  SELECT 1 FROM runs r WHERE r.plan = NEW.plan AND r.seat = NEW.seat
    AND (r.step = 2 OR (NEW.step = 5 AND r.step = 4))
)
BEGIN SELECT RAISE(ABORT, 'reviewer != builder'); END;

CREATE TRIGGER runs_reviewer_not_builder_update BEFORE UPDATE OF seat, step, plan ON runs
WHEN NEW.step IN (4, 5) AND EXISTS (
  SELECT 1 FROM runs r WHERE r.plan = NEW.plan AND r.seat = NEW.seat AND r.id <> NEW.id
    AND (r.step = 2 OR (NEW.step = 5 AND r.step = 4))
)
BEGIN SELECT RAISE(ABORT, 'reviewer != builder'); END;

INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no, supersedes) VALUES
  ('sequencer.tick', 'one_pipe_one_plan_one_step', 'ruling', 'buildmap-rev6-decisions', 'ceo', '2026-09-17', 9, NULL),
  ('sequencer.retry', 'back_one_step_once_then_blocked_on_ceo', 'ruling', 'buildmap-rev4-closed', 'ceo', '2026-09-17', 9, NULL),
  ('queue.evidence_age', 'accounts_row_missing_or_older_than_30d_refuses', 'ruling', 'buildmap-rev6-steps', 'ceo', '2026-09-17', 9, NULL),
  ('queue.cold_pulse', 'parks_never_refuses', 'ruling', 'buildmap-rev6-decisions', 'ceo', '2026-09-17', 9, NULL),
  ('runs.at', 'clock_on_every_run_row', 'ruling', 'buildmap-rev6-measurement', 'ceo', '2026-09-17', 9, NULL);

PRAGMA foreign_keys = ON;
