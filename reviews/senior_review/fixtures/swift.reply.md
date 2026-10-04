The diff does what the issue asks and its tests pin it. One point is Swift idiom, not behaviour:
`Sources/Stats/Median.swift:3` unwraps with `if let` and an `else` return where `guard let` reads flatter.

---
outcome: pass
notes:
  - file: Sources/Stats/Median.swift
    line: 3
    old: "if let first = xs.first {"
    new: "guard let first = xs.first else { return nil }"
    why: an early exit reads as guard let in Swift
    kind: language
---
