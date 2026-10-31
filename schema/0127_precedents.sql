CREATE TABLE precedent_sources (
  repo      TEXT NOT NULL,
  number    INTEGER NOT NULL,
  title     TEXT NOT NULL,
  merged_at TEXT NOT NULL,
  merger    TEXT,
  files     TEXT NOT NULL,
  issues    TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

CREATE INDEX precedent_sources_merged ON precedent_sources (repo, merged_at);

CREATE TABLE precedent_threads (
  id     INTEGER PRIMARY KEY,
  repo   TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  author TEXT NOT NULL,
  role   TEXT NOT NULL,
  text   TEXT NOT NULL,
  path   TEXT,
  line   INTEGER,
  FOREIGN KEY (repo, number) REFERENCES precedent_sources (repo, number),
  CHECK ((path IS NULL) = (line IS NULL))
);
