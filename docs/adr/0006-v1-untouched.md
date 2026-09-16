# ADR 0006 — v1 is untouched

Status: accepted · 2026-09-16 · BUILD_MAP rev 6, law 6

## Context
v1 ships the Solana sprint for the whole v2 build. A patch to v1 during the build breaks the
only running system and destroys the P5 shadow-run baseline.

## Decision
P0 is the only change to v1. Any other change is a CEO ruling, never a seat's initiative.
No war-time patches. v2 writes nothing into `crypto-contributor` before P9.

## Enforcement
- Every seat manifest declares repo-relative write paths; the runner refuses a write outside
  them, and an absolute or repo-escaping path fails manifest validation.
- A v1 change requires a `rulings` row (`who = 'ceo'`, typed `origin`, `issue_no`) before the
  PR; no row, no authority.
- `tri.class = 'script'` accepts `evidence_only` alone: v1 code has no disposition that edits it.
