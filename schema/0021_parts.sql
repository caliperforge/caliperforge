-- #72: a ticket the brief writer finds is more than one job comes back as parts in the order they
-- land. Each part is filed as its own issue; only the first is queued, and each landing queues the
-- next, so the order is kept without a ticket waiting on another. `plan` is set once a part is queued.
CREATE TABLE parts (
  parent INTEGER NOT NULL REFERENCES plans(id),
  n      INTEGER NOT NULL CHECK (n >= 0),
  url    TEXT NOT NULL UNIQUE CHECK (url GLOB 'https://*/issues/*'),
  title  TEXT NOT NULL,
  body   TEXT NOT NULL,
  plan   INTEGER UNIQUE REFERENCES plans(id),
  PRIMARY KEY (parent, n)
);
