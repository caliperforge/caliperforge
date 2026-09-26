DROP TRIGGER runs_reviewer_not_builder;
DROP TRIGGER runs_reviewer_not_builder_update;

-- The seat list must match BUILT in store/plans.ts.
CREATE TRIGGER runs_reviewer_not_builder BEFORE INSERT ON runs
WHEN NEW.step IN (4, 5) AND NEW.seat NOT IN ('fixer', 'orchestrator') AND EXISTS (
  SELECT 1 FROM runs r WHERE r.plan = NEW.plan AND r.seat = NEW.seat
    AND (r.step = 2 OR (NEW.step = 5 AND r.step = 4))
)
BEGIN SELECT RAISE(ABORT, 'reviewer != builder'); END;

CREATE TRIGGER runs_reviewer_not_builder_update BEFORE UPDATE OF seat, step, plan ON runs
WHEN NEW.step IN (4, 5) AND NEW.seat NOT IN ('fixer', 'orchestrator') AND EXISTS (
  SELECT 1 FROM runs r WHERE r.plan = NEW.plan AND r.seat = NEW.seat AND r.id <> NEW.id
    AND (r.step = 2 OR (NEW.step = 5 AND r.step = 4))
)
BEGIN SELECT RAISE(ABORT, 'reviewer != builder'); END;
