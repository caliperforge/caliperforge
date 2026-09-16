# ADR 0004 — Every refusal carries an origin

Status: accepted · 2026-09-16 · BUILD_MAP rev 6, law 4

## Context
A refusal without a source is an opinion. v1 refusals could not be audited, appealed or
attributed, so a false positive cost the same as a real catch.

## Decision
A refusal names a typed origin: a rail, a ruling or an incident. A refusal that cannot name
one does not compile and does not persist.

## Enforcement
- `verdicts`: `CHECK (outcome <> 'refuse' OR (origin_kind IS NOT NULL AND origin_ref IS NOT NULL))`
  with `CHECK (origin_kind IN ('rail','ruling','incident'))`.
- `verdicts`: `CHECK (kind <> 'rail' OR rail_id IS NOT NULL)`.
- `rulings` carries the same typed pair, so a ruling-origin resolves to a row, not a sentence.
- `checks/origin-on-refuse`: a refuse verdict constructed without a typed `Origin` is red.
