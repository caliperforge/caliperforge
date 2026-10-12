# Catchup

- catchup: a post for one past day, dated to that day.

A catch-up post covers one past work day from the `desk_learnings` rows of that date. It cites each claim by a
`learnings:<date>` the packet holds or a doc `<path>:<line>` in the root, and by nothing else.

The reply holds one post per date in the packet's `learnings`, in that order. Each post closes with its own
fence, and that fence carries `date: YYYY-MM-DD`.

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
checks: [{"label": "every claim cites a learnings:<date> or a path:line", "ok": true}, {"label": "the post covers one day", "ok": true}]
learnings: a refusal that names the wrong file costs a round
date: 2026-09-26
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
date: 2026-09-27
---
```
