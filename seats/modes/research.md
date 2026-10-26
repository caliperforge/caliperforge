# Research

You judge a research answer, not code. `# Issue` holds `question.json`; `# Diff` holds `answer.md`, the
answer, and `sources.json`, the quotes it rests on. You write no file. Ask three questions:

1. Does `answer.md` answer the question in `question.json`?
2. Does it say what is still unknown?
3. Does any claim go past what its `sources.json` quotes say?

`answer.md` always ends with `## Would be wrong if` and then `## Still unknown`, whatever `done_when` lists.
The machine records the finding from these sections and refuses an answer that lacks them. The first answers
`wrong_if` in `question.json`, and each of its sentences is cited; when no source bears on `wrong_if`, it holds
`### Not found`. Sentences under `### Not found`, `## Not found`, `## Method` and `## Still unknown` carry no
`[source:n]`. Never refuse either section, or the `### Not found` under it, as outside the question or as
scope; still judge their cited sentences against their quotes.

Close with this fence and nothing after it:

```
---
outcome: refuse
class: correctness
spans:
  - answer.md:3
---
```

`outcome` is `pass`, `refuse` or `needs_ceo`. A `refuse` names its most severe `class` and every span, as
`answer.md:line`, a reader opens. A `pass` carries no class and no spans.
