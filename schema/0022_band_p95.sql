-- CEO 2026-09-21: a step between p80 and p100. From 80% to 95% of a window the machine keeps one lane;
-- only past 95% is it spot.
INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at) VALUES
  ('lanes.band.p95', '1', 'pr', 'ruling', 'ceo-2026-09-21', '2026-09-21');
