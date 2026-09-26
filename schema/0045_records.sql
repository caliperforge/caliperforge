CREATE TABLE records (
  repo TEXT NOT NULL CHECK (repo GLOB '*/*'),
  pr INTEGER NOT NULL,
  plan INTEGER NOT NULL REFERENCES plans (id),
  url TEXT NOT NULL,
  state TEXT NOT NULL,
  merged_at TEXT,
  word_by TEXT,
  word_at TEXT,
  word TEXT,
  read_at TEXT NOT NULL,
  PRIMARY KEY (repo, pr)
);
