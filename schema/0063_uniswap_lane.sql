PRAGMA foreign_keys = OFF;

INSERT OR IGNORE INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES ('uniswap', 0, '07:00', '22:00', 1);

-- `lane` sits in a table CHECK, so widening it rebuilds the table.
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

CREATE TRIGGER plans_leave_batch_on_approval BEFORE UPDATE OF step ON plans
WHEN NEW.step > 7 AND NOT EXISTS (
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

PRAGMA foreign_keys = ON;
