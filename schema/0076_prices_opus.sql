ALTER TABLE prices ADD COLUMN cache_write_1h REAL CHECK (cache_write_1h >= 0);

ALTER TABLE runs ADD COLUMN cache_write_1h_tokens INTEGER CHECK (cache_write_1h_tokens >= 0);

INSERT INTO prices (provider, model, input, cache_write, cache_write_1h, cache_read, output, effective_from, source_url) VALUES
  ('claude-agent-sdk', 'claude-opus-5-5', 4, 5, 8, 0.20, 20, '2026-01-01', 'https://platform.claude.com/docs/en/about-claude/pricing'),
  ('claude-agent-sdk', 'claude-opus-5', 5, 6.25, 10, 0.50, 25, '2026-01-01', 'https://platform.claude.com/docs/en/about-claude/pricing');

-- Every cache write the machine has made is a 1-hour write.
UPDATE runs SET cache_write_1h_tokens = cache_write_tokens WHERE provider = 'claude-agent-sdk';

UPDATE runs SET cost_computed_usd = (
    SELECT ((runs.input_tokens - runs.cache_write_tokens) * p.input + (runs.cache_write_tokens - runs.cache_write_1h_tokens) * p.cache_write
      + runs.cache_write_1h_tokens * p.cache_write_1h + runs.cache_read_tokens * p.cache_read + runs.output_tokens * p.output) / 1e6
    FROM prices p WHERE p.provider = runs.provider AND p.model = runs.model AND julianday(p.effective_from) <= julianday(runs.at)
    ORDER BY julianday(p.effective_from) DESC LIMIT 1)
  WHERE cache_write_tokens IS NOT NULL;
