## Refused in Swift

- pay-kit#15 `caliperforge/pay-kit@1f02e55:swift/Sources/mpp-protocol-runner/main.swift:74`: `challenge.parse` dropped `description` (https://github.com/caliperforge/pay-kit/pull/15#discussion_r4173474978).
- pay-kit#15 `caliperforge/pay-kit@1f02e55:swift/Sources/mpp-protocol-runner/main.swift:97`: `credential.format` required `transaction` for `type: "transaction"`, so the canonical `basic_credential` vector could not be formatted (https://github.com/caliperforge/pay-kit/pull/15#discussion_r4173474983).

## Raised and withdrawn in Swift

- pay-kit#322 `solana-foundation/pay-kit@c35533e:swift/Sources/SolanaPayKit/Protocols/Mpp/Core/Models.swift:125`: a review asked to allow leap seconds only in June and December; RFC 3339 §5.7 and Appendix D do not restrict them, the UTC month-end check matches the Rust reference, and the finding was withdrawn (https://github.com/solana-foundation/pay-kit/pull/322#discussion_r4035505691).
