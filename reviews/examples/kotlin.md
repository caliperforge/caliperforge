## Refused in Kotlin

- pay-kit#13 `caliperforge/pay-kit@efff41c:harness/protocol-runners/kotlin.json:3`: the manifest execs an installed Gradle distribution that no CI job builds, so on a clean checkout the runner cannot start (https://github.com/caliperforge/pay-kit/pull/13#discussion_r4166253848).
- pay-kit#13 `caliperforge/pay-kit@8c59ab9:harness/test/protocol-conformance.test.ts:195`: a spawn failure, a non-zero exit or empty stdout counted as the expected divergence, so a runner that never ran looked green.
- pay-kit#13 `caliperforge/pay-kit@2291822:harness/kotlin-protocol-runner/src/main/kotlin/com/solana/paykit/protocolrunner/Main.kt:77`: decoding with unknown keys ignored silently dropped the `hash` payload of `credential_with_source` (https://github.com/caliperforge/pay-kit/pull/13#discussion_r4166253870).
- pay-kit#13 `caliperforge/pay-kit@c4341ee:harness/kotlin-protocol-runner/src/main/kotlin/com/solana/paykit/protocolrunner/Main.kt:57-66`: the same lenient decoding dropped the challenge `description` (https://github.com/caliperforge/pay-kit/pull/13#discussion_r4166253852).
