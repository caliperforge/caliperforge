The first verdict passed the shape and missed a field. The issue's spec says `Summary` carries `median`;
`src/stats.ts:2` builds a `Summary` without it, so every caller reads `median` as `undefined`.

---
outcome: refuse
class: correctness
spans:
  - src/stats.ts:2
---
