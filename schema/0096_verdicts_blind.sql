CREATE TABLE verdicts_new (
  id             INTEGER PRIMARY KEY,
  gate           TEXT NOT NULL CHECK (gate IN ('premise', 'target', 'pre_review', 'review', 'senior_review', 'blind_review', 'ready')),
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
  tree           TEXT CHECK (tree IS NULL OR (length(tree) = 40 AND tree GLOB '[0-9a-f]*')),
  kept_by        INTEGER REFERENCES merges(id),
  message        TEXT,
  CHECK (kind <> 'rail' OR rail_id IS NOT NULL),
  CHECK (outcome <> 'refuse' OR (origin_kind IS NOT NULL AND origin_ref IS NOT NULL)),
  CHECK ((origin_kind IS NULL) = (origin_ref IS NULL))
);
INSERT INTO verdicts_new (id, gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds,
    tree, kept_by, message)
  SELECT id, gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds, tree, kept_by, message
    FROM verdicts;
DROP TABLE verdicts;
ALTER TABLE verdicts_new RENAME TO verdicts;
