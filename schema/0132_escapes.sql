CREATE TABLE escape_counts (
  repo    TEXT NOT NULL,
  number  INTEGER NOT NULL,
  plan    INTEGER NOT NULL,
  escapes INTEGER NOT NULL,
  PRIMARY KEY (repo, number)
);

CREATE TABLE escapes (
  id     INTEGER PRIMARY KEY,
  repo   TEXT NOT NULL,
  number INTEGER NOT NULL,
  area   TEXT NOT NULL,
  line   INTEGER NOT NULL,
  author TEXT NOT NULL,
  role   TEXT NOT NULL,
  text   TEXT NOT NULL,
  url    TEXT NOT NULL
);
