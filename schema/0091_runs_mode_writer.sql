-- legacy_alter_table keeps the rename from re-resolving the views that read `runs`.
PRAGMA legacy_alter_table = ON;

CREATE TABLE runs_next (
  id                    INTEGER PRIMARY KEY,
  plan                  INTEGER NOT NULL REFERENCES plans(id),
  step                  INTEGER NOT NULL CHECK (step BETWEEN 0 AND 9),
  seat                  TEXT NOT NULL REFERENCES rules(id),
  rule_hash             TEXT NOT NULL CHECK (length(rule_hash) = 64 AND rule_hash NOT GLOB '*[^0-9a-f]*'),
  provider              TEXT NOT NULL CHECK (provider IN ('claude-agent-sdk', 'anthropic-api', 'deepseek')),
  model                 TEXT NOT NULL,
  effort                TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  input_tokens          INTEGER NOT NULL CHECK (input_tokens >= 0),
  cache_read_tokens     INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  output_tokens         INTEGER NOT NULL CHECK (output_tokens >= 0),
  seconds               REAL NOT NULL CHECK (seconds >= 0),
  exit                  INTEGER NOT NULL CHECK (exit BETWEEN 0 AND 255),
  at                    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  transcript_path       TEXT NOT NULL CHECK (transcript_path GLOB '*.transcript.jsonl'),
  cost_usd              REAL,
  cache_write_tokens    INTEGER CHECK (cache_write_tokens >= 0),
  cost_computed_usd     REAL CHECK (cost_computed_usd >= 0),
  cache_write_1h_tokens INTEGER CHECK (cache_write_1h_tokens >= 0),
  mode                  TEXT CHECK (mode IN ('build', 'review', 'fix', 'log', 'ship', 'weekly')),
  session               TEXT
);
INSERT INTO runs_next (id, plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens,
    seconds, exit, at, transcript_path, cost_usd, cache_write_tokens, cost_computed_usd, cache_write_1h_tokens, mode, session)
  SELECT id, plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens,
         seconds, exit, at, transcript_path, cost_usd, cache_write_tokens, cost_computed_usd, cache_write_1h_tokens, mode, session
    FROM runs;
DROP TABLE runs;
ALTER TABLE runs_next RENAME TO runs;

PRAGMA legacy_alter_table = OFF;

-- The seat list must match BUILT in store/plans.ts.
CREATE TRIGGER runs_reviewer_not_builder BEFORE INSERT ON runs
WHEN (NEW.mode = 'review' AND EXISTS (
  SELECT 1 FROM runs r WHERE r.plan = NEW.plan AND r.step = 2 AND r.session = NEW.session
)) OR (NEW.mode IS NULL AND NEW.step IN (4, 5) AND NEW.seat NOT IN ('fixer', 'orchestrator', 'coo_lite', 'director') AND EXISTS (
  SELECT 1 FROM runs r WHERE r.plan = NEW.plan AND r.seat = NEW.seat
    AND (r.step = 2 OR (NEW.step = 5 AND r.step = 4))
))
BEGIN SELECT RAISE(ABORT, 'reviewer != builder'); END;

CREATE TRIGGER runs_reviewer_not_builder_update BEFORE UPDATE OF seat, step, plan, mode, session ON runs
WHEN (NEW.mode = 'review' AND EXISTS (
  SELECT 1 FROM runs r WHERE r.plan = NEW.plan AND r.step = 2 AND r.session = NEW.session AND r.id <> NEW.id
)) OR (NEW.mode IS NULL AND NEW.step IN (4, 5) AND NEW.seat NOT IN ('fixer', 'orchestrator', 'coo_lite', 'director') AND EXISTS (
  SELECT 1 FROM runs r WHERE r.plan = NEW.plan AND r.seat = NEW.seat AND r.id <> NEW.id
    AND (r.step = 2 OR (NEW.step = 5 AND r.step = 4))
))
BEGIN SELECT RAISE(ABORT, 'reviewer != builder'); END;
