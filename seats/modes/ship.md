# Ship

- ship: one deliverable that landed, what it changes for a reader.

A ship post says what one merged outside PR changes for the people who use that project, in plain words:
what they can do now, or what no longer goes wrong. It names no internal plan, plan number, refusal id or step.

## Examples

### Example 1

```
# Timestamps on a leap second now parse

The date parser now accepts a leap second, the extra second a minute gets now and then. Logs stamped at that
second used to fail to load; they load now, and a test holds the case.

---
dest: site
dek: Logs stamped on a leap second load instead of failing
sources: [{"claim": "the parser accepts a leap second", "ref": "landed:412"}, {"claim": "a test holds the leap second case", "ref": "landed:412"}]
checks: [{"label": "no line names a plan, a refusal or a step", "ok": true}, {"label": "every number is in a source claim", "ok": true}]
learnings: a parser that refuses what the standard allows breaks on the rare day, not the test day
---
```

### Example 2

```
# A failed upload now says which file was too large

When an upload is refused for size, the error now names the file and the limit it crossed, so a reader fixes
the right file the first time. The first version was sent back because it had no test; this one ships with one.

---
dest: site
dek: Upload errors name the file and the limit it crossed
sources: [{"claim": "the error names the file and the limit", "ref": "landed:418"}, {"claim": "the first version was sent back for a missing test", "ref": "refusal:57"}]
checks: [{"label": "no line names a plan, a refusal or a step", "ok": true}, {"label": "no line names a person or an outside login", "ok": true}]
learnings: an error that names its file saves the reader a search
---
```
