CREATE TABLE gardens_next (
  day    TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  metric TEXT NOT NULL CHECK (metric IN ('citing-comment', 'clean', 'lines', 'prepare', 'silent-catch', 'test-name')),
  url    TEXT NOT NULL
);
INSERT INTO gardens_next SELECT day, metric, url FROM gardens;
DROP TABLE gardens;
ALTER TABLE gardens_next RENAME TO gardens;
