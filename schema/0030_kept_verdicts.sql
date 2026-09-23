-- #131 (#60 part b). A merge that went through and touched none of the job's files lets the earlier
-- review verdicts stand. `clean` says the merge went through; `verdict` is the newest verdict on the
-- plan when it was made, so only a verdict already given can be kept. A kept row names its merge.
ALTER TABLE merges ADD COLUMN clean INTEGER CHECK (clean IN (0, 1));
ALTER TABLE merges ADD COLUMN verdict INTEGER;
ALTER TABLE verdicts ADD COLUMN kept_by INTEGER REFERENCES merges(id);
