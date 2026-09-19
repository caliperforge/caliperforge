-- Ruling 2026-09-19: the COO reads the brief of the first ten jobs before a builder runs on one.
-- The row is the count and the limit both; at '0' step 1 walks into step 2 untouched.
INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at) VALUES
  ('brief.reads_left', '10', 'pr', 'ruling', 'ceo-2026-09-19', '2026-09-19');

INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no, supersedes) VALUES
  ('brief.read', 'the_coo_reads_the_first_ten_briefs_before_the_build', 'ruling', 'ceo-2026-09-19', 'ceo', '2026-09-19', 48, NULL);
