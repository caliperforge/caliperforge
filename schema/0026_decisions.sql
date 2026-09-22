-- 2026-09-22 (#143, 139a). The orchestrator runs in shadow first: it wakes on a plan's `wait_reason`,
-- answers from a closed menu, and applies none of it. The record is what makes a day of its calls
-- readable beside the COO's the next morning, so the menu is the store's to enforce and not a seat's
-- to spell. `wait_reason` repeats 0025's list; `store/plans.ts:WAIT` is the one TypeScript copy and
-- its test walks every value through this table, so a value added to one and not the other fails.
CREATE TABLE decisions (
  id          INTEGER PRIMARY KEY,
  plan        INTEGER NOT NULL REFERENCES plans(id),
  step        INTEGER NOT NULL CHECK (step BETWEEN 0 AND 9),
  wait_reason TEXT NOT NULL CHECK (wait_reason IN (
    'ceo_batch', 'target_approval', 'ready_proof', 'target_parked', 'token_ceiling',
    'leased', 'over_cap', 'lane_over_cap', 'no_step_map'
  )),
  verb        TEXT NOT NULL CHECK (verb IN (
    'retry',        -- fire the same step again
    'return',       -- send it back to an earlier step
    'halt',         -- stop it where it stands
    'next',         -- leave it and take the next job
    'clear',        -- clear what it was refused for and let it go round
    'split',        -- the ticket is more than one job
    'ask_ceo',      -- a ruling only he makes
    'ask_coo'       -- a hand action only the coo takes
  )),
  why         TEXT NOT NULL CHECK (length(trim(why)) BETWEEN 1 AND 200),
  evidence    TEXT CHECK (evidence IS NULL OR length(trim(evidence)) > 0),
  tokens      INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX decisions_by_plan ON decisions (plan, id);
