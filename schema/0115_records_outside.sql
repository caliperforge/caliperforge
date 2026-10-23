CREATE TABLE records_new (
  repo TEXT NOT NULL CHECK (repo GLOB '*/*'),
  pr INTEGER NOT NULL,
  plan INTEGER REFERENCES plans (id),
  url TEXT NOT NULL,
  state TEXT NOT NULL,
  merged_at TEXT,
  word_by TEXT,
  word_at TEXT,
  word TEXT,
  read_at TEXT NOT NULL,
  title TEXT,
  opened_at TEXT,
  PRIMARY KEY (repo, pr)
);
INSERT INTO records_new (repo, pr, plan, url, state, merged_at, word_by, word_at, word, read_at)
  SELECT repo, pr, plan, url, state, merged_at, word_by, word_at, word, read_at
    FROM records;
DROP TABLE records;
ALTER TABLE records_new RENAME TO records;
