-- #246 (139d). The orchestrator also wakes on a plan stopped for a person, which has no wait reason:
-- its decision row names the state instead. SQLite cannot widen a CHECK in place, so the table is made again.
CREATE TABLE decisions_new (
  id          INTEGER PRIMARY KEY,
  plan        INTEGER NOT NULL REFERENCES plans(id),
  step        INTEGER NOT NULL CHECK (step BETWEEN 0 AND 9),
  wait_reason TEXT NOT NULL CHECK (wait_reason IN (
    'ceo_batch', 'target_approval', 'ready_proof', 'target_parked', 'token_ceiling',
    'leased', 'over_cap', 'lane_over_cap', 'no_step_map', 'file_overlap', 'blocked_on_ceo'
  )),
  verb        TEXT NOT NULL CHECK (verb IN (
    'retry', 'return', 'halt', 'next', 'clear', 'split', 'ask_ceo', 'ask_coo'
  )),
  why         TEXT NOT NULL CHECK (length(trim(why)) BETWEEN 1 AND 200),
  evidence    TEXT CHECK (evidence IS NULL OR length(trim(evidence)) > 0),
  tokens      INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO decisions_new SELECT * FROM decisions;
DROP TABLE decisions;
ALTER TABLE decisions_new RENAME TO decisions;
CREATE INDEX decisions_by_plan ON decisions (plan, id);
