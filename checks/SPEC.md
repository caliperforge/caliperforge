# checks/ — CI that fails the build

Seven checks. Each exits non-zero on red and CI blocks the merge. A check reads the tree at
HEAD and, where named, `cf.db`. None writes.

Fixtures live under `checks/fixtures/<check>/<case>/`. A fixture is proof the check goes red:
the check runs against the fixture directory and CI is red if the fixture passes. A check with
no red fixture is itself red (`fixture-per-rail` covers `rails/`; this rule covers `checks/`).

---

## reachability — ADR 0005

Reads `rails/*/` directory names and the sequencer's rail list in `rules/rails.yaml`.

Red when a directory under `rails/` is absent from the rail list, or a rail-list entry has no
directory. An orphan either way is red. Defined now, before any rail exists: with both sides
empty the check passes; the first rail must appear on both sides in the same commit.

Fixtures: `orphan-dir/` — a rail directory, not in `rails.yaml`. `orphan-entry/` — a
`rails.yaml` entry with no directory.

## origin-on-refuse — ADR 0004

Reads every `.ts` under `rails/` and `reviews/` and the `verdicts` rows in `cf.db`.

Red when a refuse verdict is constructed without a typed `Origin`, when an `Origin` is built
from a string literal that resolves to no rail id, ruling id or incident id, or when a
`verdicts` row has `outcome = 'refuse'` and a NULL `origin_kind` or `origin_ref` — the last is
unreachable while the schema CHECK stands, and the check proves the CHECK stands.

Fixtures: `bare-refuse.ts` — a rail returning `outcome: 'refuse'` with no origin.
`unresolved-origin.ts` — `origin_kind: 'rail'`, `origin_ref` naming no rail.
`dropped-check.sql` — `0001_init.sql` with the refuse CHECK removed; the insert must fail.

## rule-hashes — ADR 0002, ADR 0003

Reads `rules/**` at HEAD and the `rules` table.

Red when a `rules` row's `content_hash` differs from sha256 of the file at its `path`, when a
file under `rules/` has no row, or when a row's `path` names no file. Prose under `rules/` that
is not hashed is prose a seat obeys without review.

Fixtures: `drifted/` — a card edited after load, row hash stale. `unhashed/` — a
`rules/cards/*.md` with no row. `dangling/` — a row whose path was deleted.

## ceilings — BUILD_MAP Closed (rev 4), Tight

Reads every `.ts` in the package and the ceilings in the rail manifest: function ≤ 40 lines,
nesting ≤ 3, zero comments unless an invariant or a linked upstream constraint.

Red when a function exceeds 40 lines, nesting exceeds 3, a comment restates its line or matches
the justifying pattern (*because, in order to, note that, this is needed, to ensure*), or an
exceptions file exists.

Fixtures: `long-function.ts` — 41 lines. `deep-nesting.ts` — four levels.
`restating-comment.ts` — a comment that restates its line. `exceptions-file/` — an eslint
disable file.

## template-validity — ADR 0005

Reads `templates/*.ts`, `rules/roster.yaml` and the step-list schema.

Red when a template's exported step list fails the zod schema, a step names a seat absent from
the roster, a step number falls outside 0–9, a gate step writes no verdict, or the `pr_path`
template's steps are not 0–9 in order.

Fixtures: `unknown-seat.ts` — a step naming a seat not in the roster. `step-out-of-range.ts` —
step 10. `gate-without-verdict.ts` — a gate step with no verdict sink.

## reviewer-not-builder — BUILD_MAP Decisions, Reviewers

Reads `schema/*.sql` applied to a fresh database, and `store/`.

Red when the fresh database lacks `runs_reviewer_not_builder` or
`runs_reviewer_not_builder_update`, when a step-4 run inserts with the seat of the plan's step-2
run, when a step-5 run inserts with the seat of the plan's step-2 or step-4 run, or when an
UPDATE moves a run's seat into the same collision.

Fixtures: `same-seat-review.sql` — step 2 then step 4, same seat; the check is red if the
insert succeeds. `same-seat-senior.sql` — step 4 then step 5, same seat.
`update-into-collision.sql` — an UPDATE that reassigns seat.

## fixture-per-rail — ADR 0001, ADR 0005

Reads `rails/*/` and each rail's `tests/`, and runs each rail against its own fixtures.

Red when a rail has no fixture, when no fixture of a rail fails against it, or when a fixture
recorded as failing now passes. The third is the mechgreen class: the rail went green because
the layer under it changed, not because the defect went away.

Fixtures: `no-fixture/` — a rail directory with an empty `tests/`. `always-pass/` — a rail
returning pass against its own failing fixture.
