CREATE TABLE precedent_sources_new (
  repo      TEXT NOT NULL,
  number    INTEGER NOT NULL,
  title     TEXT NOT NULL,
  merged_at TEXT,
  merger    TEXT,
  files     TEXT NOT NULL,
  issues    TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
INSERT INTO precedent_sources_new (repo, number, title, merged_at, merger, files, issues)
  SELECT repo, number, title, merged_at, merger, files, issues
    FROM precedent_sources;
DROP TABLE precedent_sources;
ALTER TABLE precedent_sources_new RENAME TO precedent_sources;

CREATE INDEX precedent_sources_merged ON precedent_sources (repo, merged_at);
