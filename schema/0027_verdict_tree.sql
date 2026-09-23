-- The tree a review judged, so a later round diffs against the verdict itself. A rail leaves it null.
ALTER TABLE verdicts ADD COLUMN tree TEXT
  CHECK (tree IS NULL OR (length(tree) = 40 AND tree GLOB '[0-9a-f]*'));
