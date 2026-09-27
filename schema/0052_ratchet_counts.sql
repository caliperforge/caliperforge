CREATE TABLE ratchet_counts (
  day    TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  metric TEXT NOT NULL CHECK (metric IN ('citing-comment', 'lines', 'prepare', 'silent-catch', 'test-name')),
  count  INTEGER NOT NULL CHECK (typeof(count) = 'integer' AND count >= 0),
  PRIMARY KEY (day, metric)
);
