DROP VIEW outcomes;

-- An event on a plan a ceo or coo later closes as refused reads `cancelled`; a look, a github_read and a director's "left alone" are not scored.
CREATE VIEW outcomes AS
  WITH scored AS (
    SELECT e.id AS event, e.plan, e.actor, e.at, e.kind, p.state,
      (SELECT min(f.id) FROM refusals f
        WHERE f.plan = e.plan AND f.blip = 0 AND julianday(f.at) > julianday(e.at)
          AND f.fingerprint = (SELECT g.fingerprint FROM refusals g
            WHERE g.plan = e.plan AND g.blip = 0 AND julianday(g.at) <= julianday(e.at)
            ORDER BY g.id DESC LIMIT 1)) AS refusal,
      (SELECT min(c.id) FROM events c WHERE c.plan = e.plan AND c.kind = 'close' AND c.id > e.id) AS close,
      (SELECT min(c.id) FROM events c
        WHERE c.plan = e.plan AND c.kind = 'close' AND c.actor IN ('ceo', 'coo') AND c.outcome = 'refuse' AND c.id > e.id) AS cancel,
      (SELECT e.pointer FROM tickets t
        WHERE e.pointer = 'https://github.com/' || t.repo || '/issues/' || t.number
          AND (t.state_reason = 'NOT_PLANNED' OR t.diagnosis_wrong = 1)) AS ticket
    FROM events e JOIN plans p ON p.id = e.plan
    WHERE e.actor IN ('ceo', 'coo', 'coo_lite', 'orchestrator', 'director', 'fixer')
      AND e.kind NOT IN ('look', 'github_read') AND NOT (e.kind = 'director' AND e.message GLOB 'left alone: *')
  ), judged AS (
    SELECT *,
      CASE WHEN cancel IS NOT NULL THEN 'cancelled'
           WHEN refusal IS NOT NULL OR ticket IS NOT NULL OR (state = 'refused' AND kind <> 'close') THEN 'missed'
           WHEN state = 'done' THEN 'held'
           ELSE 'open' END AS outcome
    FROM scored
  )
  SELECT event, plan, actor, at, outcome, refusal, close, ticket,
    CASE WHEN outcome <> 'missed' THEN NULL WHEN ticket IS NOT NULL THEN 'ticket' ELSE 'stop' END AS miss
  FROM judged;
