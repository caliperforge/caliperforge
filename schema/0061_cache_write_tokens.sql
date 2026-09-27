ALTER TABLE runs ADD COLUMN cache_write_tokens INTEGER CHECK (cache_write_tokens >= 0);
