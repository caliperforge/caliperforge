# A seat that briefs before any build

**What:** a read-only seat turns the ask into the brief every later step reads.
**Why:** a ticket written without the code open is read two ways by two reviewers.
**When it ends:** a build starts from a brief written against today's code.

## Answer from the director (2026-10-28)

The seat writes no file.

applies to: D1
instruction: save the reply as issue.md and write nothing else
files: sequencer/seat.ts
resume at: step 1
verify: npm run test -- sequencer/tests/seat.test.ts

## Answer from the director (2026-10-28)

The shape check stands.

applies to: D2
instruction: refuse a reply that fails the shape check
files: sequencer/brief.ts
resume at: step 1
verify: npm run test -- sequencer/tests/brief.test.ts
