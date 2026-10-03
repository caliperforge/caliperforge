## Refused in Go

- pay-kit#317 `solana-foundation/pay-kit@a58c78e:go/protocols/mpp/wire/challenge_test.go:56`: `now` was fixed at 1900, so the leap-second cases proved only that parsing succeeded, not the mapping to the last nanosecond of `:59` (https://github.com/solana-foundation/pay-kit/pull/317#discussion_r3982265139).
