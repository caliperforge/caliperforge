PRAGMA foreign_keys = OFF;

CREATE TABLE approvals_new (
  id             INTEGER PRIMARY KEY,
  subject_kind   TEXT NOT NULL CHECK (subject_kind IN ('target', 'plan', 'proposal', 'deliverable', 'override', 'publish')),
  subject_id     INTEGER NOT NULL,
  subject_digest TEXT NOT NULL CHECK (length(subject_digest) = 64 AND subject_digest GLOB '[0-9a-f]*'),
  who            TEXT NOT NULL CHECK (who = 'ceo'),
  decision       TEXT NOT NULL CHECK (decision IN ('approved', 'refused')),
  reason         TEXT CHECK (reason GLOB '[a-z][a-z0-9_.-]*'),
  approved_at    TEXT NOT NULL CHECK (approved_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  UNIQUE (subject_kind, subject_id, subject_digest, decision),
  CHECK ((decision = 'refused') = (reason IS NOT NULL))
);
INSERT INTO approvals_new (id, subject_kind, subject_id, subject_digest, who, decision, reason, approved_at)
  SELECT id, subject_kind, subject_id, subject_digest, who, 'approved', NULL, approved_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;

CREATE TABLE proposals (
  id              INTEGER PRIMARY KEY,
  class           TEXT NOT NULL CHECK (class IN ('ruling', 'work', 'ordering', 'world_fact', 'measurement')),
  subject         TEXT NOT NULL CHECK (subject GLOB '[a-z][a-z0-9_.]*'),
  value           TEXT NOT NULL CHECK (value GLOB '[a-z0-9][a-z0-9_.-]*'),
  state           TEXT NOT NULL CHECK (state IN ('open', 'approved')),
  match_ruling_id INTEGER REFERENCES rulings(id),
  match_issue_no  INTEGER CHECK (match_issue_no > 0),
  evidence        TEXT NOT NULL CHECK (evidence GLOB '*:[0-9]*' AND evidence NOT GLOB '* *'),
  UNIQUE (class, subject, value)
);

CREATE TABLE signals (
  id          INTEGER PRIMARY KEY,
  repo        TEXT NOT NULL CHECK (repo GLOB '*/*'),
  pr          INTEGER NOT NULL CHECK (pr > 0),
  kind        TEXT NOT NULL CHECK (kind IN ('comment', 'review', 'bot_review', 'merge', 'ci_red')),
  author      TEXT NOT NULL CHECK (author GLOB '[A-Za-z0-9]*'),
  at          TEXT NOT NULL CHECK (at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  external_id TEXT NOT NULL CHECK (external_id NOT GLOB '* *'),
  score       INTEGER CHECK (score BETWEEN 0 AND 5),
  plan        INTEGER REFERENCES plans(id),
  UNIQUE (repo, pr, kind, external_id),
  CHECK ((kind = 'bot_review') = (score IS NOT NULL))
);

CREATE TRIGGER plans_leave_batch_on_approval BEFORE UPDATE OF step ON plans
WHEN NEW.step > 7 AND NOT EXISTS (
  SELECT 1 FROM approvals a WHERE a.subject_kind = 'plan' AND a.subject_id = NEW.id AND a.decision = 'approved'
)
BEGIN SELECT RAISE(ABORT, 'no ceo approval row for this plan'); END;

INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no, supersedes) VALUES
  ('approvals.decision', 'approved_or_refused_with_typed_reason', 'ruling', 'buildmap-rev6-decisions', 'ceo', '2026-09-17', 17, NULL),
  ('batch.leave_ready', 'store_trigger_not_code', 'ruling', 'buildmap-rev6-steps', 'ceo', '2026-09-17', 17, NULL),
  ('push.digest', 'approval_matches_branch_head_digest', 'ruling', 'buildmap-rev6-decisions', 'ceo', '2026-09-17', 17, NULL),
  ('signals.source', 'tick_polls_gh_api_no_webhook', 'ruling', 'buildmap-rev6-decisions', 'ceo', '2026-09-17', 18, NULL),
  ('session.close', 'typed_proposals_no_prose', 'ruling', 'ceo-2026-09-17', 'ceo', '2026-09-17', 17, NULL);

PRAGMA foreign_keys = ON;
