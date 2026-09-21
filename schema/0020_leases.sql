-- Ruling 2026-09-19 (#65): a tick leases every plan it steps. Two ticks alive at once step disjoint
-- plans, and a plan a slow seat holds costs one slot rather than the whole lane.
CREATE TABLE leases (
  plan     INTEGER NOT NULL REFERENCES plans(id),
  pid      INTEGER NOT NULL CHECK (pid > 0),
  taken_at TEXT NOT NULL CHECK (taken_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);

-- `store/leases.ts:take` upserts on this index; it is what makes the take one statement.
CREATE UNIQUE INDEX leases_one_per_plan ON leases (plan);

INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no, supersedes) VALUES
  ('sequencer.lease', 'one_per_plan_taken_before_the_fire_and_cleared_on_settle', 'ruling', 'ceo-2026-09-19', 'ceo', '2026-09-19', 42, NULL),
  ('sequencer.lease_ceiling', 'a_lease_older_than_three_hours_is_a_dead_holders', 'ruling', 'ceo-2026-09-19', 'ceo', '2026-09-19', 42, NULL);
