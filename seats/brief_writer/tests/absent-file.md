# A seat that briefs before any build

**What:** a read-only seat turns the ask into the brief every later step reads.
**Why:** a ticket written without the code open is read two ways by two reviewers.
**When it ends:** a build starts from a brief written against today's code.

## Approach

Step 1 fires the seat in the plan's checkout; the machine saves its reply as `issue.md`.

## Cases

- D1 the seat fires once at step 1 and its reply is saved as the brief
- D2 a reply that fails the shape check is refused and no brief is written

## Must not break

- the rows keep the `- D<n>` shape the rails and the pull request body read

## Files

- sequencer/nowhere.ts

## Out of scope

- posting the brief back to the issue as a comment
