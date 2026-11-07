ALTER TABLE bench_scorecard ADD COLUMN gross_usd REAL CHECK (gross_usd IS NULL OR gross_usd >= 0);
ALTER TABLE bench_scorecard ADD COLUMN net_usd REAL CHECK (net_usd IS NULL OR net_usd >= 0);
