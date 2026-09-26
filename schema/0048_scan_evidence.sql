ALTER TABLE targets ADD COLUMN issue_opened_at TEXT CHECK (issue_opened_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
ALTER TABLE targets ADD COLUMN issue_active_at TEXT CHECK (issue_active_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
ALTER TABLE targets ADD COLUMN open_pr INTEGER CHECK (open_pr > 0);
ALTER TABLE targets ADD COLUMN open_pr_draft INTEGER CHECK (open_pr_draft IN (0, 1));
ALTER TABLE targets ADD COLUMN size_lines INTEGER CHECK (size_lines >= 0);
