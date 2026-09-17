PRAGMA foreign_keys = OFF;

-- Kernel issue 21: priority inside a lane, a global lane cap the CEO dials by hand, and a band
-- the provider's usage window steps that cap down through.

-- P0 is first. The column default only backfills the rows 0009 left; a plan queued from now on
-- takes `priority.default.<template>` below.
ALTER TABLE plans ADD COLUMN priority INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 9);

-- `who` records whose hand a value came from: the dial is the CEO's, every other row is a PR's.
-- A `lanes.band.*` row has no runtime writer — `store/lanes.ts:set` refuses the key, and a new
-- key is born in a migration, so the band moves only through a reviewed diff.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY CHECK (key GLOB '[a-z][a-z0-9_.]*'),
  value       TEXT NOT NULL CHECK (value <> '' AND value NOT GLOB '*[^-0-9a-z_.]*'),
  who         TEXT NOT NULL CHECK (who IN ('ceo', 'pr')),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('rail', 'ruling', 'incident')),
  origin_ref  TEXT NOT NULL,
  set_at      TEXT NOT NULL CHECK (set_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);

-- One row per rate-limit reading the provider emits. The SDK speaks only when the status changes,
-- so a row is stale by design between transitions and `lanes.stale_seconds` decides what counts.
CREATE TABLE usage (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('five_hour', 'seven_day')),
  utilisation REAL NOT NULL CHECK (utilisation >= 0),
  status      TEXT NOT NULL CHECK (status IN ('allowed', 'allowed_warning', 'rejected')),
  resets_at   TEXT NOT NULL CHECK (resets_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  observed_at TEXT NOT NULL CHECK (observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  UNIQUE (kind, observed_at)
);

INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at) VALUES
  ('lanes.dial',               '2',     'ceo', 'ruling', 'kernel-issue-21', '2026-09-17'),
  ('lanes.ceiling',            '4',     'pr',  'ruling', 'kernel-issue-21', '2026-09-17'),
  ('lanes.stale_seconds',      '21600', 'pr',  'ruling', 'kernel-issue-21', '2026-09-17'),
  ('lanes.band.p30',           '3',     'pr',  'ruling', 'kernel-issue-21', '2026-09-17'),
  ('lanes.band.p60',           '2',     'pr',  'ruling', 'kernel-issue-21', '2026-09-17'),
  ('lanes.band.p80',           '1',     'pr',  'ruling', 'kernel-issue-21', '2026-09-17'),
  ('lanes.band.p100',          'spot',  'pr',  'ruling', 'kernel-issue-21', '2026-09-17'),
  ('priority.default.pr_path',  '1',    'pr',  'ruling', 'kernel-issue-21', '2026-09-17'),
  ('priority.default.research', '2',    'pr',  'ruling', 'kernel-issue-21', '2026-09-17'),
  ('priority.default.comms',    '3',    'pr',  'ruling', 'kernel-issue-21', '2026-09-17');

-- The key's suffix is the utilisation ceiling in percent; `spot` is a cap of nothing running.
CREATE VIEW lane_bands AS
  SELECT CAST(substr(key, 13) AS INTEGER) AS pct,
         CASE value WHEN 'spot' THEN 0 ELSE CAST(value AS INTEGER) END AS cap
  FROM settings
  WHERE key GLOB 'lanes.band.p[0-9]*';

-- The latest row per window, dropped once it is older than `lanes.stale_seconds`: a six-hour-old
-- 0.10 is not a reading of now and would otherwise pin three lanes open.
CREATE VIEW usage_fresh AS
  SELECT u.kind, u.utilisation, u.status, u.resets_at, u.observed_at
  FROM usage u
  WHERE u.id = (SELECT max(w.id) FROM usage w WHERE w.kind = u.kind)
    AND (julianday('now') - julianday(u.observed_at)) * 86400.0
        <= (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'lanes.stale_seconds');

-- `band` is NULL with no fresh reading, and the dial then stands alone. Where both windows read,
-- the fuller one rules. The dial never exceeds the band and neither exceeds the ceiling.
CREATE VIEW lane_cap AS
  WITH dial(n)    AS (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'lanes.dial'),
       ceiling(n) AS (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'lanes.ceiling'),
       band(n)    AS (SELECT min(coalesce(
                        (SELECT b.cap FROM lane_bands b WHERE b.pct >= f.utilisation * 100 ORDER BY b.pct LIMIT 1),
                        (SELECT min(b.cap) FROM lane_bands b)))
                      FROM usage_fresh f)
  SELECT d.n AS dial, b.n AS band, c.n AS ceiling,
         min(d.n, coalesce(b.n, d.n), c.n) AS cap
  FROM dial d, ceiling c, band b;

-- D4: what the Machine page reads. Two rows, always, one per window: the tokens our runs spent
-- inside it, the provider's own utilisation of it, and the cap that came out of both.
CREATE VIEW machine_window AS
  SELECT k.kind,
    (SELECT count(*) FROM runs r WHERE julianday(r.at) >= julianday('now', k.since)) AS runs,
    (SELECT coalesce(sum(r.input_tokens + r.cache_tokens + r.output_tokens), 0)
       FROM runs r WHERE julianday(r.at) >= julianday('now', k.since)) AS tokens,
    (SELECT f.utilisation FROM usage_fresh f WHERE f.kind = k.kind) AS utilisation,
    (SELECT f.status      FROM usage_fresh f WHERE f.kind = k.kind) AS status,
    (SELECT f.observed_at FROM usage_fresh f WHERE f.kind = k.kind) AS observed_at,
    (SELECT f.resets_at   FROM usage_fresh f WHERE f.kind = k.kind) AS resets_at,
    c.dial, c.band, c.ceiling, c.cap
  FROM (SELECT 'five_hour' AS kind, '-5 hour' AS since
        UNION ALL SELECT 'seven_day', '-7 day') k, lane_cap c;

INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no, supersedes)
  SELECT 'sequencer.tick', 'one_pipe_up_to_max_concurrent_plans_one_step_each', 'ruling',
         'ceo-2026-09-17', 'ceo', '2026-09-17', 21,
         (SELECT id FROM rulings WHERE subject = 'sequencer.tick'
            AND value = 'one_pipe_one_plan_one_step' ORDER BY id DESC LIMIT 1);

INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no, supersedes) VALUES
  ('plans.priority', 'p0_first_default_from_the_template', 'ruling', 'ceo-2026-09-17', 'ceo', '2026-09-17', 21, NULL),
  ('lanes.dial', 'ceo_by_hand_the_machine_never_exceeds_it', 'ruling', 'ceo-2026-09-17', 'ceo', '2026-09-17', 21, NULL),
  ('lanes.band', 'rows_in_settings_changed_by_pr', 'ruling', 'ceo-2026-09-17', 'ceo', '2026-09-17', 21, NULL),
  ('lanes.usage', 'seven_day_and_five_hour_a_stale_reading_is_refused', 'ruling', 'ceo-2026-09-17', 'ceo', '2026-09-17', 21, NULL);

PRAGMA foreign_keys = ON;
