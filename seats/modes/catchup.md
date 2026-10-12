# Catchup

- catchup: a post for one theme over a run of past days, dated to that run.

A catch-up post covers a run of past work days from the `desk_learnings` rows of those dates. It cites each claim by a
`learnings:<date>` or a `landed:N` the packet holds (N being a `landed` entry's `plan`), or a doc `<path>:<line>` in
the root, and by nothing else.

Group the dates in the packet's `learnings` by theme, about one post per theme or fortnight. Each post covers a
run of dates in order, and every packet date sits in exactly one post. Each post closes with its own fence, and
that fence carries `from: YYYY-MM-DD` and `to: YYYY-MM-DD`.

## Examples

### Example 1

```
# The day a refusal named the wrong file

A build was refused for a file it never touched. The refusal now names the file the diff holds, so the
next round fixes the right one.

---
dest: site
dek: A refusal names the file the diff holds, not a neighbour
sources: [{"claim": "the refusal names the file the diff holds", "ref": "learnings:2026-09-26"}, {"claim": "the rail reads the diff's paths", "ref": "rails/diff.ts:19"}]
checks: [{"label": "every claim cites a learnings:<date> or a path:line", "ok": true}, {"label": "the post covers one theme", "ok": true}]
learnings: a refusal that names the wrong file costs a round
from: 2026-09-26
to: 2026-09-26
---
```

### Example 2

```
# Two learnings from a quiet day

Nothing landed, and two lessons were kept. A test that only checks a field is absent passes on an empty
result. A parser that refuses a leap second breaks on the rare day.

---
dest: site
dek: Two lessons kept on a day nothing landed
sources: [{"claim": "a test that checks only absence passes on an empty result", "ref": "seats/typescript_specialist/prompt.md:9"}, {"claim": "a parser that refuses a leap second breaks on the rare day", "ref": "learnings:2026-09-27"}]
checks: [{"label": "every claim cites a learnings:<date> or a path:line", "ok": true}, {"label": "no line names a person or an outside login", "ok": true}]
learnings: a quiet day still carries its lessons
from: 2026-09-27
to: 2026-10-02
---
```
