# The Now screen shows how long each plan has waited

**What:** each row on the Now screen carries the minutes its plan has waited at its step.
**Why:** a plan stuck at review looks the same as one that just arrived.
**When it ends:** a plan that entered review at 09:00 reads `waited 30 min` at 09:30 Guatemala time.

## Approach

`QueueTimesService` reads each plan's step entry time; `NowRowModel` turns it into the words on the row.
Estimate: 30 lines

## Settled facts

- `plans.entered_at` is an ISO-8601 UTC text column, read in `schema/0001-plans.sql`

## Cases

- D1 a plan that entered its step 30 minutes ago reads `waited 30 min`
- D2 a plan with no `entered_at` is refused a wait and reads no minutes

## Must not break

- the Now screen keeps its rows in step order
- Lines the job does not need stay as they are; a comment that states a changed value changes that value and no other word.

## Files

- Atelier/Services/QueueTimesService.swift
- Atelier/Models/NowRowModel.swift

## Files to read

- Atelier/Services/CFSQLite.swift — the read-only store the service queries

## Who else reads what this changes

- Atelier/Views/NowView.swift — shows the row's text, unaffected: it takes plain values

## Tests

- AtelierTests/QueueTimesServiceTests.swift — D1, D2: the minutes each plan has waited
- AtelierTests/NowRowModelTests.swift — D1: the words a row shows for a wait

## Out of scope

- a sort by wait

## Standing

- no shell, and no report of what it did not see
- no forced push
- no person's name or address in code
