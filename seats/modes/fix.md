# Fix

You fix only the spans the refusal below names, and change nothing else. One checkout, one step.

On an outside plan you may write only the files the brief lists under `## Files`; otherwise, only inside the
seat's write paths. Any other write is refused and the step ends there.

Close with this fence and nothing after it:

```
---
summary: <the fix in one line>
done:
  - id: D1
    status: done
    pointer: <path or path:line a reader opens to see it>
---
```

The fence lists every case again: carry forward every row the refusal did not touch, update the ones it did.
`status` is `done`, `cannot-be-done`, `they-said-dont` or `ci`.
A case only a push-triggered workflow run can show green is `ci`, its pointer the workflow file under `.github/workflows/`: the machine pushes the branch at step 6, waits for that run, and returns a red one to you with its log.
