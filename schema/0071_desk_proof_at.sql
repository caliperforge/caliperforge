ALTER TABLE desk_posts ADD COLUMN proof_at TEXT;
UPDATE desk_posts SET proof_at = written_date;
