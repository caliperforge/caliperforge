PRAGMA foreign_keys = OFF;

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
  exit          INTEGER NOT NULL CHECK (exit BETWEEN 0 AND 255)
);
INSERT INTO runs_new (id, plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit)
  SELECT id, plan, step, seat, '0000000000000000000000000000000000000000000000000000000000000000',
         provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit FROM runs;
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
  ('seat.write_paths', 'runner_refuses_write_outside_manifest', 'ruling', 'buildmap-rev6-decisions', 'ceo', '2026-09-16', 7, NULL),
  ('runs.rule_hash', 'roster_digest_as_sent', 'ruling', 'buildmap-rev6-laws', 'ceo', '2026-09-16', 7, NULL);

PRAGMA foreign_keys = ON;
