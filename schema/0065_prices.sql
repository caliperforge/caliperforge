CREATE TABLE prices (
  id             INTEGER PRIMARY KEY,
  provider       TEXT NOT NULL CHECK (provider IN ('claude-agent-sdk', 'anthropic-api', 'deepseek')),
  model          TEXT NOT NULL,
  input          REAL NOT NULL CHECK (input >= 0),
  cache_read     REAL NOT NULL CHECK (cache_read >= 0),
  cache_write    REAL NOT NULL CHECK (cache_write >= 0),
  output         REAL NOT NULL CHECK (output >= 0),
  effective_from TEXT NOT NULL CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  source_url     TEXT NOT NULL CHECK (source_url GLOB 'https://*'),
  UNIQUE (provider, model, effective_from)
);

ALTER TABLE runs ADD COLUMN cost_computed_usd REAL CHECK (cost_computed_usd >= 0);
