ALTER TABLE tickets ADD COLUMN opened_at TEXT;
ALTER TABLE tickets ADD COLUMN closed_at TEXT;
ALTER TABLE tickets ADD COLUMN kind TEXT CHECK (kind IN ('fix', 'build'));
