-- #89 (66c). A path the build wrote outside its brief's `## Files` is recorded beside the list, marked,
-- so #88's overlap check reads what was written while the fence, the rails and the handout still read
-- only what the brief named.
ALTER TABLE plan_files ADD COLUMN stray INTEGER NOT NULL DEFAULT 0 CHECK (stray IN (0, 1));
