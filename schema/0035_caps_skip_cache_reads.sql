-- CEO 2026-09-24: cache reads are recorded and shown, never capped. From here `runs.cache_tokens` is cache
-- reads alone and a cache write counts as input. Reads were 92.7% of every token spent (transcripts to
-- 09-24), so the two caps are scaled to hold the same brake on what is left: 5M -> 400K a run, 6M -> 500K a job.
UPDATE settings SET value = '400000', who = 'pr', origin_kind = 'ruling', origin_ref = 'ceo-2026-09-24', set_at = '2026-09-24'
  WHERE key = 'run.token_wall';
UPDATE settings SET value = '500000', who = 'pr', origin_kind = 'ruling', origin_ref = 'ceo-2026-09-24', set_at = '2026-09-24'
  WHERE key = 'plan.token_ceiling';
