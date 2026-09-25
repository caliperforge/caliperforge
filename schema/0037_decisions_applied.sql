-- #238. What became of a decision once the orchestrator may act: applied as the matching `cf` command
-- would, escalated to a person, or capped because the plan had been moved too often that day. NULL is shadow.
ALTER TABLE decisions ADD COLUMN applied TEXT CHECK (applied IS NULL OR applied IN ('applied', 'escalated', 'capped'));
