CREATE TABLE desk_posts_next (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  dest         TEXT NOT NULL CHECK (dest IN ('site', 'substack', 'note', 'pack', 'scorecard', 'paste')),
  status       TEXT NOT NULL CHECK (status IN ('proof', 'approved', 'changes', 'published')),
  title        TEXT NOT NULL,
  dek          TEXT NOT NULL,
  body         TEXT NOT NULL,
  edited_title TEXT,
  edited_dek   TEXT,
  edited_body  TEXT,
  note         TEXT,
  sources      TEXT NOT NULL,
  checks       TEXT NOT NULL,
  work_date    TEXT NOT NULL,
  written_date TEXT NOT NULL,
  "order"      INTEGER,
  proof_at     TEXT,
  url          TEXT,
  published_at TEXT
);
INSERT INTO desk_posts_next (id, kind, dest, status, title, dek, body, edited_title, edited_dek, edited_body, note, sources, checks,
  work_date, written_date, "order", proof_at, url, published_at)
SELECT id, kind, dest, status, title, dek, body, edited_title, edited_dek, edited_body, note, sources, checks,
  work_date, written_date, "order", proof_at, url, published_at FROM desk_posts;
DROP TABLE desk_posts;
ALTER TABLE desk_posts_next RENAME TO desk_posts;
