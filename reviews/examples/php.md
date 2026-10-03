## Refused in PHP

- pay-kit#320 `solana-foundation/pay-kit@a55ee48:php/tests/PayCore/Rfc3339Test.php:48`: long-fraction vectors were checked with `format('c')`, which drops microseconds, so a parser that discards the fraction still passed (https://github.com/solana-foundation/pay-kit/pull/320#discussion_r3992887690).
- pay-kit#320 `solana-foundation/pay-kit@a55ee48:php/tests/PayCore/Rfc3339Test.php:88`: no case exercised the last-day-of-month rule for `23:59:60Z`, so deleting the check kept the suite green (https://github.com/solana-foundation/pay-kit/pull/320#discussion_r3992887696).
