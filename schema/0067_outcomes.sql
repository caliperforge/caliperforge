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
