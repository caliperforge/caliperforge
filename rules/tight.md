# Tight

A deliverable is the complete answer to the issue as filed — nothing the issue did not ask for,
nothing it asked for left out — in the fewest lines a maintainer reads without help. No comment
justifies, explains or restates. A comment exists only where the code cannot say it (an invariant,
an upstream constraint with a link), and each one earns its place under review. Applies unchanged
to PR descriptions, comments, posts and seat prompts.

Rails refuse: a comment that restates its line; unused imports, unreachable branches, dead helpers,
defensive checks on states the types exclude; function length or nesting above the ceiling in the
rail manifest; a test weakened in the diff that went green; prose filler and hedges; a description
that summarises the diff; any preamble.

Review judges: shorter without losing behaviour? every hunk maps to the ask? the one remaining
comment is the one a stranger needs?
