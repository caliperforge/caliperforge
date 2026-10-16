ALTER TABLE bench_scorecard ADD COLUMN x_ray INTEGER CHECK (x_ray IN (0, 1));
