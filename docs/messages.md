# Messages

Every message one seat sends another, with the template that shapes it and the checker that refuses it.

| message | from → to | template | checker | status |
|---|---|---|---|---|
| brief | brief_writer → builder, reviewers | `sequencer/brief.ts:29` `TEMPLATE`, `seats/brief_writer/prompt.md` | `sequencer/brief.ts:197` `shape()` | exists |
| handback | builder → step 3 | `seats/modes/build.md:14-22` | `rails/completion-audit/index.ts:28` `audit()`, `:40` `undone()` | exists |
| pre_review verdict | step-3 rails → builder | `store/verdict.ts:4` `Verdict`, text by `sequencer/refusal.ts:77` `refusalText()` | none: machine-written, never parsed | none |
| review verdict (code_quality, design, blind) | reviewer → builder | `seats/modes/review.md:8-15`, `reviews/<name>/spec.md` | `reviews/verdict.ts:57` `read()` | partial: a refuse needs `class` and `spans` only; no `rule`, `required change`, `verify` |
| senior verdict | senior_review → builder | `reviews/senior_review/spec.md:57-79` | `reviews/verdict.ts:57` `read()` | partial: same as review |
| director ruling (`rule`) | director → brief writer or builder | `seats/director/prompt.md:99-108` | `sequencer/director.ts:245` `read()` (`Said`, `:41`); `sequencer/rule.ts:34` `stray()` | partial: `answer` is free prose; no `applies to`, `instruction`, `files`, `resume at`, `verify` |
| waive | director → builder | `seats/director/prompt.md:45-46`, `:99-108` | `sequencer/director.ts:245` `read()`; design line by `sequencer/design.ts:76` `waive()` | partial: only a non-empty `why` |
| fixer note | fixer → kernel, next seat | `seats/fixer/prompt.md:54-64` | `sequencer/fixer.ts:268` `read()` (`Fix`, `:56`) | exists |
| COO hold | COO → plan | `cf hold` in `cli/cf-plans.ts:167-184` | `store/ask.ts:2` `decision()` with `--by ceo` only | partial: `--why` free text for the coo |
| COO return | COO → plan | `cf return` in `cli/cf-return.ts:8-22` | `cli/cf-return.ts:24` `resumed()`: `--at` needs `--why` | partial: `--why` free text |
