PRAGMA foreign_keys = OFF;

-- `origin` is the github issue an internal plan was filed from, and the row's identity:
-- one issue is one plan. An external target keeps its `targets` row and files no origin.
CREATE TABLE plans_new (
  id          INTEGER PRIMARY KEY,
  pipe_id     INTEGER NOT NULL REFERENCES pipes(id),
  target_id   INTEGER REFERENCES targets(id),
  template    TEXT NOT NULL CHECK (template IN ('pr_path', 'research', 'comms')),
  state       TEXT NOT NULL CHECK (state IN ('queued', 'running', 'blocked_on_ceo', 'halted', 'done', 'refused')),
  queued_at   TEXT NOT NULL CHECK (queued_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  step        INTEGER NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 9),
  retries     INTEGER NOT NULL DEFAULT 0 CHECK (retries BETWEEN 0 AND 1),
  head_digest TEXT CHECK (head_digest IS NULL OR (length(head_digest) = 64 AND head_digest GLOB '[0-9a-f]*')),
  priority    INTEGER NOT NULL DEFAULT 1 CHECK (typeof(priority) = 'integer' AND priority BETWEEN 0 AND 9),
  lane        TEXT CHECK (lane IS NULL OR lane IN ('machine', 'atelier', 'comms', 'research')),
  seat        TEXT CHECK (seat IS NULL OR seat GLOB '[a-z][a-z0-9_]*'),
  origin      TEXT CHECK (origin IS NULL OR origin GLOB 'https://github.com/*/issues/[0-9]*'),
  CHECK (template <> 'pr_path' OR target_id IS NOT NULL OR origin IS NOT NULL),
  CHECK ((lane IS NULL) = (origin IS NULL)),
  CHECK (origin IS NULL OR seat IS NOT NULL)
);
INSERT INTO plans_new (id, pipe_id, target_id, template, state, queued_at, step, retries, head_digest, priority)
  SELECT id, pipe_id, target_id, template, state, queued_at, step, retries, head_digest, priority FROM plans;
DROP TABLE plans;
ALTER TABLE plans_new RENAME TO plans;

CREATE UNIQUE INDEX plans_one_per_issue ON plans (origin) WHERE origin IS NOT NULL;

CREATE TRIGGER plans_leave_batch_on_approval BEFORE UPDATE OF step ON plans
WHEN NEW.step > 7 AND NOT EXISTS (
  SELECT 1 FROM deliverables d JOIN approvals a ON a.id = d.approval_id
  WHERE d.plan_id = NEW.id AND d.state IN ('approved', 'pushed')
    AND d.id = (SELECT max(id) FROM deliverables WHERE plan_id = NEW.id)
    AND a.subject_kind = 'plan' AND a.subject_id = NEW.id
    AND a.decision = 'approved' AND a.subject_digest = NEW.head_digest
)
BEGIN SELECT RAISE(ABORT, 'no ceo approval row for this plan at the head the ready gate proved'); END;

INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no, supersedes) VALUES
  ('plan.origin', 'a_github_issue_is_a_ticket_once_a_plan_row_names_it', 'ruling', 'ceo-2026-09-18', 'ceo', '2026-09-18', 25, NULL),
  ('plan.lane_label', 'an_internal_plan_names_its_lane_or_it_is_refused', 'ruling', 'ceo-2026-09-18', 'ceo', '2026-09-18', 25, NULL);

PRAGMA foreign_keys = ON;
