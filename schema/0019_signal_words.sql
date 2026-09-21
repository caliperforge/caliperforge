-- A maintainer's words reach the builder: the body of a comment or review, and the review's state
-- (CHANGES_REQUESTED goes straight to the build; anything else waits for a person to read it).
ALTER TABLE signals ADD COLUMN body TEXT;
ALTER TABLE signals ADD COLUMN state TEXT;
