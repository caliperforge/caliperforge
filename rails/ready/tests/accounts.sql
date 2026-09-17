INSERT INTO accounts (repo, measured_at, maintainers, doors, last_outsider_merge, open_pr_age_p50_days, cross_repo_activity, pulse, evidence) VALUES
  ('upstream-org/project', '2026-09-15', 4, 2, '2026-09-08', 6, 3, 'warm', 'https://github.com/upstream-org/project/pulse'),
  ('cold-org/project', '2026-07-01', 1, 1, '2026-06-30', 4, 0, 'warm', 'https://github.com/cold-org/project/pulse'),
  ('parked-org/project', '2026-09-15', 2, 1, NULL, 40, 0, 'cold', 'https://github.com/parked-org/project/pulse');
