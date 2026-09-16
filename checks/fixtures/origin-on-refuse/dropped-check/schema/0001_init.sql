CREATE TABLE verdicts (
  id             INTEGER PRIMARY KEY,
  gate           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  plan           INTEGER NOT NULL,
  step           INTEGER NOT NULL,
  outcome        TEXT NOT NULL,
  origin_kind    TEXT,
  origin_ref     TEXT,
  tokens         INTEGER NOT NULL,
  seconds        REAL NOT NULL
);
