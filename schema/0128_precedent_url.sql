DROP TABLE precedent_threads;

DELETE FROM precedent_sources;

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
  url    TEXT NOT NULL,
  FOREIGN KEY (repo, number) REFERENCES precedent_sources (repo, number),
  CHECK ((path IS NULL) = (line IS NULL))
);
