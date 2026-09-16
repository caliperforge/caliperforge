PRAGMA foreign_keys = ON;

CREATE TABLE rules (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('roster', 'rail', 'card')),
  path         TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash GLOB '[0-9a-f]*'),
  loaded_at    TEXT NOT NULL CHECK (loaded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);

CREATE TABLE rulings (
  id         INTEGER PRIMARY KEY,
  subject    TEXT NOT NULL,
  value      TEXT NOT NULL,
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('rail', 'ruling', 'incident')),
  origin_ref  TEXT NOT NULL,
  who        TEXT NOT NULL CHECK (who IN ('ceo', 'coo')),
  date       TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  issue_no   INTEGER NOT NULL CHECK (issue_no > 0)
);

CREATE TABLE accounts (
  id                   INTEGER PRIMARY KEY,
  repo                 TEXT NOT NULL CHECK (repo GLOB '*/*'),
  measured_at          TEXT NOT NULL CHECK (measured_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  maintainers          INTEGER NOT NULL CHECK (maintainers >= 0),
  doors                INTEGER NOT NULL CHECK (doors >= 0),
  last_outsider_merge  TEXT CHECK (last_outsider_merge GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  open_pr_age_p50_days INTEGER NOT NULL CHECK (open_pr_age_p50_days >= 0),
  cross_repo_activity  INTEGER NOT NULL CHECK (cross_repo_activity >= 0),
  pulse                TEXT NOT NULL CHECK (pulse IN ('warm', 'cold')),
  evidence             TEXT NOT NULL CHECK (evidence GLOB 'https://*'),
  UNIQUE (repo, measured_at),
  CHECK (pulse = CASE
    WHEN last_outsider_merge IS NULL THEN 'cold'
    WHEN julianday(measured_at) - julianday(last_outsider_merge) > 21 THEN 'cold'
    WHEN open_pr_age_p50_days > 21 THEN 'cold'
    ELSE 'warm' END)
);

CREATE TABLE targets (
  id                   INTEGER PRIMARY KEY,
  account_id           INTEGER NOT NULL REFERENCES accounts(id),
  repo                 TEXT NOT NULL CHECK (repo GLOB '*/*'),
  issue_no             INTEGER NOT NULL CHECK (issue_no > 0),
  named_merger         TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN ('cold', 'ready', 'queued', 'parked', 'refused')),
  evidence_measured_at TEXT NOT NULL CHECK (evidence_measured_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ineligible_ruling_id INTEGER REFERENCES rulings(id),
  evidence             TEXT NOT NULL CHECK (evidence GLOB 'https://*'),
  UNIQUE (repo, issue_no),
  CHECK (ineligible_ruling_id IS NULL OR state = 'refused')
);

CREATE TABLE pipes (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  enabled        INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  window_start   TEXT NOT NULL CHECK (window_start GLOB '[0-2][0-9]:[0-5][0-9]'),
  window_end     TEXT NOT NULL CHECK (window_end GLOB '[0-2][0-9]:[0-5][0-9]'),
  max_concurrent INTEGER NOT NULL CHECK (max_concurrent >= 1)
);

CREATE TABLE plans (
  id        INTEGER PRIMARY KEY,
  pipe_id   INTEGER NOT NULL REFERENCES pipes(id),
  target_id INTEGER REFERENCES targets(id),
  template  TEXT NOT NULL CHECK (template IN ('pr_path', 'research', 'comms')),
  state     TEXT NOT NULL CHECK (state IN ('queued', 'running', 'blocked_on_ceo', 'halted', 'done', 'refused')),
  queued_at TEXT NOT NULL CHECK (queued_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  CHECK (template <> 'pr_path' OR target_id IS NOT NULL)
);

CREATE TABLE runs (
  id            INTEGER PRIMARY KEY,
  plan          INTEGER NOT NULL REFERENCES plans(id),
  step          INTEGER NOT NULL CHECK (step BETWEEN 0 AND 9),
  seat          TEXT NOT NULL REFERENCES rules(id),
  provider      TEXT NOT NULL CHECK (provider IN ('claude-agent-sdk', 'anthropic-api', 'deepseek')),
  model         TEXT NOT NULL,
  effort        TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL CHECK (input_tokens >= 0),
  cache_tokens  INTEGER NOT NULL CHECK (cache_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  seconds       REAL NOT NULL CHECK (seconds >= 0),
  exit          INTEGER NOT NULL CHECK (exit BETWEEN 0 AND 255)
);

CREATE TRIGGER runs_reviewer_not_builder BEFORE INSERT ON runs
WHEN NEW.step IN (4, 5) AND EXISTS (
  SELECT 1 FROM runs r WHERE r.plan = NEW.plan AND r.seat = NEW.seat
    AND (r.step = 2 OR (NEW.step = 5 AND r.step = 4))
)
BEGIN SELECT RAISE(ABORT, 'reviewer != builder'); END;

CREATE TRIGGER runs_reviewer_not_builder_update BEFORE UPDATE OF seat, step, plan ON runs
WHEN NEW.step IN (4, 5) AND EXISTS (
  SELECT 1 FROM runs r WHERE r.plan = NEW.plan AND r.seat = NEW.seat AND r.id <> NEW.id
    AND (r.step = 2 OR (NEW.step = 5 AND r.step = 4))
)
BEGIN SELECT RAISE(ABORT, 'reviewer != builder'); END;

CREATE TABLE verdicts (
  id             INTEGER PRIMARY KEY,
  gate           TEXT NOT NULL CHECK (gate IN ('premise', 'target', 'pre_review', 'review', 'senior_review', 'ready')),
  kind           TEXT NOT NULL CHECK (kind IN ('rail', 'review')),
  subject_digest TEXT NOT NULL CHECK (length(subject_digest) = 64 AND subject_digest GLOB '[0-9a-f]*'),
  plan           INTEGER NOT NULL REFERENCES plans(id),
  step           INTEGER NOT NULL CHECK (step BETWEEN 0 AND 9),
  outcome        TEXT NOT NULL CHECK (outcome IN ('pass', 'refuse', 'needs_ceo')),
  rail_id        TEXT REFERENCES rules(id),
  origin_kind    TEXT CHECK (origin_kind IN ('rail', 'ruling', 'incident')),
  origin_ref     TEXT,
  tokens         INTEGER NOT NULL CHECK (tokens >= 0),
  seconds        REAL NOT NULL CHECK (seconds >= 0),
  CHECK (kind <> 'rail' OR rail_id IS NOT NULL),
  CHECK (outcome <> 'refuse' OR (origin_kind IS NOT NULL AND origin_ref IS NOT NULL)),
  CHECK ((origin_kind IS NULL) = (origin_ref IS NULL))
);

CREATE TABLE approvals (
  id             INTEGER PRIMARY KEY,
  subject_kind   TEXT NOT NULL CHECK (subject_kind IN ('target', 'deliverable', 'override', 'publish')),
  subject_id     INTEGER NOT NULL,
  subject_digest TEXT NOT NULL CHECK (length(subject_digest) = 64 AND subject_digest GLOB '[0-9a-f]*'),
  who            TEXT NOT NULL CHECK (who = 'ceo'),
  approved_at    TEXT NOT NULL CHECK (approved_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  UNIQUE (subject_kind, subject_id, subject_digest)
);

CREATE TABLE deliverables (
  id                        INTEGER PRIMARY KEY,
  plan_id                   INTEGER NOT NULL REFERENCES plans(id),
  step                      INTEGER NOT NULL CHECK (step BETWEEN 0 AND 9),
  seat                      TEXT NOT NULL REFERENCES rules(id),
  diff_digest               TEXT NOT NULL CHECK (length(diff_digest) = 64 AND diff_digest GLOB '[0-9a-f]*'),
  state                     TEXT NOT NULL CHECK (state IN ('built', 'gated', 'ready', 'approved', 'pushed')),
  tests_pass                INTEGER NOT NULL CHECK (tests_pass IN (0, 1)),
  byte_identical_elsewhere  INTEGER NOT NULL CHECK (byte_identical_elsewhere IN (0, 1)),
  fork_ci_green             INTEGER NOT NULL CHECK (fork_ci_green IN (0, 1)),
  bot_clean                 INTEGER NOT NULL CHECK (bot_clean IN (0, 1)),
  target_warm               INTEGER NOT NULL CHECK (target_warm IN (0, 1)),
  approval_id               INTEGER REFERENCES approvals(id),
  evidence                  TEXT NOT NULL CHECK (evidence GLOB 'https://*'),
  CHECK (state NOT IN ('ready', 'approved', 'pushed')
         OR (tests_pass = 1 AND byte_identical_elsewhere = 1 AND fork_ci_green = 1
             AND bot_clean = 1 AND target_warm = 1)),
  CHECK (state NOT IN ('approved', 'pushed') OR approval_id IS NOT NULL)
);

CREATE TABLE dispositions (
  id           INTEGER PRIMARY KEY,
  verdict_id   INTEGER NOT NULL REFERENCES verdicts(id),
  kind         TEXT NOT NULL CHECK (kind IN ('fixed', 'overridden', 'no_change_pass', 'escaped')),
  defect_class TEXT NOT NULL CHECK (defect_class GLOB 'tight.[a-z]*' OR defect_class IN (
    'premise', 'secret', 'authority', 'tier', 'claim', 'test.weakened', 'test.untargeted',
    'identifier.unresolved', 'correctness', 'scope', 'approach', 'minimal', 'register',
    'claim.unverified', 'upstream.number', 'restated.rail', 'stale.verdict', 'not.public',
    'ci.red', 'no.anchor')),
  owner        TEXT NOT NULL CHECK (owner IN ('step0', 'step3', 'review', 'text_review', 'text_rail', 'ready')),
  approval_id  INTEGER REFERENCES approvals(id),
  override_tag TEXT CHECK (override_tag IN ('false_positive', 'accepted_risk')),
  evidence     TEXT NOT NULL CHECK (evidence GLOB 'https://*'),
  CHECK (owner = CASE
    WHEN defect_class GLOB 'tight.[a-z]*'      THEN 'step3'
    WHEN defect_class = 'premise'              THEN 'step0'
    WHEN defect_class = 'secret'               THEN 'step3'
    WHEN defect_class = 'authority'            THEN 'step3'
    WHEN defect_class = 'tier'                 THEN 'step3'
    WHEN defect_class = 'claim'                THEN 'step3'
    WHEN defect_class = 'test.weakened'        THEN 'step3'
    WHEN defect_class = 'test.untargeted'      THEN 'step3'
    WHEN defect_class = 'identifier.unresolved' THEN 'step3'
    WHEN defect_class = 'correctness'          THEN 'review'
    WHEN defect_class = 'scope'                THEN 'review'
    WHEN defect_class = 'approach'             THEN 'review'
    WHEN defect_class = 'minimal'              THEN 'review'
    WHEN defect_class = 'register'             THEN 'text_review'
    WHEN defect_class = 'claim.unverified'     THEN 'text_review'
    WHEN defect_class = 'upstream.number'      THEN 'text_rail'
    WHEN defect_class = 'restated.rail'        THEN 'text_rail'
    WHEN defect_class = 'stale.verdict'        THEN 'ready'
    WHEN defect_class = 'not.public'           THEN 'ready'
    WHEN defect_class = 'ci.red'               THEN 'ready'
    WHEN defect_class = 'no.anchor'            THEN 'ready'
    ELSE 'none' END),
  CHECK ((kind = 'overridden') = (approval_id IS NOT NULL)),
  CHECK ((kind = 'overridden') = (override_tag IS NOT NULL))
);

CREATE TABLE tri (
  id          INTEGER PRIMARY KEY,
  item        TEXT NOT NULL,
  class       TEXT NOT NULL CHECK (class IN ('guard', 'seat', 'ticket', 'cron', 'script', 'prose')),
  disposition TEXT NOT NULL,
  owner       TEXT NOT NULL CHECK (owner IN ('python_specialist', 'ceo', 'coo', 'backend_devops_eng')),
  evidence    TEXT NOT NULL CHECK (evidence GLOB 'https://*'),
  UNIQUE (class, item),
  CHECK (class <> 'guard'  OR disposition IN ('war_story', 'retire')),
  CHECK (class <> 'seat'   OR disposition IN ('recard', 'retire')),
  CHECK (class <> 'ticket' OR disposition IN ('issue', 'closed')),
  CHECK (class <> 'cron'   OR disposition IN ('tick', 'retire')),
  CHECK (class <> 'script' OR disposition = 'evidence_only'),
  CHECK (class <> 'prose'  OR disposition IN ('row', 'fixture', 'retire')),
  CHECK (class <> 'guard'  OR owner = 'python_specialist'),
  CHECK (class <> 'prose'  OR owner = 'python_specialist'),
  CHECK (class <> 'seat'   OR owner = 'ceo'),
  CHECK (class <> 'ticket' OR owner = 'coo'),
  CHECK (class <> 'cron'   OR owner = 'backend_devops_eng')
);
