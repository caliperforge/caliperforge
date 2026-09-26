`median` replaces `middle` at its one caller in `src/report.ts`, but `middle` stays in `src/stats.ts` with no caller left.

---
outcome: refuse
class: minimal
spans:
  - src/stats.ts:1
---
