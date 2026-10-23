ALTER TABLE records ADD COLUMN bot_by TEXT;
ALTER TABLE records ADD COLUMN bot_at TEXT;
ALTER TABLE records ADD COLUMN findings INTEGER;
ALTER TABLE records ADD COLUMN mergeable TEXT;
ALTER TABLE records ADD COLUMN ball TEXT CHECK (ball IN ('us', 'them'));
