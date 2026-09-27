ALTER TABLE refusals ADD COLUMN ticket TEXT CHECK (ticket IS NULL OR length(ticket) = 64);
