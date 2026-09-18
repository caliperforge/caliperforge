PRAGMA foreign_keys = OFF;

-- The receipt a tick leaves behind. launchd keeps no log of its own, so this row is the
-- whole record that the 300-second job ran, what it opened and what it fired.
CREATE TABLE ticks (
  id    INTEGER PRIMARY KEY,
  at    TEXT NOT NULL CHECK (at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  hhmm  TEXT NOT NULL CHECK (hhmm GLOB '[0-2][0-9]:[0-5][0-9]'),
  dry   INTEGER NOT NULL CHECK (dry IN (0, 1)),
  pipes INTEGER NOT NULL CHECK (pipes >= 0),
  fired INTEGER NOT NULL CHECK (fired >= 0),
  exit  INTEGER NOT NULL CHECK (exit BETWEEN 0 AND 255),
  note  TEXT NOT NULL
);

-- Guatemala keeps no daylight saving, so UTC-6 all year is the whole zone rule and one row carries it.
-- Every pipe window is written in that zone and `store/lanes.ts:hhmm` is the only reader.
INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at) VALUES
  ('tick.zone_offset_minutes', '-360', 'pr', 'ruling', 'kernel-issue-28', '2026-09-18');

-- The three lanes the CEO has open. `comms` and `research` carry no step map yet; the sequencer
-- reads such a pipe as on with nothing to step, and P7 writes what they step.
INSERT OR IGNORE INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES
  ('pr-path',  1, '07:00', '22:00', 1),
  ('comms',    1, '07:00', '22:00', 1),
  ('research', 1, '07:00', '22:00', 1);
UPDATE pipes SET enabled = 1, window_start = '07:00', window_end = '22:00', max_concurrent = 1
  WHERE name IN ('pr-path', 'comms', 'research');

INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no, supersedes) VALUES
  ('pipes.window', 'zero_seven_hundred_to_twenty_two_hundred_guatemala', 'ruling', 'ceo-2026-09-18', 'ceo', '2026-09-18', 28, NULL),
  ('pipes.unmapped_lane', 'a_pipe_whose_template_has_no_step_map_is_on_with_nothing_queued', 'ruling', 'ceo-2026-09-18', 'ceo', '2026-09-18', 28, NULL),
  ('adopt.evidence', 'a_v1_pull_request_is_watched_off_its_targets_row_and_v2_pushed_none_of_it', 'ruling', 'ceo-2026-09-18', 'ceo', '2026-09-18', 28, NULL),
  ('tick.cadence', 'launchd_every_three_hundred_seconds_with_the_receipt_in_the_store', 'ruling', 'ceo-2026-09-18', 'ceo', '2026-09-18', 28, NULL);

PRAGMA foreign_keys = ON;
