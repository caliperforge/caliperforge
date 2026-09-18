PRAGMA foreign_keys = OFF;

-- The step-7 trigger names `approvals`, and `ALTER TABLE ... RENAME` re-parses every schema
-- object; it is dropped first so the rebuild below is not read against a table that is gone.
DROP TRIGGER plans_leave_batch_on_approval;

-- Ruling #20: an internal plan lands on the gates alone. The row that settles its deliverable is
-- signed `gates`, not `ceo`, so `who` takes a second value -- and only for a plan it approves.
CREATE TABLE approvals_new (
  id             INTEGER PRIMARY KEY,
  subject_kind   TEXT NOT NULL CHECK (subject_kind IN ('target', 'plan', 'proposal', 'deliverable', 'override', 'publish')),
  subject_id     INTEGER NOT NULL,
  subject_digest TEXT NOT NULL CHECK (length(subject_digest) = 64 AND subject_digest GLOB '[0-9a-f]*'),
  who            TEXT NOT NULL CHECK (who IN ('ceo', 'gates')),
  decision       TEXT NOT NULL CHECK (decision IN ('approved', 'refused')),
  reason         TEXT CHECK (reason GLOB '[a-z][a-z0-9_.-]*'),
  approved_at    TEXT NOT NULL CHECK (approved_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  UNIQUE (subject_kind, subject_id, subject_digest, decision),
  CHECK ((decision = 'refused') = (reason IS NOT NULL)),
  CHECK (who = 'ceo' OR (subject_kind = 'plan' AND decision = 'approved'))
);
INSERT INTO approvals_new (id, subject_kind, subject_id, subject_digest, who, decision, reason, approved_at)
  SELECT id, subject_kind, subject_id, subject_digest, who, decision, reason, approved_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;

-- The same fence as 0011, with one clause added: a `gates` signature is read only on a plan that
-- names an origin. A plan on a stranger's repo still leaves step 7 on the CEO's row and nothing else.
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

INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no, supersedes) VALUES
  ('plan.internal_measure', 'our_own_repo_has_no_pulse_and_no_target_to_approve', 'ruling', 'ceo-2026-09-18', 'ceo', '2026-09-18', 34, NULL),
  ('plan.internal_signoff', 'an_internal_plan_lands_on_the_gates_signed_gates_not_ceo', 'ruling', 'ceo-2026-09-18', 'ceo', '2026-09-18', 34, NULL),
  ('plan.internal_branch', 'p_plan_number_and_the_issue_title_slug_in_our_own_tree', 'ruling', 'ceo-2026-09-18', 'ceo', '2026-09-18', 34, NULL);

PRAGMA foreign_keys = ON;
