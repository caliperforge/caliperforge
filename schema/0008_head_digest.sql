ALTER TABLE plans ADD COLUMN head_digest TEXT
  CHECK (head_digest IS NULL OR (length(head_digest) = 64 AND head_digest GLOB '[0-9a-f]*'));

DROP TRIGGER plans_leave_batch_on_approval;

CREATE TRIGGER plans_leave_batch_on_approval BEFORE UPDATE OF step ON plans
WHEN NEW.step > 7 AND NOT EXISTS (
  SELECT 1 FROM deliverables d JOIN approvals a ON a.id = d.approval_id
  WHERE d.plan_id = NEW.id AND d.state IN ('approved', 'pushed')
    AND d.id = (SELECT max(id) FROM deliverables WHERE plan_id = NEW.id)
    AND a.subject_kind = 'plan' AND a.subject_id = NEW.id
    AND a.decision = 'approved' AND a.subject_digest = NEW.head_digest
)
BEGIN SELECT RAISE(ABORT, 'no ceo approval row for this plan at the head the ready gate proved'); END;
