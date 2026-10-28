CREATE TABLE bench_scorecard_new (
  id              INTEGER PRIMARY KEY,
  plan            INTEGER NOT NULL REFERENCES plans(id),
  target          TEXT NOT NULL CHECK (target <> ''),
  generator       TEXT NOT NULL CHECK (generator <> ''),
  catches         INTEGER NOT NULL CHECK (catches >= 0),
  false_positives INTEGER NOT NULL CHECK (false_positives >= 0),
  untested        INTEGER CHECK (untested IS NULL OR untested >= 0),
  tokens          INTEGER NOT NULL CHECK (tokens >= 0),
  seconds         REAL NOT NULL CHECK (seconds >= 0),
  x_ray           INTEGER CHECK (x_ray IN (0, 1)),
  superseded      INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1)),
  pre_fix_calls   INTEGER CHECK (pre_fix_calls IS NULL OR pre_fix_calls >= 0),
  fix_calls       INTEGER CHECK (fix_calls IS NULL OR fix_calls >= 0),
  not_powered     TEXT CHECK (not_powered IS NULL OR not_powered IN ('wall', 'reduced_generate', 'few_properties', 'pre_fix_calls', 'fix_calls', 'compile_failed'))
);
INSERT INTO bench_scorecard_new (id, plan, target, generator, catches, false_positives, untested, tokens, seconds, x_ray, superseded, pre_fix_calls, fix_calls, not_powered)
  SELECT id, plan, target, generator, catches, false_positives, untested, tokens, seconds, x_ray, superseded, pre_fix_calls, fix_calls, not_powered
    FROM bench_scorecard;
DROP TABLE bench_scorecard;
ALTER TABLE bench_scorecard_new RENAME TO bench_scorecard;
CREATE UNIQUE INDEX bench_scorecard_one_live ON bench_scorecard (plan) WHERE superseded = 0;
