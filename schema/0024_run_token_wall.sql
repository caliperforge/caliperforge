-- 2026-09-22 (#148). `plan.token_ceiling` stops a JOB at 6M and is only read between steps, so a single
-- run was bounded by nothing but a 30-minute clock that has never fired: 15 runs spent over 5M, 156.5M
-- between them, the worst 21.5M in 27.6 minutes. A wall at 5M sits above p95 (4.30M), so it never reaches
-- a run of ordinary size, and under the 6M job ceiling, so it is always the one that stops first.
INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at) VALUES
  ('run.token_wall', '5000000', 'pr', 'ruling', 'ceo-2026-09-22', '2026-09-22');
