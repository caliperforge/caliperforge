## Refused in Ruby

- pay-kit#340 `solana-foundation/pay-kit@b2638e1:ruby/lib/pay_kit/config.rb:271`: an empty `PAY_KIT_RPC_URL` overrode the network default with `""`, unlike the Python SDK it mirrors (https://github.com/solana-foundation/pay-kit/pull/340#discussion_r4095737040).
- pay-kit#340 `solana-foundation/pay-kit@b2638e1:ruby/lib/pay_kit/config.rb:277`: a zero or negative `PAY_KIT_MPP_EXPIRES_IN` was accepted, issuing already-expired challenges, unlike the Python SDK it mirrors (https://github.com/solana-foundation/pay-kit/pull/340#discussion_r4095737053).
- pay-kit#340 `solana-foundation/pay-kit@b2638e1:ruby/lib/pay_kit/config.rb:308`: `yes`/`no`/`on`/`off` for `PAY_KIT_PREFLIGHT` raised at boot, unlike the Python SDK it mirrors (https://github.com/solana-foundation/pay-kit/pull/340#discussion_r4095737067).
- pay-kit#340 `solana-foundation/pay-kit@b2638e1:ruby/lib/pay_kit/config.rb:268`: lowercase `pay_kit_*` variables were silently ignored, unlike the Python SDK it mirrors (https://github.com/solana-foundation/pay-kit/pull/340#discussion_r4095737071).
