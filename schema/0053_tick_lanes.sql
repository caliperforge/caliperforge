CREATE TABLE tick_lanes (
  tick      INTEGER NOT NULL REFERENCES ticks(id),
  pipe      INTEGER NOT NULL REFERENCES pipes(id),
  free      INTEGER NOT NULL CHECK (free >= 0),
  startable INTEGER NOT NULL CHECK (startable >= 0),
  PRIMARY KEY (tick, pipe)
);
