DROP VIEW machine_window;

CREATE VIEW machine_window AS
  SELECT k.kind,
    (SELECT count(*) FROM runs r WHERE julianday(r.at) >= julianday('now', k.since)) AS runs,
    (SELECT coalesce(sum(r.input_tokens + r.cache_read_tokens + r.output_tokens), 0)
       FROM runs r WHERE julianday(r.at) >= julianday('now', k.since)) AS tokens,
    (SELECT f.utilisation FROM usage_fresh f WHERE f.kind = k.kind) AS utilisation,
    (SELECT f.status      FROM usage_fresh f WHERE f.kind = k.kind) AS status,
    (SELECT f.observed_at FROM usage_fresh f WHERE f.kind = k.kind) AS observed_at,
    (SELECT f.resets_at   FROM usage_fresh f WHERE f.kind = k.kind) AS resets_at,
    c.dial, c.band, c.ceiling, c.cap,
    (SELECT coalesce(sum(r.input_tokens - coalesce(r.cache_write_tokens, 0)), 0)
       FROM runs r WHERE julianday(r.at) >= julianday('now', k.since)) AS uncached_tokens,
    (SELECT coalesce(sum(coalesce(r.cache_write_tokens, 0)), 0)
       FROM runs r WHERE julianday(r.at) >= julianday('now', k.since)) AS cache_write_tokens,
    (SELECT coalesce(sum(r.cache_read_tokens), 0)
       FROM runs r WHERE julianday(r.at) >= julianday('now', k.since)) AS cache_read_tokens,
    (SELECT coalesce(sum(r.output_tokens), 0)
       FROM runs r WHERE julianday(r.at) >= julianday('now', k.since)) AS output_tokens
  FROM (SELECT 'five_hour' AS kind, '-5 hour' AS since
        UNION ALL SELECT 'seven_day', '-7 day') k, lane_cap c;
