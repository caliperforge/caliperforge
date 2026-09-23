-- #88 (66b). A plan whose file list shares a path with a job already building waits for it, and the
-- plan it waits on is stored beside the reason. SQLite cannot widen a CHECK in place, so the column is
-- dropped and made again: every tick rewrites it, so no value is lost that the next tick does not restore.
ALTER TABLE plans DROP COLUMN wait_reason;
ALTER TABLE plans ADD COLUMN wait_reason TEXT CHECK (wait_reason IS NULL OR wait_reason IN (
  'ceo_batch',      -- step 7: waiting on the sign-off batch
  'target_approval',-- step 0: waiting on cf approve target
  'ready_proof',    -- the ready gate has not proved this head
  'target_parked',  -- the target row is parked
  'token_ceiling',  -- the job spent plan.token_ceiling since a person last cleared it
  'leased',         -- another live tick holds it
  'over_cap',       -- its own lane is open and full
  'lane_over_cap',  -- its lane can step it; the lane cap was spent on a lower lane
  'no_step_map',    -- its template has no step map, so the lane is on with nothing to step
  'file_overlap'    -- its file list shares a path with a job already building; waits_on names it
));
ALTER TABLE plans ADD COLUMN waits_on INTEGER REFERENCES plans(id);

-- `decisions.wait_reason` repeats the list (0026), so it is made again with the same new value.
CREATE TABLE decisions_new (
  id          INTEGER PRIMARY KEY,
  plan        INTEGER NOT NULL REFERENCES plans(id),
  step        INTEGER NOT NULL CHECK (step BETWEEN 0 AND 9),
  wait_reason TEXT NOT NULL CHECK (wait_reason IN (
    'ceo_batch', 'target_approval', 'ready_proof', 'target_parked', 'token_ceiling',
    'leased', 'over_cap', 'lane_over_cap', 'no_step_map', 'file_overlap'
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
