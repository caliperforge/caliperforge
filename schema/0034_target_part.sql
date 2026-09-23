-- #181. A target may be one item of its issue, so one outside issue carries several targets and plans,
-- one pull request each. `part` is '' for the whole issue, which is every row until now.
CREATE TABLE targets_new (
  id                   INTEGER PRIMARY KEY,
  account_id           INTEGER NOT NULL REFERENCES accounts(id),
  repo                 TEXT NOT NULL CHECK (repo GLOB '*/*'),
  issue_no             INTEGER NOT NULL CHECK (issue_no > 0),
  part                 TEXT NOT NULL DEFAULT '' CHECK (part = '' OR (part GLOB '[a-z0-9]*' AND part NOT GLOB '*[^a-z0-9-]*' AND length(part) <= 32)),
  named_merger         TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN ('cold', 'ready', 'queued', 'parked', 'refused')),
  evidence_measured_at TEXT NOT NULL CHECK (evidence_measured_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ineligible_ruling_id INTEGER REFERENCES rulings(id),
  evidence             TEXT NOT NULL CHECK (evidence GLOB 'https://*' OR (evidence GLOB '[A-Za-z0-9_]*' AND evidence NOT GLOB '*://*' AND evidence NOT GLOB '*..*')),
  UNIQUE (repo, issue_no, part),
  CHECK (ineligible_ruling_id IS NULL OR state = 'refused')
);
INSERT INTO targets_new (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, ineligible_ruling_id, evidence)
  SELECT id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, ineligible_ruling_id, evidence FROM targets;
DROP TABLE targets;
ALTER TABLE targets_new RENAME TO targets;
