-- The settled brief's `## Files`, parsed once by sequencer/brief.ts and written only by store/files.ts.
CREATE TABLE plan_files (
  plan     INTEGER NOT NULL REFERENCES plans(id),
  path     TEXT NOT NULL,
  is_new   INTEGER NOT NULL CHECK (is_new IN (0, 1)),
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (plan, position)
);
