-- `signals.left_alone` holds the review decision `sequencer/capture.ts` reads off the pull request,
-- so a later ruling names another decision by superseding the row rather than by a code change.
INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no, supersedes) VALUES
  ('signals.left_alone', 'approved', 'ruling', 'ceo-2026-09-18', 'ceo', '2026-09-18', 39, NULL),
  ('signals.pre_adoption', 'a_signal_older_than_the_plan_is_recorded_and_never_replayed', 'ruling', 'ceo-2026-09-18', 'ceo', '2026-09-18', 39, NULL),
  ('adopt.issue_packet', 'the_pr_body_and_the_issue_it_closes_are_what_a_review_reads_the_plan_against', 'ruling', 'ceo-2026-09-18', 'ceo', '2026-09-18', 39, NULL);
