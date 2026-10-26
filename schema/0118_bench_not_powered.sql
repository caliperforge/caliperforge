ALTER TABLE bench_scorecard ADD COLUMN not_powered TEXT CHECK (not_powered IS NULL OR not_powered IN ('wall', 'reduced_generate', 'pre_fix_calls', 'fix_calls'));
UPDATE bench_scorecard SET not_powered = CASE
  WHEN pre_fix_calls IS NULL OR pre_fix_calls < 250000 THEN 'pre_fix_calls'
  WHEN fix_calls IS NULL OR fix_calls < 250000 THEN 'fix_calls'
END;
