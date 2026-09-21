-- Every refusal a plan takes, so the cap counts repeats and not rounds (#76). A blip is a checkout
-- the network failed; it moves no step and counts only against other blips in a row.
CREATE TABLE refusals (
  id          INTEGER PRIMARY KEY,
  plan        INTEGER NOT NULL REFERENCES plans(id),
  step        INTEGER NOT NULL CHECK (step BETWEEN 0 AND 9),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  diff        TEXT CHECK (diff IS NULL OR length(diff) = 64),
  blip        INTEGER NOT NULL CHECK (blip IN (0, 1)),
  cleared     INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1)),
  at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX refusals_by_plan ON refusals (plan, id);
