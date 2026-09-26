The first verdict passed a port that breaks three rules the brief lists under `## Must not break`, and no
brief line says why it differs from `python/src/solana_pay_kit/config.py`:

- yes/no/on/off booleans: `ruby/lib/pay_kit/config.rb:14` accepts only `true` and `false` and raises on the rest.
- empty RPC URL as unset: `ruby/lib/pay_kit/config.rb:27` strips an empty `PAY_KIT_RPC_URL` to `""` and returns it as set.
- non-positive expiry rejected: `ruby/lib/pay_kit/config.rb:39` takes `0` or `-5` as an expiry.

---
outcome: refuse
class: correctness
spans:
  - ruby/lib/pay_kit/config.rb:14
  - ruby/lib/pay_kit/config.rb:27
  - ruby/lib/pay_kit/config.rb:39
---
