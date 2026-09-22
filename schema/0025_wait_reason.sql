-- 2026-09-22 (#140, 138a). A plan the tick passes over left no trace of why: the reason lived in a
-- `blocked()` return the tick threw away, and `tick --dry` was the only place a person could read it.
-- #141's router and the #139 orchestrator both wake on this enum, so the reason becomes a stored fact,
-- checked by the store, and not a string some caller happened to format.
ALTER TABLE plans ADD COLUMN wait_reason TEXT CHECK (wait_reason IS NULL OR wait_reason IN (
  'ceo_batch',      -- step 7: waiting on the sign-off batch
  'target_approval',-- step 0: waiting on cf approve target
  'ready_proof',    -- the ready gate has not proved this head
  'target_parked',  -- the target row is parked
  'token_ceiling',  -- the job spent plan.token_ceiling since a person last cleared it
  'leased',         -- another live tick holds it
  'over_cap',       -- its own lane is open and full
  'lane_over_cap',  -- its lane can step it; the lane cap was spent on a lower lane
  'no_step_map'     -- its template has no step map, so the lane is on with nothing to step
));
