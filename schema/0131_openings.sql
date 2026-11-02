CREATE TABLE openings (
  id         INTEGER PRIMARY KEY,
  repo       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('deferred', 'asked', 'repeated')),
  area       TEXT NOT NULL,
  quote      TEXT NOT NULL,
  said_by    TEXT NOT NULL,
  source     TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'taken', 'done', 'dismissed')),
  UNIQUE (repo, kind, area, source)
);
