CREATE TABLE desk_posts_next (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  dest         TEXT NOT NULL CHECK (dest IN ('site', 'substack', 'note', 'pack', 'scorecard')),
  status       TEXT NOT NULL CHECK (status IN ('proof', 'approved', 'changes', 'published')),
  title        TEXT NOT NULL,
  dek          TEXT NOT NULL,
  body         TEXT NOT NULL,
  edited_title TEXT,
  edited_dek   TEXT,
  edited_body  TEXT,
  note         TEXT,
  sources      TEXT NOT NULL,
  checks       TEXT NOT NULL,
  work_date    TEXT NOT NULL,
  written_date TEXT NOT NULL,
  "order"      INTEGER,
  proof_at     TEXT
);
INSERT INTO desk_posts_next (id, kind, dest, status, title, dek, body, edited_title, edited_dek, edited_body, note, sources, checks,
  work_date, written_date, "order", proof_at)
SELECT id, kind, dest, status, title, dek, body, edited_title, edited_dek, edited_body, note, sources, checks,
  work_date, written_date, "order", proof_at FROM desk_posts;
DROP TABLE desk_posts;
ALTER TABLE desk_posts_next RENAME TO desk_posts;

-- A comms plan that finishes step 9 `score` sits at step 10, and `step` sits in a table CHECK.
DROP VIEW outcomes;

CREATE TABLE plans_new (
  id          INTEGER PRIMARY KEY,
  pipe_id     INTEGER NOT NULL REFERENCES pipes(id),
  target_id   INTEGER REFERENCES targets(id),
  template    TEXT NOT NULL CHECK (template IN ('pr_path', 'research', 'comms')),
  state       TEXT NOT NULL CHECK (state IN ('queued', 'running', 'blocked_on_ceo', 'halted', 'done', 'refused')),
  queued_at   TEXT NOT NULL CHECK (queued_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  step        INTEGER NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 10),
  retries     INTEGER NOT NULL DEFAULT 0 CHECK (retries BETWEEN 0 AND 1),
  head_digest TEXT CHECK (head_digest IS NULL OR (length(head_digest) = 64 AND head_digest GLOB '[0-9a-f]*')),
  priority    INTEGER NOT NULL DEFAULT 1 CHECK (typeof(priority) = 'integer' AND priority BETWEEN 0 AND 9),
  lane        TEXT CHECK (lane IS NULL OR lane IN ('machine', 'atelier', 'comms', 'research', 'uniswap')),
  seat        TEXT CHECK (seat IS NULL OR seat GLOB '[a-z][a-z0-9_]*'),
  origin      TEXT CHECK (origin IS NULL OR origin GLOB 'https://github.com/*/issues/[0-9]*'),
  wait_reason TEXT CHECK (wait_reason IS NULL OR wait_reason IN (
    'ceo_batch', 'target_approval', 'ready_proof', 'target_parked', 'token_ceiling',
    'leased', 'over_cap', 'lane_over_cap', 'no_step_map', 'file_overlap'
  )),
  waits_on    INTEGER REFERENCES plans(id),
  title       TEXT,
  what        TEXT,
  why         TEXT,
  ends        TEXT,
  held_by     TEXT CHECK (held_by IN ('ceo', 'coo')),
  held_why    TEXT CHECK (instr(held_why, char(10)) = 0),
  CHECK (template <> 'pr_path' OR target_id IS NOT NULL OR origin IS NOT NULL),
  CHECK ((lane IS NULL) = (origin IS NULL)),
  CHECK (origin IS NULL OR seat IS NOT NULL)
);
INSERT INTO plans_new (id, pipe_id, target_id, template, state, queued_at, step, retries, head_digest, priority,
    lane, seat, origin, wait_reason, waits_on, title, what, why, ends, held_by, held_why)
  SELECT id, pipe_id, target_id, template, state, queued_at, step, retries, head_digest, priority,
    lane, seat, origin, wait_reason, waits_on, title, what, why, ends, held_by, held_why FROM plans;
DROP TABLE plans;
ALTER TABLE plans_new RENAME TO plans;

CREATE UNIQUE INDEX plans_one_per_issue ON plans (origin) WHERE origin IS NOT NULL;
CREATE UNIQUE INDEX plans_one_comms ON plans (title) WHERE template = 'comms';

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
    WHERE e.actor IN ('ceo', 'coo', 'coo_lite', 'orchestrator', 'fixer')
  )
  SELECT event, plan, actor, at,
    CASE WHEN refusal IS NOT NULL OR ticket IS NOT NULL OR (state = 'refused' AND kind <> 'close') THEN 'missed'
         WHEN state = 'done' THEN 'held'
         ELSE 'open' END AS outcome,
    refusal, close, ticket
  FROM scored;

CREATE TRIGGER plans_leave_batch_on_approval BEFORE UPDATE OF step ON plans
WHEN NEW.template = 'pr_path' AND NEW.step > 7 AND NOT EXISTS (
  SELECT 1 FROM deliverables d JOIN approvals a ON a.id = d.approval_id
  WHERE d.plan_id = NEW.id AND d.state IN ('approved', 'pushed')
    AND d.id = (SELECT max(id) FROM deliverables WHERE plan_id = NEW.id)
    AND a.subject_kind = 'plan' AND a.subject_id = NEW.id
    AND a.decision = 'approved' AND a.subject_digest = NEW.head_digest
    AND (a.who = 'ceo' OR (a.who = 'gates' AND NEW.origin IS NOT NULL))
)
BEGIN SELECT RAISE(ABORT, 'no ceo approval row for this plan at the head the ready gate proved'); END;

CREATE TRIGGER plans_held_on_entry AFTER UPDATE OF state ON plans
WHEN OLD.state <> 'blocked_on_ceo' AND NEW.state = 'blocked_on_ceo'
BEGIN UPDATE plans SET held_by = 'coo' WHERE id = NEW.id; END;

CREATE TRIGGER plans_held_on_exit AFTER UPDATE OF state ON plans
WHEN OLD.state = 'blocked_on_ceo' AND NEW.state <> 'blocked_on_ceo'
BEGIN UPDATE plans SET held_by = NULL, held_why = NULL WHERE id = NEW.id; END;
