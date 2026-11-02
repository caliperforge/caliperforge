CREATE TABLE openings_new (
  id         INTEGER PRIMARY KEY,
  repo       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('deferred', 'asked', 'repeated', 'drift')),
  area       TEXT NOT NULL,
  quote      TEXT NOT NULL,
  said_by    TEXT NOT NULL,
  source     TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'taken', 'done', 'dismissed')),
  UNIQUE (repo, kind, area, source)
);
INSERT INTO openings_new (id, repo, kind, area, quote, said_by, source, first_seen, status)
  SELECT id, repo, kind, area, quote, said_by, source, first_seen, status
    FROM openings;
DROP TABLE openings;
ALTER TABLE openings_new RENAME TO openings;

CREATE TABLE parity_hashes (
  repo   TEXT NOT NULL,
  path   TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (repo, path)
);
