ALTER TABLE bench_scorecard ADD COLUMN pre_fix_calls INTEGER CHECK (pre_fix_calls IS NULL OR pre_fix_calls >= 0);
ALTER TABLE bench_scorecard ADD COLUMN fix_calls INTEGER CHECK (fix_calls IS NULL OR fix_calls >= 0);
