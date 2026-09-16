# ADR 0007 — Dependencies

Status: accepted · 2026-09-16 · BUILD_MAP rev 6, Stack and Decisions

The list is closed. S2 adds a dependency only by adding a line here in the same PR, and
review decides on the line, not on a count. Versions are pinned by S2 against the registry;
the lockfile is the record. No line below is a version claim.

- `typescript` — `tsc --noEmit` under `strict`; the one language.
- `@types/node` — Node LTS surface typed under `strict`.
- `@anthropic-ai/claude-agent-sdk` — the first provider behind the provider interface.
- `better-sqlite3` — synchronous SQLite driver for plain `.sql` migrations; no ORM.
- `@types/better-sqlite3` — `better-sqlite3` ships no types.
- `zod` — validation at every boundary: rules load, manifests, provider responses, CLI input.
- `yaml` — parses `rules/roster.yaml` and `rules/rails.yaml` before zod; Node parses no YAML.
- `vitest` — test runner; fixtures are tests.
- `eslint` — the strictest-linter ceiling in the rail manifest, no exceptions file.
- `typescript-eslint` — type-aware rules; `eslint` alone cannot read the types.
- one CLI lib — the `cf` command surface. Exactly one; S2 names it here at pin time.
