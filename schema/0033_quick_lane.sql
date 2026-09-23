-- The gate rows a cosmetic-only round settled in place, for #57's per-ticket usage report to count.
ALTER TABLE verdicts ADD COLUMN quick_lane INTEGER NOT NULL DEFAULT 0 CHECK (quick_lane IN (0, 1));
