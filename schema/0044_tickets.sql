-- Every open lane-labelled issue intake lists, queued or not. `parent` is the issue number a part's title names,
-- where `parts.parent` is a plan id.
CREATE TABLE tickets (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  lane TEXT NOT NULL,
  priority INTEGER CHECK (priority BETWEEN 0 AND 9),
  after INTEGER,
  parent INTEGER,
  PRIMARY KEY (repo, number)
);
