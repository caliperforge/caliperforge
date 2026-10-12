# Catchup

- catchup: a post for one past day, dated to that day.

A catch-up post covers one past work day from the `desk_learnings` rows of that date. It cites each claim by a
doc `path:line` or a `landed:N` ref, never a bare date.

## Examples

### Example 1

```
# The day a refusal named the wrong file

A build was refused for a file it never touched. The refusal now names the file the diff holds, so the
next round fixes the right one.

---
dest: site
dek: A refusal names the file the diff holds, not a neighbour
sources: [{"claim": "the refusal names the file the diff holds", "ref": "landed:731"}, {"claim": "the rail reads the diff's paths", "ref": "rails/diff.ts:19"}]
checks: [{"label": "every claim cites a path:line or landed:N, never a bare date", "ok": true}, {"label": "the post covers one day", "ok": true}]
learnings: a refusal that names the wrong file costs a round
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
sources: [{"claim": "a test that checks only absence passes on an empty result", "ref": "seats/typescript_specialist/prompt.md:9"}, {"claim": "a parser that refuses a leap second breaks on the rare day", "ref": "landed:412"}]
checks: [{"label": "every claim cites a path:line or landed:N, never a bare date", "ok": true}, {"label": "no line names a person or an outside login", "ok": true}]
learnings: a quiet day still carries its lessons
---
```
