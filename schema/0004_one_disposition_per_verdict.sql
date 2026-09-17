CREATE UNIQUE INDEX dispositions_one_per_verdict ON dispositions (verdict_id);

INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no, supersedes) VALUES
  ('reviewers.packet', 'repo_issue_diff_tight_only', 'ruling', 'buildmap-rev6-decisions', 'ceo', '2026-09-16', 8, NULL),
  ('reviewers.write_paths', 'empty_no_write_tools', 'ruling', 'buildmap-rev6-decisions', 'ceo', '2026-09-16', 8, NULL),
  ('reviewers.verdict', 'span_and_class_on_refuse', 'ruling', 'buildmap-rev6-measurement', 'ceo', '2026-09-16', 8, NULL),
  ('dispositions.per_verdict', 'one_disposition_per_verdict', 'ruling', 'buildmap-rev6-measurement', 'ceo', '2026-09-16', 8, NULL);
