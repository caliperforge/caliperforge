## Checks in Kotlin

- Each decoder under `src/main/kotlin/`: a field the spec names that the type drops is a defect, as `description` on a challenge and `hash` on a credential were (G4166253852, G4166253870, G4173474978).
- Each decoder under `src/main/kotlin/`: a value the spec allows in two shapes that decodes in only one is a defect; plain `opaque` failed (G4166253859).
- Each workflow under `.github/workflows/`: a runner or tool the tests start that CI does not build before the suite runs is a defect (G4166253848).
- The test command in CI and in the runner manifest: a test filter that selects no case is a defect (G4173234531, G4173234527).
- The runner manifest and `build.gradle.kts`: a Gradle task the manifest runs that does not exist, or is built per request rather than once, is a defect (G4166397023).
- Each `.kt` file the diff touches: `!!` is a defect.
- Each `runCatching` the diff adds: one that swallows the error the test expects is a defect.
