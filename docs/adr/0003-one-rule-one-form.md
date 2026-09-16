# ADR 0003 — A rule exists in exactly one form

Status: accepted · 2026-09-16 · BUILD_MAP rev 6, law 3

## Context
v1 stated the same rule in a card, a doc and a script. The three drifted, and no seat could
tell which one bound it.

## Decision
A rule is a schema constraint, a rail with a fixture that fails, or a CI check — one of the
three, never two. The seat prompt is the only prose surface: hashed, PR-reviewed, loaded via
`rules`. All other prose is documentation and no seat is told to obey it.

## Enforcement
- `checks/rule-hashes`: a prose surface under `rules/` with no hashed row, or a hash that
  drifted from HEAD, is red.
- `checks/reachability`: a rail that the sequencer cannot reach is red, so a rail cannot be
  the form of a rule without being wired.
- The schema's CHECKs are the constraint form; each one is named in the ADR for its law.
- This file, and every ADR, is documentation: no seat prompt cites it.
