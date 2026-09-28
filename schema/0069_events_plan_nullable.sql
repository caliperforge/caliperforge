DROP VIEW outcomes;

-- `kind` has no CHECK: a later writer adds its own kinds without rebuilding the table.
CREATE TABLE events_new (
  id       INTEGER PRIMARY KEY,
  plan     INTEGER REFERENCES plans(id),
  at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind     TEXT NOT NULL,
  actor    TEXT NOT NULL,
  outcome  TEXT NOT NULL CHECK (outcome IN ('pass', 'refuse', 'needs_ceo')),
  message  TEXT NOT NULL,
  pointer  TEXT,
  run      INTEGER REFERENCES runs(id)
);
INSERT INTO events_new SELECT * FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX events_by_plan ON events (plan, id);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

-- An intervention is missed when the refusal it answered comes back, or its plan is refused after it.
CREATE VIEW outcomes AS
  WITH scored AS (
    SELECT e.id AS event, e.plan, e.actor, e.at, e.kind, p.state,
      (SELECT min(f.id) FROM refusals f
        WHERE f.plan = e.plan AND f.blip = 0 AND julianday(f.at) > julianday(e.at)
          AND f.fingerprint = (SELECT g.fingerprint FROM refusals g
            WHERE g.plan = e.plan AND g.blip = 0 AND julianday(g.at) <= julianday(e.at)
            ORDER BY g.id DESC LIMIT 1)) AS refusal,
      (SELECT min(c.id) FROM events c WHERE c.plan = e.plan AND c.kind = 'close' AND c.id > e.id) AS close
    FROM events e JOIN plans p ON p.id = e.plan
    WHERE e.actor IN ('ceo', 'coo', 'coo_lite', 'orchestrator', 'fixer')
  )
  SELECT event, plan, actor, at,
    CASE WHEN refusal IS NOT NULL OR (state = 'refused' AND kind <> 'close') THEN 'missed'
         WHEN state = 'done' THEN 'held'
         ELSE 'open' END AS outcome,
    refusal, close
  FROM scored;
