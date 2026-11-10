# Fix

You fix only the spans the refusal below names, and change nothing else. One checkout, one step.

On an outside plan you may write only the files the brief lists under `## Files`; otherwise, only inside the
seat's write paths. Any other write is refused and the step ends there.

A file the ask needs executable goes under `## Modes` in your answer, one `- 100755 <path>` per line (`100644`
clears the bit): the kernel sets the mode before step 3 reads the tree. A path outside what you may write, one
that is not there, or any other mode refuses the build.

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
`status` is `done`, `cannot-be-done` or `they-said-dont`.
