PRAGMA foreign_keys = OFF;

-- Step 0 must not trip on a target inside an open loop (BUILD_MAP rev 6.1 line 82, step 0; kernel issue 23).
-- The no-outsider-merge axis is unchanged. The p50 axis no longer cools an account we already have
-- an open loop on: an open pull request from our fork, or a plan of ours that is not terminal there.
CREATE TABLE accounts_new (
  id                   INTEGER PRIMARY KEY,
  repo                 TEXT NOT NULL CHECK (repo GLOB '*/*'),
  measured_at          TEXT NOT NULL CHECK (measured_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  maintainers          INTEGER NOT NULL CHECK (maintainers >= 0),
  doors                INTEGER NOT NULL CHECK (doors >= 0),
  last_outsider_merge  TEXT CHECK (last_outsider_merge GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  open_pr_age_p50_days INTEGER NOT NULL CHECK (open_pr_age_p50_days >= 0),
  cross_repo_activity  INTEGER NOT NULL CHECK (cross_repo_activity >= 0),
  open_loop            INTEGER NOT NULL DEFAULT 0 CHECK (open_loop IN (0, 1)),
  pulse                TEXT NOT NULL CHECK (pulse IN ('warm', 'cold')),
  evidence             TEXT NOT NULL CHECK (evidence GLOB 'https://*' OR (evidence GLOB '[A-Za-z0-9_]*' AND evidence NOT GLOB '*://*' AND evidence NOT GLOB '*..*')),
  UNIQUE (repo, measured_at),
  CHECK (pulse = CASE
    WHEN last_outsider_merge IS NULL THEN 'cold'
    WHEN julianday(measured_at) - julianday(last_outsider_merge) > 21 THEN 'cold'
    WHEN open_pr_age_p50_days > 21 AND open_loop = 0 THEN 'cold'
    ELSE 'warm' END)
);
INSERT INTO accounts_new (id, repo, measured_at, maintainers, doors, last_outsider_merge,
  open_pr_age_p50_days, cross_repo_activity, open_loop, pulse, evidence)
  SELECT id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, 0, pulse, evidence FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no, supersedes) VALUES
  ('queue.implemented', 'only_a_pull_request_not_headed_from_our_fork_implements_an_issue', 'ruling', 'buildmap-rev6-step0-must-not-trip', 'ceo', '2026-09-17', 23, NULL),
  ('queue.cold_pulse', 'a_cold_account_parks_a_target_an_open_loop_of_ours_is_not_cold_on_p50_alone', 'ruling', 'buildmap-rev6-step0-must-not-trip', 'ceo', '2026-09-17', 23, NULL);

PRAGMA foreign_keys = ON;
