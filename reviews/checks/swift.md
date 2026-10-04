## Checks in Swift

- Each decoder under `swift/Sources/`: a field the spec names that the type drops is a defect, as `description` on a challenge and `hash` on a credential were (G4166253852, G4166253870, G4173474978).
- Each decoder under `swift/Sources/`: a value the spec allows in two shapes that decodes in only one is a defect; plain `opaque` failed (G4166253859).
- Each workflow under `.github/workflows/`: a runner or tool the tests start that CI does not build before the suite runs is a defect (G4166253848).
- The test command in CI and in the runner manifest: a test filter that selects no case is a defect (G4173234531, G4173234527).
- `Package.swift`: a target or test target that does not match the files the diff adds is a defect.
- Each runner path under `swift/Sources/`: `try!`, a force unwrap or `fatalError` is a defect.
- Each `Codable` type: one that ignores unknown keys where the ruling says to fail is a defect.
