`sort()` with no comparator orders by string, so `median([2, 10, 1])` reads 10 as the middle value,
and it sorts `xs` in place, changing the caller's list the issue says to leave alone.

---
outcome: refuse
class: correctness
spans:
  - src/stats.ts:2
---
