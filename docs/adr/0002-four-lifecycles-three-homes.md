# ADR 0002 — Four lifecycles, three homes

Status: accepted · 2026-09-16 · BUILD_MAP rev 6, law 2

## Context
v1 mixed rules, records and reports across files, prose and code. A number on a page could
not be traced to the row that produced it, and a rule could be edited without review.

## Decision
- Rules and code live in git: text, PR-reviewed, loaded read-only with a content hash.
- Records and work live in SQLite (`cf.db`, gitignored, nightly dump committed).
- Reports are queries. No report is stored.

## Enforcement
- `schema/0001_init.sql`: `rules` holds `content_hash`; `runs.seat`, `deliverables.seat` and
  `verdicts.rail_id` are FKs into it. A record cannot reference a rule that was not loaded.
- No table in the schema holds a report; a site number is the SELECT (P8 done-when).
- Every table's only free-text column is one `evidence` link, `CHECK (evidence GLOB 'https://*')`.
- `checks/rule-hashes`: a `rules` row whose hash differs from the file at HEAD is red.
