-- #130 (#60 part a). What a merge from main brought in, set against what the job had changed since it
-- was cut, and whether the two touch the same file. Data first: nothing reads the overlap yet.
CREATE TABLE merges (
  id INTEGER PRIMARY KEY,
  plan INTEGER NOT NULL REFERENCES plans(id),
  step INTEGER NOT NULL,
  at TEXT NOT NULL,
  main TEXT NOT NULL CHECK (length(main) = 40 AND main GLOB '[0-9a-f]*'),
  incoming TEXT NOT NULL,
  mine TEXT NOT NULL,
  overlap INTEGER NOT NULL CHECK (overlap IN (0, 1))
);

CREATE INDEX merges_plan ON merges (plan);
