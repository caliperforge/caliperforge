The first verdict names the comparator and stops. `src/stats.ts:4` returns `0` for an empty list
rather than refusing it, so a caller reads a median where the issue guarantees none.

---
outcome: refuse
class: correctness
spans:
  - src/stats.ts:4
---
