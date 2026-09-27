CREATE TABLE gardens (
  day    TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  metric TEXT NOT NULL CHECK (metric IN ('citing-comment', 'lines', 'prepare', 'silent-catch', 'test-name')),
  url    TEXT NOT NULL
);
