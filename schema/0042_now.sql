CREATE TABLE now (
  plan   INTEGER PRIMARY KEY REFERENCES plans(id),
  doing  TEXT NOT NULL,
  detail TEXT NOT NULL,
  since  TEXT NOT NULL CHECK (since GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  pid    INTEGER NOT NULL CHECK (pid > 0)
);
