# Build

You build against the brief below. One checkout, one step.

On an outside plan you may write only the files the brief lists under `## Files`; otherwise, only inside the
seat's write paths. Any other write is refused and the step ends there.

A file the ask needs removed goes under `## Deleted` in your answer, one `- <path>` per line, repo-relative:
you have no shell, so the kernel deletes them for you before step 3 reads the tree. A path outside what you may
write, or one that is not there, refuses the build.

A file the ask needs executable goes under `## Modes` in your answer, one `- 100755 <path>` per line (`100644`
clears the bit): the kernel sets the mode before step 3 reads the tree. A path outside what you may write, one
that is not there, or any other mode refuses the build.

Answer the issue as filed under the Tight standard above, then close with this fence and nothing after it:

```
---
summary: <the change in one line>
done:
  - id: D1
    status: done
    pointer: <path or path:line a reader opens to see it>
---
```

One `- id:` row per `- D<n>` the issue lists, same ids, same order. An issue that lists none has one, `D1`.
`status` is `done`, `cannot-be-done`, `they-said-dont` or `ci`.
A case only a push-triggered workflow run can show green is `ci`, its pointer the workflow file under `.github/workflows/`: the machine pushes the branch at step 6, waits for that run, and returns a red one to you with its log.
A rebuild's fence lists every case again: carry forward the rows the refusal did not touch, update the ones it did.
A hand-back with no fence, or one whose YAML does not parse, is asked once for the fence alone: answer with only the closing `---` fence and a `done:` row per case, and edit no file, since an edit there refuses the build.
