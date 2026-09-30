CREATE TABLE queue_rules (
  id      INTEGER PRIMARY KEY,
  key     TEXT NOT NULL UNIQUE,
  wording TEXT NOT NULL
);
INSERT INTO queue_rules (id, key, wording) VALUES
  (1, 'started', 'work already started goes first'),
  (2, 'priority', 'then the lower P number'),
  (3, 'queued_at', 'then the earlier queue time'),
  (4, 'id', 'then the lower plan id');

CREATE VIEW queue_order AS
  SELECT pipe_id AS pipe, id AS plan, row_number() OVER w AS position,
    CASE WHEN lead(id) OVER w IS NULL THEN NULL
         WHEN (step = 0) < lead(step = 0) OVER w THEN 1
         WHEN priority < lead(priority) OVER w THEN 2
         WHEN queued_at < lead(queued_at) OVER w THEN 3
         ELSE 4 END AS rule,
    wait_reason AS waiting
  FROM plans WHERE state IN ('queued', 'running')
  WINDOW w AS (PARTITION BY pipe_id
    -- `step = 0` is 1 for a plan not yet started.
    ORDER BY step = 0, priority, queued_at, id);
