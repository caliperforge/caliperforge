CREATE TABLE desk_posts_next (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  dest         TEXT NOT NULL CHECK (dest IN ('site', 'substack', 'note', 'pack')),
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

-- A comms plan's step 8 is `pack`, which no approval gates.
DROP TRIGGER plans_leave_batch_on_approval;
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
