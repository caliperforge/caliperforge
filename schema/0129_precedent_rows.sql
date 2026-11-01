CREATE TABLE precedents (
  id        INTEGER PRIMARY KEY,
  repo      TEXT NOT NULL,
  number    INTEGER NOT NULL,
  merged_at TEXT NOT NULL,
  area      TEXT NOT NULL,
  decision  TEXT NOT NULL,
  why       TEXT NOT NULL,
  said_by   TEXT NOT NULL,
  role      TEXT NOT NULL CHECK (role IN ('maintainer', 'contributor')),
  source    TEXT NOT NULL
);

CREATE TABLE precedent_distilled (
  repo   TEXT NOT NULL,
  number INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  PRIMARY KEY (repo, number)
);
