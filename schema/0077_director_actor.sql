DROP VIEW outcomes;

CREATE VIEW outcomes AS
  WITH scored AS (
    SELECT e.id AS event, e.plan, e.actor, e.at, e.kind, p.state,
      (SELECT min(f.id) FROM refusals f
        WHERE f.plan = e.plan AND f.blip = 0 AND julianday(f.at) > julianday(e.at)
          AND f.fingerprint = (SELECT g.fingerprint FROM refusals g
            WHERE g.plan = e.plan AND g.blip = 0 AND julianday(g.at) <= julianday(e.at)
            ORDER BY g.id DESC LIMIT 1)) AS refusal,
      (SELECT min(c.id) FROM events c WHERE c.plan = e.plan AND c.kind = 'close' AND c.id > e.id) AS close,
      (SELECT e.pointer FROM tickets t
        WHERE e.pointer = 'https://github.com/' || t.repo || '/issues/' || t.number
          AND (t.state_reason = 'NOT_PLANNED' OR t.diagnosis_wrong = 1)) AS ticket
    FROM events e JOIN plans p ON p.id = e.plan
    WHERE e.actor IN ('ceo', 'coo', 'coo_lite', 'orchestrator', 'director', 'fixer')
  )
  SELECT event, plan, actor, at,
    CASE WHEN refusal IS NOT NULL OR ticket IS NOT NULL OR (state = 'refused' AND kind <> 'close') THEN 'missed'
         WHEN state = 'done' THEN 'held'
         ELSE 'open' END AS outcome,
    refusal, close, ticket
  FROM scored;

DROP TRIGGER runs_reviewer_not_builder;
DROP TRIGGER runs_reviewer_not_builder_update;

-- The seat list must match BUILT in store/plans.ts.
CREATE TRIGGER runs_reviewer_not_builder BEFORE INSERT ON runs
WHEN NEW.step IN (4, 5) AND NEW.seat NOT IN ('fixer', 'orchestrator', 'coo_lite', 'director') AND EXISTS (
  SELECT 1 FROM runs r WHERE r.plan = NEW.plan AND r.seat = NEW.seat
    AND (r.step = 2 OR (NEW.step = 5 AND r.step = 4))
)
BEGIN SELECT RAISE(ABORT, 'reviewer != builder'); END;

CREATE TRIGGER runs_reviewer_not_builder_update BEFORE UPDATE OF seat, step, plan ON runs
WHEN NEW.step IN (4, 5) AND NEW.seat NOT IN ('fixer', 'orchestrator', 'coo_lite', 'director') AND EXISTS (
  SELECT 1 FROM runs r WHERE r.plan = NEW.plan AND r.seat = NEW.seat AND r.id <> NEW.id
    AND (r.step = 2 OR (NEW.step = 5 AND r.step = 4))
)
BEGIN SELECT RAISE(ABORT, 'reviewer != builder'); END;
