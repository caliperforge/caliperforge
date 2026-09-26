ALTER TABLE parts ADD COLUMN after INTEGER CHECK (after IS NULL OR (after >= 0 AND after < n));
UPDATE parts SET after = n - 1 WHERE n > 0;
