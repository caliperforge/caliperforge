-- Every run row points at the transcript the provider wrote for it. The column
-- is NOT NULL: a run with no transcript is a run nobody can audit.
PRAGMA foreign_keys = OFF;

CREATE TABLE runs_new (
  id              INTEGER PRIMARY KEY,
  plan            INTEGER NOT NULL REFERENCES plans(id),
  step            INTEGER NOT NULL CHECK (step BETWEEN 0 AND 9),
  seat            TEXT NOT NULL REFERENCES rules(id),
  rule_hash       TEXT NOT NULL CHECK (length(rule_hash) = 64 AND rule_hash NOT GLOB '*[^0-9a-f]*'),
  provider        TEXT NOT NULL CHECK (provider IN ('claude-agent-sdk', 'anthropic-api', 'deepseek')),
  model           TEXT NOT NULL,
  effort          TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  input_tokens    INTEGER NOT NULL CHECK (input_tokens >= 0),
  cache_tokens    INTEGER NOT NULL CHECK (cache_tokens >= 0),
  output_tokens   INTEGER NOT NULL CHECK (output_tokens >= 0),
  seconds         REAL NOT NULL CHECK (seconds >= 0),
  exit            INTEGER NOT NULL CHECK (exit BETWEEN 0 AND 255),
  at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  transcript_path TEXT NOT NULL CHECK (transcript_path GLOB '*.transcript.jsonl')
);

-- Rows written before this migration get the path their transcript would have
-- had. The convention is deterministic; for those rows the file is absent.
INSERT INTO runs_new (id, plan, step, seat, rule_hash, provider, model, effort,
    input_tokens, cache_tokens, output_tokens, seconds, exit, at, transcript_path)
  SELECT id, plan, step, seat, rule_hash, provider, model, effort,
         input_tokens, cache_tokens, output_tokens, seconds, exit, at,
         '.cf/work/' || plan || '/run-' || id || '.transcript.jsonl'
    FROM runs;
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
  ('runs.transcript_path', 'every_run_points_at_its_transcript', 'ruling', 'buildmap-rev6-measurement', 'ceo', '2026-09-17', 9, NULL);

PRAGMA foreign_keys = ON;
