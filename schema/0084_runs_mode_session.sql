ALTER TABLE runs ADD COLUMN mode TEXT CHECK (mode IN ('build', 'review', 'fix'));
ALTER TABLE runs ADD COLUMN session TEXT;

DROP TRIGGER runs_reviewer_not_builder;
DROP TRIGGER runs_reviewer_not_builder_update;

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
