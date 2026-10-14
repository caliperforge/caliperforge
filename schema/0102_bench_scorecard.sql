CREATE TABLE bench_scorecard (
  id              INTEGER PRIMARY KEY,
  plan            INTEGER NOT NULL UNIQUE REFERENCES plans(id),
  target          TEXT NOT NULL CHECK (target <> ''),
  generator       TEXT NOT NULL CHECK (generator <> ''),
  catches         INTEGER NOT NULL CHECK (catches >= 0),
  false_positives INTEGER NOT NULL CHECK (false_positives >= 0),
  untested        INTEGER NOT NULL CHECK (untested >= 0),
  tokens          INTEGER NOT NULL CHECK (tokens >= 0),
  seconds         REAL NOT NULL CHECK (seconds >= 0)
);
