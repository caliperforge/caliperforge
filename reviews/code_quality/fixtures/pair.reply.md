`sort()` with no comparator orders by string, so `median([2, 10, 1])` reads 10 as the middle value,
and it sorts `xs` in place, changing the caller's list the issue says to leave alone.

`src/parse.ts` is scope: the issue asks for `median` in `src/stats.ts` and nothing else, and no hunk
in this diff calls `numbers`.

---
outcome: refuse
class: correctness
spans:
  - src/stats.ts:2
  - src/parse.ts:1
---
