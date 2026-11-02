CREATE TABLE precedent_findings (
  id       INTEGER PRIMARY KEY,
  repo     TEXT NOT NULL,
  number   INTEGER NOT NULL,
  finding  TEXT NOT NULL,
  area     TEXT NOT NULL,
  acted_on TEXT NOT NULL CHECK (acted_on IN ('fixed', 'agreed', 'ignored')),
  source   TEXT NOT NULL
);
