-- CEO 2026-09-28, weekly window at 81%: "we can keep pushing". p80 and p95 open to 8, above the ceiling, so the dial rules.
UPDATE settings SET value = '8', who = 'pr', origin_kind = 'ruling', origin_ref = 'ceo-2026-09-28', set_at = '2026-09-28'
  WHERE key IN ('lanes.band.p80', 'lanes.band.p95');
