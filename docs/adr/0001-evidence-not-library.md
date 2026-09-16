# ADR 0001 — The old repo is evidence, not a library

Status: accepted · 2026-09-16 · BUILD_MAP rev 6, law 1

## Context
v1 is ~177k lines of `scripts/` and 1,078 guards. Its value is the list of defects it caught,
not the code that caught them. Ported code carries the assumptions that made it go dark.

## Decision
Nothing from `crypto-contributor` is imported, vendored, wrapped or copied. A proven check
enters v2 as a war-story row (P2): incident → defect class → form → fixture → owner. The
fixture is the real case. The code is written new against the fixture.

## Enforcement
- `docs/adr/0007-dependencies.md` is the closed dependency list; no v1 path appears in it,
  and a dependency not on the list fails review.
- `checks/fixture-per-rail`: a rail without a fixture that fails against it is red. A check
  re-specified from v1 cannot land without the case that produced it.
- `tri.class = 'guard'` accepts `war_story` or `retire` only; a guard cannot be carried over
  as itself.
