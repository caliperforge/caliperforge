-- 2026-09-22. A reading holds until its window resets. The SDK reports only when the status changes, so
-- after `lanes.stale_seconds` of quiet the band fell away and the cap rose to the dial: four lanes at 89%
-- on the morning of 09-22. A window's use only rises until it resets, so its last reading is a floor till then.
DROP VIEW usage_fresh;
CREATE VIEW usage_fresh AS
  SELECT u.kind, u.utilisation, u.status, u.resets_at, u.observed_at
  FROM usage u
  WHERE u.observed_at = (SELECT max(w.observed_at) FROM usage w WHERE w.kind = u.kind)
    AND julianday(u.resets_at) > julianday('now');
DELETE FROM settings WHERE key = 'lanes.stale_seconds';

-- CEO 2026-09-21: a job halts past 6M tokens; a person's retry starts the count again (store/refusals.ts).
INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at) VALUES
  ('plan.token_ceiling', '6000000', 'pr', 'ruling', 'ceo-2026-09-21', '2026-09-21');
