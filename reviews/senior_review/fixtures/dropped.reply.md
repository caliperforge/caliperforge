The first verdict passed the sort and missed the input. The issue says `median` must not change the
list the caller passed; `src/stats.ts:2` sorts `xs` in place, so the caller's list comes back reordered.

---
outcome: refuse
class: correctness
spans:
  - src/stats.ts:2
---
