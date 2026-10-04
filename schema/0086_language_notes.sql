CREATE TABLE language_notes (
  id      INTEGER PRIMARY KEY,
  plan    INTEGER NOT NULL REFERENCES plans(id),
  seat    TEXT NOT NULL,
  file    TEXT NOT NULL,
  line    INTEGER NOT NULL CHECK (line > 0),
  old     TEXT NOT NULL,
  new     TEXT NOT NULL,
  why     TEXT NOT NULL,
  at      TEXT NOT NULL,
  used_by INTEGER REFERENCES plans(id),
  used_at TEXT,
  CHECK ((used_by IS NULL) = (used_at IS NULL))
);
